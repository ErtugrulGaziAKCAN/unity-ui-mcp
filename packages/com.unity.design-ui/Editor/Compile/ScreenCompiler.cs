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
    }

    /// <summary>
    /// Replaceable steps of the compile, wired by later tasks: asset import (Task 14), font twins (Task 15) and the view
    /// class (Task 16). Null keeps the built-in behaviour.
    /// </summary>
    internal sealed class CompileHooks
    {
        /// <summary>Imports an IR asset and returns its path for url(); default: copy it to <c>&lt;screen&gt;/assets/</c>.</summary>
        public Func<IrAsset, string> AssetPath;
        /// <summary>USS value of <c>-unity-font-definition</c> for a family; default: keep the <c>var(--font-…)</c> placeholder.</summary>
        public Func<string, string> FontDefinition;
        /// <summary>Text of <c>&lt;Screen&gt;View.g.cs</c>; default: no view file.</summary>
        public Func<CompiledScreen, string> ViewCode;
    }

    /// <summary>
    /// Compiles an export folder (<c>screen.ir.json</c>, assets, optional <c>text-styles.json</c>) into
    /// <c>&lt;outputFolder&gt;/&lt;Screen&gt;/</c>: <c>&lt;Screen&gt;.uxml</c>, <c>&lt;Screen&gt;.uss</c>, list item
    /// templates, assets and <c>.design-ui.json</c>, plus the shared <c>&lt;outputFolder&gt;/DesignTokens.uss</c>.
    /// Incremental (R22): every output is compared with the file on disk and written only when its bytes differ; the
    /// written project paths are imported in one asset-editing batch (no refresh, no save). A generated file whose hash
    /// no longer matches the manifest, or a file in the way that was never generated, stops the compile unless
    /// <c>discardManualEdits</c> is set (spec 18).
    /// </summary>
    public static class ScreenCompiler
    {
        public const string IrFileName = "screen.ir.json";
        public const string ManifestFileName = ".design-ui.json";
        public const string SharedManifestFileName = ".design-ui-shared.json";
        public const string TokensFileName = "DesignTokens.uss";
        public const string AssetsFolder = "assets";

        public static CompileResult Compile(string exportDir, DesignUiProfile profile, bool discardManualEdits = false) =>
            Compile(exportDir, profile, discardManualEdits, null);

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
            string screenDir;
            try
            {
                ir = IrReader.Read(irPath);
                var className = ScreenBuilder.Pascal(ir.Screen, "screen id");
                screenDir = outFolder + "/" + className;

                var stylesPath = Path.Combine(exportDir, KitTextStyles.FileName);
                if (!File.Exists(stylesPath) && !string.IsNullOrEmpty(profile.kitDir)) stylesPath = Path.Combine(profile.kitDir, KitTextStyles.FileName);
                var textStyles = File.Exists(stylesPath) ? KitTextStyles.Load(stylesPath) : null;

                var assetPath = hooks?.AssetPath ?? (a => CopyAsset(a, exportDir, outputs));
                compiled = ScreenBuilder.Build(ir, assetPath, hooks?.FontDefinition, textStyles);

                outputs[className + ".uxml"] = Utf8(UxmlWriter.Write(compiled, className + ".uss"));
                outputs[className + ".uss"] = Utf8(UssWriter.Write(compiled));
                foreach (var repeat in compiled.Repeats)
                    if (repeat.TemplateFile != null) outputs[repeat.TemplateFile] = Utf8(UxmlWriter.WriteItemTemplate(repeat));
                if (hooks?.ViewCode != null) outputs[ViewFileName(className)] = Utf8(hooks.ViewCode(compiled));
            }
            catch (Exception e) when (e is IrFormatException || e is UnsupportedStyleException || e is IOException || e is UnauthorizedAccessException)
            {
                return Fail(e.Message);
            }

            // ---- manual-edit guard ------------------------------------------------------------------------------
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

            var tokens = new SortedDictionary<string, string>(StringComparer.Ordinal);
            if (shared?.tokens != null) foreach (var kv in shared.tokens) tokens[kv.Key] = kv.Value;
            string tokensText;
            try
            {
                foreach (var kv in TokensUssWriter.Normalized(ir.Tokens)) tokens[kv.Key] = kv.Value;
                tokensText = TokensUssWriter.Write(tokens);
            }
            catch (IrFormatException e) { return Fail(e.Message); }
            var sharedOutputs = new SortedDictionary<string, byte[]>(StringComparer.Ordinal) { { TokensFileName, Utf8(tokensText) } };

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

            // ---- write what changed -----------------------------------------------------------------------------
            var written = new List<string>();
            var stale = manifest == null ? new List<string>() : manifest.files.Keys.Where(k => !outputs.ContainsKey(k)).Select(k => GeneratedManifest.Combine(screenDir, k)).ToList();
            try
            {
                WriteChanged(screenDir, outputs, written);
                WriteChanged(outFolder, sharedOutputs, written);
                foreach (var path in stale) Delete(path);

                var newManifest = new GeneratedManifest
                {
                    screen = ir.Screen,
                    sourceSha256 = ir.Source?.Sha256,
                    irSha256 = GeneratedManifest.Sha256Hex(File.ReadAllBytes(irPath)),
                    generatorVersion = GeneratorVersion,
                    files = outputs.ToDictionary(kv => kv.Key, kv => GeneratedManifest.Sha256Hex(kv.Value), StringComparer.Ordinal),
                    removedElements = compiled.RemovedElements.ToArray(),
                    root = compiled.Root.Name,
                    view = ViewFileName(compiled.ClassName),
                    clickable = compiled.AllElements().Where(e => e.Clickable).Select(e => e.Name).ToArray(),
                    mirrors = compiled.AllElements().Where(e => e.MirrorHost).Select(e => new MirrorEntry { element = e.MirrorElement, host = e.Name }).ToArray(),
                    repeats = compiled.Repeats.Select(r => new RepeatEntry
                    {
                        name = r.Name, mode = r.Mode, container = r.Container, template = r.TemplateFile, items = r.Items.Select(i => i.Name).ToArray(),
                    }).ToArray(),
                };
                SaveIfChanged(GeneratedManifest.Combine(screenDir, ManifestFileName), newManifest);
                SaveIfChanged(GeneratedManifest.Combine(outFolder, SharedManifestFileName), new GeneratedManifest
                {
                    generatorVersion = GeneratorVersion,
                    files = sharedOutputs.ToDictionary(kv => kv.Key, kv => GeneratedManifest.Sha256Hex(kv.Value), StringComparer.Ordinal),
                    tokens = new Dictionary<string, string>(tokens, StringComparer.Ordinal),
                    removedElements = null, clickable = null, mirrors = null, repeats = null, // screen-only fields
                });
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
            {
                Import(written);
                return new CompileResult { Ok = false, Written = written, Errors = new[] { "writing generated files failed: " + e.Message } };
            }

            Import(written);
            return new CompileResult { Ok = true, Written = written };
        }

        public static string ViewFileName(string className) => className + "View.g.cs";

        static string GeneratorVersion
        {
            get
            {
                var info = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(ScreenCompiler).Assembly);
                return info != null ? info.name + "@" + info.version : "com.unity.design-ui@unknown";
            }
        }

        static CompileResult Fail(string error) => new CompileResult { Ok = false, Errors = new[] { error } };

        static byte[] Utf8(string text) => new UTF8Encoding(false).GetBytes(text.Replace("\r\n", "\n"));

        /// <summary>Built-in asset step until the asset importer is wired: the asset's bytes become an output next to the screen.</summary>
        static string CopyAsset(IrAsset asset, string exportDir, IDictionary<string, byte[]> outputs)
        {
            if (string.IsNullOrEmpty(asset.File)) throw new IrFormatException("an asset has no file");
            var source = Path.Combine(exportDir, asset.File);
            if (!File.Exists(source)) throw new IrFormatException("asset file '" + asset.File + "' is missing in the export folder");
            var relative = AssetsFolder + "/" + Path.GetFileName(asset.File);
            outputs[relative] = File.ReadAllBytes(source);
            return relative;
        }

        static IEnumerable<string> ManualEdits(string dir, GeneratedManifest manifest, IDictionary<string, byte[]> outputs)
        {
            var edits = new List<string>(manifest?.FindManualEdits(dir) ?? new string[0]);
            foreach (var kv in outputs)
            {
                if (manifest != null && manifest.files.ContainsKey(kv.Key)) continue;
                var path = GeneratedManifest.Combine(dir, kv.Key);
                // a file this compiler never wrote is only replaced when it already has the generated bytes
                if (File.Exists(path) && !File.ReadAllBytes(path).SequenceEqual(kv.Value)) edits.Add(path);
            }
            return edits;
        }

        static void WriteChanged(string dir, IDictionary<string, byte[]> outputs, List<string> written)
        {
            foreach (var kv in outputs)
            {
                var path = GeneratedManifest.Combine(dir, kv.Key);
                if (File.Exists(path) && File.ReadAllBytes(path).SequenceEqual(kv.Value)) continue;
                EnsureFolder(Path.GetDirectoryName(path)?.Replace('\\', '/'));
                File.WriteAllBytes(path, kv.Value);
                written.Add(path);
            }
        }

        static void SaveIfChanged(string path, GeneratedManifest manifest)
        {
            var text = manifest.ToJson();
            if (File.Exists(path) && File.ReadAllText(path) == text) return;
            EnsureFolder(Path.GetDirectoryName(path)?.Replace('\\', '/'));
            File.WriteAllText(path, text, new UTF8Encoding(false)); // dot files are not assets: no import
        }

        static void Delete(string path)
        {
            var project = ProjectPath(path);
            if (project != null && AssetDatabase.DeleteAsset(project)) return;
            if (File.Exists(path)) File.Delete(path);
        }

        /// <summary>Creates a folder; inside the project through the AssetDatabase so the folder gets its .meta at once.</summary>
        static void EnsureFolder(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return;
            var project = ProjectPath(dir);
            if (project == null || !(project == "Assets" || project.StartsWith("Assets/", StringComparison.Ordinal)))
            {
                Directory.CreateDirectory(dir);
                return;
            }
            if (AssetDatabase.IsValidFolder(project)) return;
            var parent = project.Substring(0, project.LastIndexOf('/'));
            EnsureFolder(parent);
            if (Directory.Exists(project)) AssetDatabase.ImportAsset(project);
            else AssetDatabase.CreateFolder(parent, project.Substring(parent.Length + 1));
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

        /// <summary>Imports the written project files in one asset-editing batch: assets, then style sheets, templates, code.</summary>
        static void Import(IEnumerable<string> written)
        {
            int Rank(string p) => p.EndsWith(".uss", StringComparison.Ordinal) ? 1 : p.EndsWith(".uxml", StringComparison.Ordinal) ? 2 : p.EndsWith(".cs", StringComparison.Ordinal) ? 3 : 0;
            var paths = written.Select(ProjectPath).Where(p => p != null).OrderBy(Rank).ToList();
            if (paths.Count == 0) return;
            AssetDatabase.StartAssetEditing();
            try
            {
                foreach (var p in paths) AssetDatabase.ImportAsset(p, ImportAssetOptions.ForceUpdate);
            }
            finally
            {
                AssetDatabase.StopAssetEditing();
            }
        }
    }
}
