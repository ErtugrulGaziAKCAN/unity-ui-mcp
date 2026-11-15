using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;

namespace DesignUi.Editor
{
    public sealed class CompileResult
    {
        public bool Ok;
        /// <summary>Files whose content changed and were written (and imported when they are inside the project).</summary>
        public IReadOnlyList<string> Written = new string[0];
        /// <summary>Generated files that were edited by hand (or are in the way without being generated); nothing was written.</summary>
        public IReadOnlyList<string> ManualEdits = new string[0];
        public IReadOnlyList<string> Errors = new string[0];
        /// <summary>
        /// Generated screen folders next to this one whose screen has no folder under the profile's design root any more.
        /// Reported only; nothing is deleted.
        /// </summary>
        public IReadOnlyList<string> Orphans = new string[0];
        /// <summary>
        /// Shared assets (<c>_assets/</c>) that no compiled screen uses any more, by file name. Reported only; nothing is deleted.
        /// </summary>
        public IReadOnlyList<string> StaleAssets = new string[0];
        /// <summary>The compiled screen's id, once the IR was read; else null.</summary>
        public string Screen;
        /// <summary>The screen's generated folder (<c>&lt;outputFolder&gt;/&lt;Screen&gt;</c>), once the IR was read; else null.</summary>
        public string Folder;
        /// <summary>Remarks for the log (for example characters no font of a locale has); never a failure.</summary>
        public IReadOnlyList<string> Notes = new string[0];
        /// <summary>What the import wrote into the screen's String Tables, when the profile localizes; else null.</summary>
        public LocalizationReport Localization;
    }

    /// <summary>
    /// Replaceable steps of the compile, for the asset importer, the font twins and the generated view class. Null keeps
    /// the built-in behaviour.
    /// </summary>
    internal sealed class CompileHooks
    {
        /// <summary>Imports an IR asset and returns its path for url(); default: copy it to <c>&lt;screen&gt;/assets/</c>.</summary>
        public Func<IrAsset, string> AssetPath;
        /// <summary>USS value of <c>-unity-font-definition</c> for a family; default: keep the <c>var(--font-…)</c> placeholder.</summary>
        public Func<string, string> FontDefinition;
        /// <summary>
        /// Text of <c>&lt;Screen&gt;View.g.cs</c>; default: <see cref="ViewCodeWriter"/> in the profile's namespace. A step that
        /// returns null writes no view and keeps an existing one.
        /// </summary>
        public Func<CompiledScreen, string> ViewCode;
        /// <summary>Which TMP font renders each locale; default: <see cref="FontMap.ResolverFor"/> (the profile's font resolver, else its mapping over TMP Settings).</summary>
        public IFontResolver Fonts;
        /// <summary>The String Tables a localized screen's texts go to; default: <see cref="DesignStringTables.Current"/>.</summary>
        public IDesignStringTables Tables;
    }

    /// <summary>
    /// Compiles an export folder (<c>screen.ir.json</c>, assets, optional <c>text-styles.json</c>) into
    /// <c>&lt;outputFolder&gt;/&lt;Screen&gt;/</c>: <c>&lt;Screen&gt;.uxml</c>, <c>&lt;Screen&gt;.uss</c>, the repeats' item
    /// templates, the generated view class (<c>&lt;Screen&gt;View.g.cs</c>, <see cref="ViewCodeWriter"/>), assets,
    /// <c>.gitattributes</c> and <c>.design-ui.json</c>, plus the shared
    /// <c>&lt;outputFolder&gt;/DesignTokens.uss</c> (spec 8) and <c>&lt;outputFolder&gt;/DesignFonts.uss</c>: the font
    /// variables per locale (<see cref="FontMap"/>), which the screen's style sheet imports; the screen root carries the
    /// reference locale's class. A screen that names a font family fails when a locale has no font or the family is not
    /// a font of the locales (spec 18). The locales' UI Toolkit font twins (with a variant per kit line box and per line
    /// box scaled by each of the profile's text-size steps) and <c>DesignFonts.asset</c>, which the screen root references,
    /// are created or updated after the manual-edit guard, before the write batch (asset-specific saves).
    /// Incremental (spec 14): every output is compared with the file on disk (text with CRLF read as LF) and written only
    /// when it differs; folder creation, writes, deletes and the imports of the written project paths run in one
    /// asset-editing batch (no refresh, no save). A generated file whose content matches neither its recorded hash nor
    /// the new output, or a file in the way that was never generated, stops the compile unless
    /// <c>discardManualEdits</c> is set (spec 18).
    /// </summary>
    public static class ScreenCompiler
    {
        public const string IrFileName = "screen.ir.json";
        public const string ManifestFileName = ".design-ui.json";
        public const string SharedManifestFileName = ".design-ui-shared.json";
        public const string TokensFileName = "DesignTokens.uss";
        public const string GitAttributesFileName = ".gitattributes";

        /// <summary>
        /// Keeps generated text LF in git on every platform, so the recorded hashes match a fresh checkout; binary assets
        /// are never converted.
        /// </summary>
        public const string GitAttributes =
            "# auto-generated by com.ertugrulgaziakcan.design-ui: generated text keeps LF line endings (its recorded hashes assume LF)\n" +
            "* text=auto eol=lf\n" +
            "*.uxml text eol=lf\n" +
            "*.uss text eol=lf\n" +
            "*.cs text eol=lf\n" +
            "*.json text eol=lf\n" +
            "*.svg text eol=lf\n" +
            "*.png binary\n" +
            "*.jpg binary\n" +
            "*.jpeg binary\n";

        public static CompileResult Compile(string exportDir, DesignUiProfile profile, bool discardManualEdits = false) =>
            Compile(exportDir, profile, discardManualEdits, null);

        /// <summary>Every string the screen shows, in every locale the IR carries: texts and attribute texts.</summary>
        internal static IEnumerable<string> ScreenStrings(IrNode node)
        {
            if (node == null) yield break;
            foreach (var t in new[] { node.Text }.Concat((node.AttrTexts ?? new Dictionary<string, IrText>()).Values))
            {
                if (t == null) continue;
                yield return t.Tr;
                yield return t.En;
            }
            if (node.Field != null && node.Field.Password) yield return ScreenBuilder.PasswordMask.ToString(); // drawn instead of the value
            foreach (var c in node.Children ?? new IrNode[0])
                foreach (var s in ScreenStrings(c)) yield return s;
        }

        internal static CompileResult Compile(string exportDir, DesignUiProfile profile, bool discardManualEdits, CompileHooks hooks)
        {
            if (profile == null) return Fail("no DesignUiProfile");
            if (string.IsNullOrEmpty(profile.outputFolder)) return Fail("the profile has no output folder");
            if (string.IsNullOrEmpty(exportDir)) return Fail("no export folder");

            // ---- build every output in memory; nothing is written before this succeeds -----------------------
            var irPath = Path.Combine(exportDir, IrFileName);
            if (!File.Exists(irPath)) return Fail("no " + IrFileName + " in '" + exportDir + "'");

            var outFolder = profile.outputFolder.Replace('\\', '/').TrimEnd('/');
            var outputs = new SortedDictionary<string, byte[]>(StringComparer.Ordinal);
            IrScreen ir;
            CompiledScreen compiled;
            AssetPlan plan;
            FontMap.FontsPlan fonts;
            IFontResolver resolver;
            string screenDir, folderName;
            List<FontMap.NeededFace> screenFaces;
            var faceNotes = new List<string>();
            IDesignStringTables tables = null;
            StringTableRequest tableRequest = null;
            try
            {
                ir = IrReader.Read(irPath);
                CheckNestedActions(ir.Root, null);
                folderName = ScreenBuilder.Pascal(ir.Screen, "screen id");
                screenDir = outFolder + "/" + folderName;

                var searched = new List<string> { Path.Combine(exportDir, KitTextStyles.FileName) };
                if (!string.IsNullOrEmpty(profile.kitDir)) searched.Add(Path.Combine(profile.kitDir, KitTextStyles.FileName));
                var stylesPath = KitTextStyles.FindTable(exportDir, profile.kitDir);
                if (stylesPath == null && ScreenBuilder.UsesTextStyles(ir.Root))
                    return Fail("the screen uses kit text styles but no " + KitTextStyles.FileName + " was found (searched: " + string.Join(", ", searched) +
                                "); export it with the design or set the profile's kit folder");
                var textStyles = stylesPath != null ? KitTextStyles.Load(stylesPath) : null;
                var lineBoxes = stylesPath != null ? KitTextStyles.LoadLineBoxes(stylesPath) : null;
                var kitBoxes = stylesPath != null ? KitTextStyles.LineBoxesOf(stylesPath) : new FontTwinGenerator.LineBox[0];

                // default asset step: the build only plans the assets (paths, checks); they are copied and imported in the write batch
                plan = hooks?.AssetPath == null ? new AssetPlan(exportDir, outFolder, profile) : null;
                var assetPath = hooks?.AssetPath ?? plan.Add;
                var options = new ScreenBuildOptions
                {
                    TextStyleSizes = textStyles,
                    TextStyleLineBoxes = lineBoxes,
                    LineBoxes = kitBoxes,
                    TextSizes = profile.textSizes,
                    RtlAlignment = (profile.localeRules ?? new DesignUi.DesignLocaleRules()).rtlAlignment,
                    Viewports = (profile.viewports ?? new UnityEngine.Vector2Int[0])
                        .Select(v => (v, BoxesWriter.Scale(v, profile.referenceResolution, profile.screenMatch))).ToList(),
                    ExactScales = ExactViewportScales(profile),
                    Translations = Translations(profile, ir.Screen, hooks?.Tables ?? DesignStringTables.Current),
                    // the screen root's own reference to the locales' twins (DesignFonts.asset next to DesignFonts.uss, project only)
                    FontSet = FontSetFolder(outFolder) != null ? "../" + DesignUi.DesignFontSet.FileName : null,
                };
                compiled = ScreenBuilder.Build(ir, options, assetPath, hooks?.FontDefinition);

                // localized texts bind String Table entries (no static copy in the UXML); the tables are checked now and
                // written after the manual-edit guard
                if (profile.localization != null && profile.localization.enabled)
                {
                    tables = hooks?.Tables ?? DesignStringTables.Current;
                    if (tables == null)
                        return Fail("the profile localizes the screens' texts, but Unity Localization (com.unity.localization 1.5 or newer) is not installed; " +
                                    "install it, or turn localization off in the DesignUiProfile");
                    tableRequest = ScreenLocalization.Bind(compiled, profile);
                    var tableErrors = tables.Check(tableRequest);
                    if (tableErrors.Count > 0) return new CompileResult { Ok = false, Errors = tableErrors.ToArray() };
                }

                // fonts per locale: element rules keep var(--font-…); DesignFonts.uss defines them per .locale-<code>; every kit
                // line box has a twin variant, and so has each of them scaled by a text-size step
                resolver = hooks?.Fonts ?? FontMap.ResolverFor(profile);
                fonts = FontMap.Plan(profile, resolver);
                fonts.LineBoxes = ScaledLineBoxes(kitBoxes, profile.textSizes);
                // twins for the faces the kit's text styles, the other compiled screens and this screen use, not every face of a
                // family; a face this screen needs that the reference locale's font has not is an error (never synthesized)
                fonts.Faces = FontMap.ProfileFaces(profile, stylesPath, screenDir);
                screenFaces = FontMap.ScreenFaces(compiled);
                foreach (var f in screenFaces) fonts.Faces.Add(f.Face);
                var fontErrors = fonts.Errors.Concat(FontMap.ScreenErrors(fonts, compiled)).ToList();
                if (fontErrors.Count == 0) FontMap.FaceProblems(fonts, screenFaces, fontErrors, faceNotes);
                if (fontErrors.Count > 0) return new CompileResult { Ok = false, Errors = fontErrors };
                compiled.Root.Classes.Add(FontMap.LocaleClass(fonts.ReferenceLocale));

                Add(outputs, folderName + ".uxml", UxmlWriter.Write(compiled, folderName + ".uss"));
                Add(outputs, folderName + ".uss", UssWriter.Write(compiled, new[] { "../" + FontMap.FileName }));
                foreach (var repeat in compiled.Repeats)
                    if (repeat.TemplateFile != null) Add(outputs, repeat.TemplateFile, UxmlWriter.WriteItemTemplate(repeat));
                var view = hooks?.ViewCode != null ? hooks.ViewCode(compiled) : ViewCodeWriter.Write(compiled, profile.generatedNamespace, folderName + "View");
                if (view != null)
                {
                    // a view under an assembly definition that lacks DesignUi.Runtime would break that whole assembly's compile
                    var assemblyError = ViewAssembly.Check(GeneratedManifest.Combine(screenDir, ViewFileName(folderName)));
                    if (assemblyError != null) return Fail(assemblyError);
                    Add(outputs, ViewFileName(folderName), view);
                }
                Add(outputs, GitAttributesFileName, GitAttributes);
            }
            catch (Exception e) when (e is IrFormatException || e is UnsupportedStyleException || e is FontSetupException || e is IOException || e is UnauthorizedAccessException)
            {
                return Fail(e.Message);
            }

            // ---- ownership and the manual-edit guard -----------------------------------------------------------
            GeneratedManifest manifest, shared;
            try
            {
                manifest = GeneratedManifest.Load(GeneratedManifest.Combine(screenDir, ManifestFileName));
                shared = GeneratedManifest.Load(GeneratedManifest.Combine(outFolder, SharedManifestFileName));
            }
            catch (InvalidDataException e)
            {
                return Fail(e.Message + " (delete it to regenerate every file)");
            }
            var owner = manifest?.screen;
            if (owner == null && shared?.screens != null)
                owner = shared.screens.FirstOrDefault(kv => string.Equals(kv.Key, folderName, StringComparison.OrdinalIgnoreCase)).Value;
            if (owner != null && owner != ir.Screen)
                return Fail("output folder '" + screenDir + "' belongs to screen '" + owner + "'; screen ids '" + owner + "' and '" + ir.Screen +
                            "' give the same folder name. Rename one of the screens.");

            var tokens = new SortedDictionary<string, string>(StringComparer.Ordinal);
            if (shared?.tokens != null) foreach (var kv in shared.tokens) tokens[kv.Key] = kv.Value;
            var sharedOutputs = new SortedDictionary<string, byte[]>(StringComparer.Ordinal);
            try
            {
                foreach (var kv in TokensUssWriter.Normalized(ir.Tokens)) tokens[kv.Key] = kv.Value;
                Add(sharedOutputs, TokensFileName, TokensUssWriter.Write(tokens));
                Add(sharedOutputs, FontMap.FileName, FontMap.WriteUss(fonts));
                Add(sharedOutputs, GitAttributesFileName, GitAttributes);
            }
            catch (Exception e) when (e is IrFormatException || e is FontSetupException) { return Fail(e.Message); }

            // a view this run did not produce stays as it is, with its recorded hash
            var carried = new Dictionary<string, string>(StringComparer.Ordinal);
            var viewFile = ViewFileName(folderName);
            if (manifest != null && !outputs.ContainsKey(viewFile) && manifest.files.TryGetValue(viewFile, out var viewHash)) carried[viewFile] = viewHash;

            var manual = new List<string>();
            manual.AddRange(ManualEdits(screenDir, manifest, outputs));
            manual.AddRange(ManualEdits(outFolder, shared, sharedOutputs));
            if (manual.Count > 0 && !discardManualEdits)
                return new CompileResult
                {
                    Ok = false,
                    ManualEdits = manual,
                    Errors = new[] { "Generated files were edited by hand or are not generated: " + string.Join(", ", manual) +
                                     ". Move the change into the design, or compile with discardManualEdits to overwrite them." },
                };

            // ---- the screen's String Table entries (asset-specific saves of the touched tables) -----------------------
            var notes = new List<string>(compiled.Notes);
            notes.AddRange(faceNotes);
            if (FontMap.FallbackNote(resolver) is string fellBack) notes.Add(fellBack);
            LocalizationReport localization = null;
            IReadOnlyDictionary<string, IReadOnlyList<string>> localeStrings = null;
            if (tableRequest != null)
            {
                try
                {
                    localization = tables.Write(tableRequest);
                    localeStrings = tables.Strings(tableRequest.Collection, tableRequest.Texts.Select(t => t.Key));
                }
                catch (Exception e) when (e is InvalidOperationException || e is ArgumentException || e is IOException || e is UnauthorizedAccessException)
                {
                    return Fail("writing the String Tables of collection '" + tableRequest.Collection + "' failed: " + e.Message);
                }
            }

            // ---- the locales' font twins (assets DesignFonts.uss references), then what changed in one batch ------
            FontTwinGenerator.TwinRun twins;
            string fontSet;
            try
            {
                twins = FontMap.EnsureTwins(fonts);
                var missingGlyphs = FontMap.PrepareTwins(fonts, twins, ScreenStrings(ir.Root));
                if (missingGlyphs.Length > 0) notes.Add("no font of the locales' chains has these characters of the screen: " + missingGlyphs);
                // every locale's table texts of the screen's keys go to the twins that locale renders with
                if (localeStrings != null)
                    foreach (var kv in localeStrings.OrderBy(kv => kv.Key, StringComparer.Ordinal))
                    {
                        var missing = FontMap.PrepareTwins(fonts, twins, kv.Value, FontMap.FontLocaleFor(fonts, kv.Key));
                        if (missing.Length > 0) notes.Add("no font of locale '" + kv.Key + "' has these characters of its translations: " + missing);
                    }
                // the locales' twins for DesignText at runtime, next to DesignFonts.uss (inside the project only); written before
                // the screen's UXML is imported, whose root references it
                var setFolder = FontSetFolder(outFolder);
                if (setFolder != null) EnsureAssetFolder(setFolder);
                fontSet = FontMap.WriteFontSet(fonts, twins, outFolder, profile.textSizes);
            }
            catch (FontSetupException e) { return new CompileResult { Ok = false, Errors = new[] { e.Message }, Localization = localization }; } // the tables stay written

            var writes = new List<KeyValuePair<string, byte[]>>();
            Plan(screenDir, outputs, writes);
            Plan(outFolder, sharedOutputs, writes);
            var stale = manifest == null
                ? new List<string>()
                : manifest.files.Keys.Where(k => !outputs.ContainsKey(k) && !carried.ContainsKey(k)).Select(k => GeneratedManifest.Combine(screenDir, k)).ToList();

            var screens = new SortedDictionary<string, string>(StringComparer.Ordinal);
            if (shared?.screens != null) foreach (var kv in shared.screens) screens[kv.Key] = kv.Value;
            screens[folderName] = ir.Screen;
            var files = outputs.ToDictionary(kv => kv.Key, kv => GeneratedManifest.ContentHash(kv.Key, kv.Value), StringComparer.Ordinal);
            foreach (var kv in carried) files[kv.Key] = kv.Value;
            var stamp = GeneratedScreenRefresh.Stamp; // computed once per script reload
            var newManifest = new GeneratedManifest
            {
                screen = ir.Screen,
                sourceSha256 = ir.Source?.Sha256,
                irSha256 = GeneratedManifest.Sha256Hex(File.ReadAllBytes(irPath)),
                generatorVersion = GeneratorVersion,
                packageStamp = stamp,
                files = files,
                removedElements = compiled.RemovedElements.ToArray(),
                faces = screenFaces.Select(f => f.Face).Distinct().OrderBy(f => f).Select(FontMap.FaceName).ToArray(),
                lineBoxes = (fonts?.LineBoxes ?? new FontTwinGenerator.LineBox[0]).Select(TwinPrune.LineBoxName).ToArray(),
                root = compiled.Root.Name,
                view = viewFile,
                clickable = compiled.AllElements().Where(e => e.Clickable).Select(e => e.Name).ToArray(),
                mirrors = compiled.AllElements().Where(e => e.MirrorElement != null)
                    .Select(e => new MirrorEntry { element = e.MirrorElement, host = e.Name, classes = e.MirrorClasses.Count > 0 ? e.MirrorClasses.ToArray() : null }).ToArray(),
                accessibility = Accessibility(compiled),
                visibility = Visibility(compiled),
                repeats = compiled.Repeats.Select(r => new RepeatEntry
                {
                    name = r.Name, mode = r.Mode, container = r.Container, template = r.TemplateFile, items = r.Items.Select(i => i.Name).ToArray(),
                }).ToArray(),
            };
            var newShared = new GeneratedManifest
            {
                generatorVersion = GeneratorVersion,
                packageStamp = stamp,
                files = sharedOutputs.ToDictionary(kv => kv.Key, kv => GeneratedManifest.ContentHash(kv.Key, kv.Value), StringComparer.Ordinal),
                tokens = new Dictionary<string, string>(tokens, StringComparer.Ordinal),
                screens = new Dictionary<string, string>(screens, StringComparer.Ordinal),
                removedElements = null, clickable = null, mirrors = null, repeats = null, // screen-only fields
            };

            var written = new List<string>();
            var folders = new List<string>();
            string failure = null;
            var batch = writes.Any(w => ProjectPath(w.Key) != null) || stale.Any(p => ProjectPath(p) != null) || plan != null && plan.HasProjectAssets;
            if (batch) AssetDatabase.StartAssetEditing();
            try
            {
                try
                {
                    plan?.Apply(folderName); // shared assets first: the style sheets imported later resolve them
                    foreach (var w in writes)
                    {
                        EnsureFolder(Path.GetDirectoryName(w.Key)?.Replace('\\', '/'), folders);
                        File.WriteAllBytes(w.Key, w.Value);
                        written.Add(w.Key);
                    }
                    foreach (var path in stale) Delete(path);
                    SaveIfChanged(GeneratedManifest.Combine(screenDir, ManifestFileName), newManifest, folders);
                    SaveIfChanged(GeneratedManifest.Combine(outFolder, SharedManifestFileName), newShared, folders);
                }
                catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
                {
                    failure = "writing generated files failed: " + e.Message;
                }
                if (batch) QueueImports(folders, written, GeneratedManifest.Combine(screenDir, folderName + ".uxml"));
            }
            finally
            {
                if (batch) AssetDatabase.StopAssetEditing(); // imports everything queued in this batch
            }
            if (fontSet != null) written.Add(fontSet);
            if (failure != null) return new CompileResult { Ok = false, Written = written, Errors = new[] { failure }, Screen = ir.Screen, Folder = screenDir, Localization = localization };
            // twins of faces, line boxes and fonts nothing uses any more leave the twin folder, once the screen's files (and
            // its DesignFonts.uss) no longer point at them
            if (fonts != null && twins != null)
            {
                var pruned = TwinPrune.Run(profile, fonts, twins);
                if (pruned.Skipped != null) notes.Add(pruned.Skipped);
                if (!FontTwinLink.Supported) notes.Add(FontTwinLink.FallbackNote);
                if (pruned.Deleted.Count > 0)
                    notes.Add("removed " + pruned.Deleted.Count + " font twin" + (pruned.Deleted.Count == 1 ? "" : "s") +
                              " no text style, compiled screen or locale font uses: " + string.Join(", ", pruned.Deleted));
            }
            return new CompileResult
            {
                Ok = true, Written = written, Orphans = FindOrphans(outFolder, folderName, profile.designRoot), StaleAssets = plan?.StaleAssets ?? new string[0],
                Screen = ir.Screen, Folder = screenDir, Notes = notes, Localization = localization,
            };
        }

        public static string ViewFileName(string className) => className + "View.g.cs";

        /// <summary>
        /// An element with <c>data-u-action</c> inside another one (lint U-MRK-012): nested interactive content is invalid HTML
        /// and ambiguous in UI Toolkit, where both would raise their action on one click.
        /// </summary>
        static void CheckNestedActions(IrNode node, IrNode outer)
        {
            if (node == null || node.External) return;
            if (node.Action != null)
            {
                if (outer != null)
                    throw new IrFormatException("'" + node.Id + "' (data-u-action '" + node.Action + "') is inside '" + outer.Id + "' (data-u-action '" + outer.Action +
                                                "'); move the action to one element");
                outer = node;
            }
            foreach (var c in node.Children ?? new IrNode[0]) CheckNestedActions(c, outer);
        }

        /// <summary>The undrawn attribute texts per element name, or null when there are none.</summary>
        static Dictionary<string, Dictionary<string, AccessibilityText>> Accessibility(CompiledScreen compiled)
        {
            var result = new Dictionary<string, Dictionary<string, AccessibilityText>>(StringComparer.Ordinal);
            foreach (var e in compiled.AllElements().Where(x => x.AccessibilityLabels.Count > 0))
                result[e.Name] = e.AccessibilityLabels.ToDictionary(kv => kv.Key, kv => new AccessibilityText { key = kv.Value?.Key, tr = kv.Value?.Tr, en = kv.Value?.En },
                    StringComparer.Ordinal);
            return result.Count > 0 ? result : null;
        }

        /// <summary>Each element the design's repeat items hide by markup in some items, with the element its visibility setter writes; null for none.</summary>
        static Dictionary<string, string> Visibility(CompiledScreen compiled)
        {
            var result = compiled.AllElements().Where(e => e.VisibilityOwner != null).ToDictionary(e => e.Name, e => e.VisibilityOwner, StringComparer.Ordinal);
            return result.Count > 0 ? result : null;
        }

        static string GeneratorVersion
        {
            get
            {
                var info = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(ScreenCompiler).Assembly);
                return info != null ? info.name + "@" + info.version : "com.ertugrulgaziakcan.design-ui@unknown";
            }
        }

        static CompileResult Fail(string error) => new CompileResult { Ok = false, Errors = new[] { error } };

        /// <summary>Adds an output; two outputs whose names differ only in case would be one file on macOS and Windows.</summary>
        static void Add(IDictionary<string, byte[]> outputs, string name, string text) => Add(outputs, name, new UTF8Encoding(false).GetBytes(text.Replace("\r\n", "\n")));

        static void Add(IDictionary<string, byte[]> outputs, string name, byte[] bytes)
        {
            var clash = outputs.Keys.FirstOrDefault(k => string.Equals(k, name, StringComparison.OrdinalIgnoreCase));
            if (clash != null && (clash != name || !outputs[clash].SequenceEqual(bytes)))
                throw new IrFormatException("two generated files would be '" + name + "' (" + clash + "); rename the screen or the repeat");
            outputs[name] = bytes;
        }

        /// <summary>
        /// Files that would lose a hand edit: a tracked file whose content matches neither its recorded hash nor the new
        /// output (a file that already has the new content is clean, e.g. after an interrupted compile), and an untracked
        /// file in the way whose content differs from the new output.
        /// </summary>
        static IEnumerable<string> ManualEdits(string dir, GeneratedManifest manifest, IDictionary<string, byte[]> outputs)
        {
            var edits = new List<string>();
            if (manifest != null)
                foreach (var path in manifest.FindManualEdits(dir))
                {
                    var rel = path.Substring(dir.TrimEnd('/', '\\').Length + 1);
                    if (outputs.TryGetValue(rel, out var bytes) && GeneratedManifest.SameContent(rel, File.ReadAllBytes(path), bytes)) continue;
                    edits.Add(path);
                }
            foreach (var kv in outputs)
            {
                if (manifest != null && manifest.files.ContainsKey(kv.Key)) continue;
                var path = GeneratedManifest.Combine(dir, kv.Key);
                if (File.Exists(path) && !GeneratedManifest.SameContent(kv.Key, File.ReadAllBytes(path), kv.Value)) edits.Add(path);
            }
            return edits;
        }

        static void Plan(string dir, IDictionary<string, byte[]> outputs, List<KeyValuePair<string, byte[]>> writes)
        {
            foreach (var kv in outputs)
            {
                var path = GeneratedManifest.Combine(dir, kv.Key);
                if (File.Exists(path) && GeneratedManifest.SameContent(kv.Key, File.ReadAllBytes(path), kv.Value)) continue;
                writes.Add(new KeyValuePair<string, byte[]>(path, kv.Value));
            }
        }

        static void SaveIfChanged(string path, GeneratedManifest manifest, List<string> folders)
        {
            var text = manifest.ToJson();
            if (File.Exists(path) && File.ReadAllText(path).Replace("\r\n", "\n") == text) return;
            EnsureFolder(Path.GetDirectoryName(path)?.Replace('\\', '/'), folders);
            File.WriteAllText(path, text, new UTF8Encoding(false)); // dot files are not assets: no import
        }

        static void Delete(string path)
        {
            var project = ProjectPath(path);
            if (project != null && AssetDatabase.DeleteAsset(project)) return;
            if (File.Exists(path)) File.Delete(path);
        }

        /// <summary>Creates a folder; new project folders are listed so the batch imports them (their .meta) before the files.</summary>
        static void EnsureFolder(string dir, List<string> created)
        {
            if (string.IsNullOrEmpty(dir) || Directory.Exists(dir) && !NeedsImport(dir)) return;
            var project = ProjectPath(dir);
            var slash = dir.LastIndexOf('/');
            if (project != null && project.StartsWith("Assets/", StringComparison.Ordinal) && slash > 0) EnsureFolder(dir.Substring(0, slash), created);
            Directory.CreateDirectory(dir);
            if (project != null && project.StartsWith("Assets/", StringComparison.Ordinal) && !created.Contains(project)) created.Add(project);
        }

        static bool NeedsImport(string dir)
        {
            var project = ProjectPath(dir);
            return project != null && project.StartsWith("Assets/", StringComparison.Ordinal) && !AssetDatabase.IsValidFolder(project);
        }

        /// <summary>Project-relative path (Assets/… or Packages/…) of a file, or null when it is outside the project.</summary>
        internal static string ProjectPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            var p = path.Replace('\\', '/');
            if (Path.IsPathRooted(p))
            {
                var root = Directory.GetCurrentDirectory().Replace('\\', '/').TrimEnd('/') + "/";
                if (!p.StartsWith(root, StringComparison.Ordinal)) return null;
                p = p.Substring(root.Length);
            }
            return p == "Assets" || p.StartsWith("Assets/", StringComparison.Ordinal) || p.StartsWith("Packages/", StringComparison.Ordinal) ? p : null;
        }

        /// <summary>
        /// The project folder of the compiled font set (the output folder), or null when the output folder is outside
        /// Assets/ (no font set is written there).
        /// </summary>
        static string FontSetFolder(string outFolder)
        {
            var folder = ProjectPath(outFolder?.Replace('\\', '/').TrimEnd('/'));
            return folder != null && (folder == "Assets" || folder.StartsWith("Assets/", StringComparison.Ordinal)) ? folder : null;
        }

        /// <summary>Creates a project folder under Assets/ with its parents, through the AssetDatabase (outside any batch).</summary>
        static void EnsureAssetFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            var slash = folder.LastIndexOf('/');
            if (slash <= 0) return;
            var parent = folder.Substring(0, slash);
            EnsureAssetFolder(parent);
            if (Directory.Exists(folder)) AssetDatabase.ImportAsset(folder);
            else AssetDatabase.CreateFolder(parent, folder.Substring(slash + 1));
        }

        /// <summary>
        /// Every locale's text of a key in the screen's String Table collection, read when it is asked (one key at a time), or
        /// null when the profile does not localize or no tables are installed: a text the design keeps on fixed lines gets
        /// its explicit height only when every translation keeps the line count (ScreenBuilder.PlanTextHeights).
        /// </summary>
        internal static Func<string, IEnumerable<string>> Translations(DesignUiProfile profile, string screen, IDesignStringTables tables)
        {
            if (profile?.localization == null || !profile.localization.enabled || tables == null || string.IsNullOrEmpty(screen)) return null;
            string collection;
            try { collection = profile.localization.CollectionFor(screen); }
            catch (IrFormatException) { return null; }
            if (string.IsNullOrEmpty(collection)) return null;
            return key => tables.Strings(collection, new[] { key }).Values.SelectMany(v => v);
        }

        /// <summary>The panel scale of each of the profile's exact viewports (distinct, in the profile's order): the screen root's <c>exact-scales</c>.</summary>
        internal static List<double> ExactViewportScales(DesignUiProfile profile) =>
            profile == null ? new List<double>() : KitSync.ExactScales(profile).Select(v => v.scale).Distinct().ToList();

        /// <summary>The kit's line boxes and each of them scaled by every text-size step (each key once).</summary>
        internal static IReadOnlyList<FontTwinGenerator.LineBox> ScaledLineBoxes(IReadOnlyList<FontTwinGenerator.LineBox> kit, IEnumerable<DesignUi.DesignTextSize> steps)
        {
            var sizes = kit.Select(b => (b.FontSize, b.LineHeight)).ToList();
            foreach (var step in steps ?? Enumerable.Empty<DesignUi.DesignTextSize>())
                if (step != null && step.scale > 0 && !float.IsInfinity(step.scale) && step.scale != 1f)
                {
                    var k = (double)(decimal)step.scale; // the decimal the profile shows, as the rules use it
                    sizes.AddRange(kit.Select(b => (b.FontSize * k, b.LineHeight * k)));
                }
            return FontTwinGenerator.LineBox.Of(sizes);
        }

        /// <summary>Queues the new folders, then the written project files (assets, style sheets, templates, code) in the open batch.</summary>
        static void QueueImports(List<string> folders, IEnumerable<string> written, string screenUxml)
        {
            // shared style sheets (tokens, fonts) before the screen sheets that import them; item templates before the screen
            // UXML that declares them
            var screen = ProjectPath(screenUxml);
            int Rank(string p) => p.EndsWith(".uss", StringComparison.Ordinal) ? (IsShared(p) ? 1 : 2)
                : p.EndsWith(".uxml", StringComparison.Ordinal) ? (p == screen ? 4 : 3) : p.EndsWith(".cs", StringComparison.Ordinal) ? 5 : 0;
            bool IsShared(string p) => Path.GetFileName(p) == TokensFileName || Path.GetFileName(p) == FontMap.FileName;
            foreach (var folder in folders) AssetDatabase.ImportAsset(folder);
            foreach (var p in written.Select(ProjectPath).Where(p => p != null && !Path.GetFileName(p).StartsWith(".", StringComparison.Ordinal)).OrderBy(Rank))
                AssetDatabase.ImportAsset(p, ImportAssetOptions.ForceUpdate);
        }

        /// <summary>Screen folders in the output folder whose screen has no folder under the design root (only when the root exists).</summary>
        static IReadOnlyList<string> FindOrphans(string outFolder, string current, string designRoot)
        {
            var result = new List<string>();
            if (string.IsNullOrEmpty(designRoot) || !Directory.Exists(designRoot) || !Directory.Exists(outFolder)) return result;
            var screens = DesignRootScreens(designRoot);
            foreach (var dir in Directory.GetDirectories(outFolder).Select(d => d.Replace('\\', '/')).OrderBy(d => d, StringComparer.Ordinal))
            {
                if (Path.GetFileName(dir) == current) continue;
                GeneratedManifest m;
                try { m = GeneratedManifest.Load(GeneratedManifest.Combine(dir, ManifestFileName)); }
                catch (InvalidDataException) { continue; }
                if (m?.screen != null && !screens.Contains(m.screen)) result.Add(dir);
            }
            return result;
        }

        /// <summary>The first <c>data-u-screen</c> attribute of an element in a page's markup.</summary>
        static readonly System.Text.RegularExpressions.Regex ScreenAttribute = new System.Text.RegularExpressions.Regex(
            @"<[A-Za-z][^>]*?\sdata-u-screen\s*=\s*(?:""([^""]*)""|'([^']*)'|([^\s>""']+))", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

        /// <summary>
        /// The screens the design root holds, keyed like the MCP server's bookkeeping: the screen id each folder's pages name
        /// (<c>data-u-screen</c> in their markup, report.html aside); a folder whose pages name none (a script builds them, or
        /// it has no page) counts by its own name and by the screen its last import recorded.
        /// </summary>
        internal static HashSet<string> DesignRootScreens(string designRoot)
        {
            var screens = new HashSet<string>(StringComparer.Ordinal);
            foreach (var folder in Directory.GetDirectories(designRoot))
            {
                var name = Path.GetFileName(folder);
                if (name.StartsWith(".", StringComparison.Ordinal)) continue;
                var named = false;
                foreach (var page in Directory.GetFiles(folder, "*.html"))
                {
                    if (string.Equals(Path.GetFileName(page), "report.html", StringComparison.OrdinalIgnoreCase)) continue;
                    string html;
                    try { html = File.ReadAllText(page); }
                    catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { continue; }
                    var m = ScreenAttribute.Match(html);
                    var id = m.Success ? (m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value).Trim() : "";
                    if (id.Length > 0) { screens.Add(id); named = true; }
                }
                if (named) continue;
                screens.Add(name);
                try
                {
                    var recorded = Newtonsoft.Json.Linq.JObject.Parse(File.ReadAllText(Path.Combine(folder, ".design-ui", "last-import.json")))["screen"];
                    if (recorded?.Type == Newtonsoft.Json.Linq.JTokenType.String) screens.Add((string)recorded);
                }
                catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is Newtonsoft.Json.JsonException) { }
            }
            return screens;
        }
    }
}
