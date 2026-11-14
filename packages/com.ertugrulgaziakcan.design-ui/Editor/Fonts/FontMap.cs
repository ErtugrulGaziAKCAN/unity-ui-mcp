using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using TMPro;
using UnityEditor;

namespace DesignUi.Editor
{
    /// <summary>
    /// Fonts per locale for compiled screens (spec 6 and 13). Element rules keep <c>-unity-font-definition:
    /// var(--font-&lt;family&gt;)</c>; the shared <c>DesignFonts.uss</c> (next to <c>DesignTokens.uss</c>) has one rule per
    /// locale, <c>.locale-&lt;code&gt; { --font-&lt;family&gt;: url("project://database/&lt;twin&gt;"); … }</c>, that maps every
    /// font family of the project's locales to that locale's twin (bold comes from the twin's weight table through
    /// <c>-unity-font-style</c>). Screens import it, and the compiled screen root carries the reference locale's class, so
    /// swapping that class on the root switches the font of every text below it. Each family also has one variable per
    /// kit text style size, <c>--font-&lt;family&gt;-&lt;key&gt;</c> (<c>r125s16</c>, <c>r13333s12</c>), pointing at the twin's
    /// line-box variant (<see cref="FontTwinGenerator.LineBox"/>); text in a kit text style uses its size's variable.
    /// </summary>
    public static class FontMap
    {
        public const string FileName = "DesignFonts.uss";
        public const string LocaleClassPrefix = DesignUi.DesignFontSet.LocaleClassPrefix;

        static readonly Regex LocaleCode = new Regex("^[A-Za-z0-9]+([_-][A-Za-z0-9]+)*$", RegexOptions.Compiled);

        /// <summary>The built-in resolver: the profile's per-locale fonts over TMP Settings' default font and global fallbacks.</summary>
        public static IFontResolver DefaultResolver(DesignUiProfile p) => new ProfileLocaleFontResolver(p, new TmpSettingsFontResolver());

        /// <summary>
        /// The resolver kit sync, the compile and the Design UI window use: the profile's <see cref="DesignUiProfile.fontResolver"/>
        /// asset when it is set (followed by TMP Settings' global fallbacks unless it opts out; a locale it gives no font for falls
        /// back to <see cref="DefaultResolver"/>), else DefaultResolver.
        /// Throws <see cref="FontSetupException"/> when the field references an asset that no longer loads; a resolver that
        /// throws is reported the same way when it is asked.
        /// </summary>
        public static IFontResolver ResolverFor(DesignUiProfile p)
        {
            if (p == null) throw new ArgumentNullException(nameof(p));
            if (p.fontResolver != null) return new ProjectFontResolver(p.fontResolver, DefaultResolver(p), new TmpSettingsFontResolver());
            if (MissingResolver(p)) throw new FontSetupException(MissingResolverMessage);
            return DefaultResolver(p);
        }

        internal const string MissingResolverMessage =
            "the DesignUiProfile's fontResolver is missing: it references an asset that no longer loads (deleted, or its script is gone or " +
            "does not compile); pick a DesignUiFontResolver asset or clear the field";

        /// <summary>Whether the profile's fontResolver field references an object that does not load (the Inspector's "Missing").</summary>
        internal static bool MissingResolver(DesignUiProfile p)
        {
            if (!ReferenceEquals(p.fontResolver, null) && p.fontResolver == null) return true;
            using (var so = new SerializedObject(p))
            {
                var field = so.FindProperty(nameof(DesignUiProfile.fontResolver));
                return field != null && field.objectReferenceValue == null && field.objectReferenceInstanceIDValue != 0;
            }
        }

        /// <summary>A note naming the locales a project resolver gave no font for (the built-in resolver answered them), or null.</summary>
        internal static string FallbackNote(IFontResolver r) =>
            r is ProjectFontResolver p && p.FallbackLocales.Count > 0
                ? "the font resolver '" + p.Name + "' gives no font for " + string.Join(", ", p.FallbackLocales) +
                  ": the profile's locale fonts over TMP Settings answer for " + (p.FallbackLocales.Count == 1 ? "it" : "them")
                : null;

        /// <summary>Which resolver <see cref="ResolverFor"/> uses, for the Design UI window.</summary>
        internal static string ResolverDescription(DesignUiProfile p)
        {
            if (p == null) return "no DesignUiProfile";
            if (p.fontResolver != null)
                return "'" + p.fontResolver.name + "' (" + p.fontResolver.GetType().FullName + ", " + AssetDatabase.GetAssetPath(p.fontResolver) +
                       "); locales it gives no font for fall back to the profile's locale fonts over TMP Settings";
            if (MissingResolver(p)) return MissingResolverMessage;
            return "built-in: the profile's locale fonts over TMP Settings' default font and global fallbacks (the profile sets no fontResolver)";
        }

        public static string LocaleClass(string locale) => LocaleClassPrefix + locale;

        /// <summary>
        /// The <c>-unity-font-definition</c> value that renders <paramref name="family"/> in <paramref name="locale"/>:
        /// <c>url("project://database/&lt;twin path&gt;")</c> of the locale's twin, which this call creates when missing.
        /// Throws <see cref="FontSetupException"/> when no font resolves for the locale or the family is not a font of the
        /// profile's locales.
        /// </summary>
        public static string FontDefinitionFor(string family, string locale, DesignUiProfile p, IFontResolver r)
        {
            if (p == null) throw new ArgumentNullException(nameof(p));
            if (r == null) throw new ArgumentNullException(nameof(r));
            var font = r.Resolve(locale);
            if (font?.Primary == null) throw new FontSetupException(NoFont(locale));
            var plan = Plan(p, r);
            foreach (var f in Chain(font)) plan.AddFamily(f);
            if (plan.Errors.Count > 0) throw new FontSetupException(string.Join("\n", plan.Errors));
            if (!plan.Families.ContainsKey(StyleMapper.FamilyNameSlug(family)))
                throw new FontSetupException("font family '" + family + "' is not a font of the project's locales (" + string.Join(", ", plan.Families.Values) + ")");
            var twin = FontTwinGenerator.GetOrCreateTwin(font.Primary, p.fontTwinFolder, plan.Globals.Concat(font.Fallbacks ?? new TMP_FontAsset[0]));
            return Url(AssetDatabase.GetAssetPath(twin));
        }

        internal static string Url(string assetPath) => "url(\"project://database/" + ScreenBuilder.UrlPath(assetPath) + "\")";

        internal static string NoFont(string locale) =>
            "no font resolves for locale '" + locale + "': map it in the DesignUiProfile's localeFonts or set the TMP Settings default font asset";

        /// <summary>The fonts of the profile's locales, resolved without writing anything.</summary>
        internal sealed class FontsPlan
        {
            public string ReferenceLocale;
            public string TwinFolder;
            /// <summary>Reference locale first, then the profile's other locales, without duplicates.</summary>
            public readonly List<string> Locales = new List<string>();
            public readonly Dictionary<string, ResolvedFont> Fonts = new Dictionary<string, ResolvedFont>(StringComparer.Ordinal);
            /// <summary>Per resolved locale: the font assets TMP searches, in order (primary, its fallbacks depth-first, the resolver's fallbacks).</summary>
            public readonly Dictionary<string, List<TMP_FontAsset>> Chains = new Dictionary<string, List<TMP_FontAsset>>(StringComparer.Ordinal);
            /// <summary>Per resolved locale: the family names of its chain, in order.</summary>
            public readonly Dictionary<string, List<string>> LocaleFamilies = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            /// <summary>Locales no font resolves for.</summary>
            public readonly List<string> Missing = new List<string>();
            /// <summary>
            /// The resolver's fallbacks of every locale, in locale order without duplicates: TMP searches them after any
            /// font, so every twin gets them after its own fallbacks (with TMP Settings they are one project-wide list).
            /// </summary>
            public readonly List<TMP_FontAsset> Globals = new List<TMP_FontAsset>();
            /// <summary>The line boxes of the kit's text-style table: each locale's font gets a twin variant per box.</summary>
            public IReadOnlyList<FontTwinGenerator.LineBox> LineBoxes = new FontTwinGenerator.LineBox[0];
            /// <summary>
            /// The faces (weight, italic) of the fonts' weight tables that get twins (<see cref="ProfileFaces"/>: the kit's text
            /// styles and every compiled screen's, plus the screen being compiled, <see cref="ScreenFaces"/>); null: every face.
            /// A face no text style and no screen uses gets no twin, so its glyphs are never added either (18 faces of a family
            /// cost minutes per import).
            /// </summary>
            public SortedSet<(int weight, bool italic)> Faces;
            /// <summary>Every family of the resolved locales: USS variable slug to family name.</summary>
            public readonly SortedDictionary<string, string> Families = new SortedDictionary<string, string>(StringComparer.Ordinal);
            public readonly List<string> Errors = new List<string>();

            public void AddFamily(TMP_FontAsset font)
            {
                var name = font.faceInfo.familyName;
                if (string.IsNullOrWhiteSpace(name))
                {
                    Errors.Add("TMP font asset '" + font.name + "' has no family name in its face info; regenerate it from its font file");
                    return;
                }
                string slug;
                try { slug = StyleMapper.FamilyNameSlug(name); }
                catch (UnsupportedStyleException)
                {
                    Errors.Add("the family name '" + name + "' of TMP font asset '" + font.name + "' gives no USS variable name (no ASCII letter or digit)");
                    return;
                }
                if (Families.TryGetValue(slug, out var other) && other != name)
                    Errors.Add("font families '" + other + "' and '" + name + "' give the same USS variable --font-" + slug + "; rename one of the font assets' families");
                else Families[slug] = name;
            }
        }

        internal static FontsPlan Plan(DesignUiProfile p, IFontResolver r)
        {
            var plan = new FontsPlan { ReferenceLocale = (p.referenceLocale ?? "").Trim(), TwinFolder = p.fontTwinFolder };
            if (plan.ReferenceLocale.Length == 0) plan.Errors.Add("the DesignUiProfile has no reference locale");
            foreach (var raw in new[] { plan.ReferenceLocale }.Concat(p.locales ?? new string[0]))
            {
                var code = (raw ?? "").Trim();
                if (code.Length == 0 || plan.Locales.Contains(code, StringComparer.OrdinalIgnoreCase)) continue;
                if (!LocaleCode.IsMatch(code))
                {
                    plan.Errors.Add("locale '" + code + "' cannot be part of a USS class name (letters, digits, '-' and '_' only)");
                    continue;
                }
                plan.Locales.Add(code);
            }
            foreach (var locale in plan.Locales)
            {
                var font = r.Resolve(locale);
                if (font?.Primary == null)
                {
                    plan.Missing.Add(locale);
                    continue;
                }
                plan.Fonts[locale] = font;
                foreach (var g in font.Fallbacks ?? new TMP_FontAsset[0])
                    if (g != null && !plan.Globals.Contains(g)) plan.Globals.Add(g);
                var chain = Chain(font);
                plan.Chains[locale] = chain;
                plan.LocaleFamilies[locale] = chain.Select(f => f.faceInfo.familyName).Where(n => !string.IsNullOrWhiteSpace(n)).Distinct().ToList();
                foreach (var f in chain) plan.AddFamily(f);
            }
            return plan;
        }

        /// <summary>The font assets TMP searches for a resolved font: the primary, each fallback list depth-first, then the resolver's fallbacks.</summary>
        internal static List<TMP_FontAsset> Chain(ResolvedFont font)
        {
            var chain = new List<TMP_FontAsset>();
            void Visit(TMP_FontAsset f)
            {
                if (f == null || chain.Contains(f)) return;
                chain.Add(f);
                foreach (var x in f.fallbackFontAssetTable ?? new List<TMP_FontAsset>()) Visit(x);
            }
            Visit(font.Primary);
            foreach (var f in font.Fallbacks ?? new TMP_FontAsset[0]) Visit(f);
            return chain;
        }

        /// <summary>
        /// Errors for a compiled screen: every font family it names must be a family of the locales' fonts, and every
        /// locale must have a font. A screen that names no family needs no fonts.
        /// </summary>
        internal static List<string> ScreenErrors(FontsPlan plan, CompiledScreen screen)
        {
            const string prefix = "var(--font-";
            var used = new SortedSet<string>(StringComparer.Ordinal);
            foreach (var rule in screen.Rules)
                foreach (var d in rule.Declarations)
                    if (d.Property == "-unity-font-definition" && d.Value.StartsWith(prefix, StringComparison.Ordinal) && d.Value.EndsWith(")", StringComparison.Ordinal))
                        used.Add(FamilySlugOf(d.Value.Substring(prefix.Length, d.Value.Length - prefix.Length - 1)));
            var errors = new List<string>();
            if (used.Count == 0) return errors;
            var names = string.Join(", ", used.Select(s => "'" + s + "'"));
            foreach (var locale in plan.Missing) errors.Add("the screen uses font family " + names + ", but " + NoFont(locale));
            if (plan.Fonts.Count > 0)
                foreach (var slug in used.Where(s => !plan.Families.ContainsKey(s)))
                    errors.Add("font family '" + slug + "' is not a font of the project's locales (" + string.Join(", ", plan.Families.Values) +
                               "); designs may use the kit's fonts only (fonts/fonts.css, written by kit sync)");
            return errors;
        }

        static readonly Regex LineBoxSuffix = new Regex(@"-r\d+s\d+(p\d+)?$", RegexOptions.CultureInvariant);

        /// <summary>The family slug of a font variable name: <c>inter-r125s16</c> → <c>inter</c> (a line-box key is dropped).</summary>
        internal static string FamilySlugOf(string variable) => LineBoxSuffix.Replace(variable, "");

        /// <summary>
        /// DesignFonts.uss: per resolved locale, every family's variable points at the locale's twin, and its line-box
        /// variables (<c>--font-&lt;family&gt;-&lt;key&gt;</c>) at the twin's variants.
        /// </summary>
        internal static string WriteUss(FontsPlan plan)
        {
            var sb = new StringBuilder();
            sb.Append(UssWriter.Header).Append('\n');
            foreach (var locale in plan.Locales)
            {
                if (!plan.Fonts.TryGetValue(locale, out var font)) continue;
                var url = Url(FontTwinGenerator.TwinPath(font.Primary, plan.TwinFolder));
                sb.Append("\n.").Append(LocaleClass(locale)).Append(" {\n");
                foreach (var slug in plan.Families.Keys)
                {
                    sb.Append("    --font-").Append(slug).Append(": ").Append(url).Append(";\n");
                    foreach (var box in plan.LineBoxes.OrderBy(b => b.Key, StringComparer.Ordinal))
                        sb.Append("    --font-").Append(slug).Append('-').Append(box.Key).Append(": ")
                          .Append(Url(FontTwinGenerator.TwinPath(font.Primary, plan.TwinFolder, box))).Append(";\n");
                }
                sb.Append("}\n");
            }
            return sb.ToString();
        }

        /// <summary>
        /// Adds every character of <paramref name="strings"/> (the screen's texts in every locale) to each resolved locale's
        /// primary plain twin with their kerning pairs (<see cref="DesignUi.DesignText.Prepare"/>, which also covers the weight
        /// faces and, for missing characters, the fallbacks), brings the twins that gained characters to their smallest form and
        /// saves them (<see cref="TwinAtlas.Maintain"/>), and links the line-box variants to them again: a variant shares its
        /// plain twin's glyphs (<see cref="DesignUi.FontTwinLink"/>). Without it the first layout of a text whose glyphs are new
        /// to a dynamic twin is unkerned (docs/findings/text-ink.md). Returns the characters no font of a locale's chain has.
        /// <paramref name="onlyLocale"/> limits it to one resolved locale (a locale's own translations).
        /// </summary>
        internal static string PrepareTwins(FontsPlan plan, FontTwinGenerator.TwinRun run, IEnumerable<string> strings, string onlyLocale = null)
        {
            var text = string.Concat((strings ?? Enumerable.Empty<string>()).Where(s => !string.IsNullOrEmpty(s)));
            if (text.Length == 0) return "";
            var plains = run.Plains.Select(p => p.twin).Distinct().ToList();
            var before = plains.ToDictionary(t => t, t => t.characterTable.Count);
            var missing = new System.Text.StringBuilder();
            foreach (var locale in plan.Locales)
            {
                if (onlyLocale != null && locale != onlyLocale) continue;
                if (!plan.Fonts.TryGetValue(locale, out var font) || !run.Twins.TryGetValue((font.Primary, ""), out var twin) || twin == null) continue;
                foreach (var c in DesignUi.DesignText.Prepare(twin, text)) if (missing.ToString().IndexOf(c) < 0) missing.Append(c);
            }
            TwinAtlas.Maintain(run, plains.Where(t => t.characterTable.Count != before[t]));
            return missing.ToString();
        }

        /// <summary>
        /// The resolved locale whose twins render <paramref name="code"/> (as the runtime locale controller picks them): the
        /// same code, else the same language in the same script, else the reference locale.
        /// </summary>
        internal static string FontLocaleFor(FontsPlan plan, string code)
        {
            string Part(string c, bool script)
            {
                var parts = c.Split('-', '_');
                if (!script) return parts[0];
                return parts.Skip(1).FirstOrDefault(p => p.Length == 4 && char.IsLetter(p[0]));
            }
            var resolved = plan.Locales.Where(l => plan.Fonts.ContainsKey(l)).ToList();
            var exact = resolved.FirstOrDefault(l => string.Equals(l, code, StringComparison.OrdinalIgnoreCase));
            if (exact != null) return exact;
            var same = resolved.FirstOrDefault(l => string.Equals(Part(l, false), Part(code, false), StringComparison.OrdinalIgnoreCase) &&
                                                     (Part(code, true) == null || Part(l, true) == null || string.Equals(Part(code, true), Part(l, true), StringComparison.OrdinalIgnoreCase)));
            return same ?? plan.ReferenceLocale;
        }

        /// <summary>
        /// <c>DesignFonts.asset</c> (<see cref="DesignUi.DesignFontSet"/>) in <paramref name="outFolder"/>: per resolved locale
        /// its primary twin and line-box variants, so <see cref="DesignUi.DesignText.SetText"/> can prepare a bound text before
        /// the element's styles resolve. Written only inside Assets/ and only when it changes; returns its path then, else null.
        /// </summary>
        internal static string WriteFontSet(FontsPlan plan, FontTwinGenerator.TwinRun run, string outFolder) => WriteFontSet(plan, run, outFolder, null);

        /// <param name="textSizes">The text-size steps the screens have rules for (recorded for the locale controller).</param>
        internal static string WriteFontSet(FontsPlan plan, FontTwinGenerator.TwinRun run, string outFolder, IReadOnlyList<DesignUi.DesignTextSize> textSizes)
        {
            var folder = ScreenCompiler.ProjectPath(outFolder?.Replace('\\', '/').TrimEnd('/'));
            if (folder == null || !folder.StartsWith("Assets", StringComparison.Ordinal) || !AssetDatabase.IsValidFolder(folder)) return null;
            var path = folder + "/" + DesignUi.DesignFontSet.FileName;
            var wanted = plan.Locales.Where(l => plan.Fonts.ContainsKey(l)).Select(l => new DesignUi.DesignFontSet.LocaleFonts
            {
                locale = l,
                fonts = new[] { "" }.Concat(plan.LineBoxes.Select(b => b.Key))
                    .Select(k => run.Twins.TryGetValue((plan.Fonts[l].Primary, k), out var t) ? t : null).Where(t => t != null).ToArray(),
            }).ToArray();
            // every line-box variant of the run (fallbacks' and weight faces' too) with the twin whose glyphs it shares, in path order
            var links = run.Sources.Where(kv => kv.Key != null && kv.Value != null)
                .OrderBy(kv => AssetDatabase.GetAssetPath(kv.Key), StringComparer.Ordinal)
                .Select(kv => new DesignUi.DesignFontSet.TwinLink { variant = kv.Key, source = kv.Value }).ToArray();
            var steps = (textSizes ?? new DesignUi.DesignTextSize[0]).Where(t => t != null).Select(t => t.Clone()).ToArray();
            var set = AssetDatabase.LoadAssetAtPath<DesignUi.DesignFontSet>(path);
            if (set == null && System.IO.File.Exists(path))
                throw new FontSetupException("'" + path + "' is in the way of the generated font set: it is not a DesignFontSet. Move or delete it.");
            if (set != null && set.referenceLocale == plan.ReferenceLocale && (set.locales ?? new DesignUi.DesignFontSet.LocaleFonts[0]).Length == wanted.Length &&
                set.locales.Zip(wanted, (a, b) => a != null && a.locale == b.locale && (a.fonts ?? new UnityEngine.TextCore.Text.FontAsset[0]).SequenceEqual(b.fonts)).All(x => x) &&
                (set.textSizes ?? new DesignUi.DesignTextSize[0]).Length == steps.Length &&
                set.textSizes.Zip(steps, (a, b) => a != null && a.key == b.key && a.scale == b.scale).All(x => x) &&
                (set.links ?? new DesignUi.DesignFontSet.TwinLink[0]).Length == links.Length &&
                set.links.Zip(links, (a, b) => a != null && a.variant == b.variant && a.source == b.source).All(x => x))
                return null;
            bool created = set == null;
            if (created) set = UnityEngine.ScriptableObject.CreateInstance<DesignUi.DesignFontSet>();
            set.referenceLocale = plan.ReferenceLocale;
            set.locales = wanted;
            set.textSizes = steps;
            set.links = links;
            if (created) AssetDatabase.CreateAsset(set, path);
            else
            {
                EditorUtility.SetDirty(set);
                AssetDatabase.SaveAssetIfDirty(set);
            }
            return path;
        }

        /// <summary>
        /// The faces a kit's text styles use: regular (400) and bold (700), which UI Toolkit's normal and bold font styles
        /// pick from a weight table, and every weight a style names (italic when it names <c>"fontStyle": "italic"</c>).
        /// Without a readable table: 400 and 700.
        /// </summary>
        internal static SortedSet<(int weight, bool italic)> KitFaces(string textStylesPath)
        {
            var faces = new SortedSet<(int, bool)> { (400, false), (700, false) };
            if (string.IsNullOrEmpty(textStylesPath) || !System.IO.File.Exists(textStylesPath)) return faces;
            try
            {
                var table = Newtonsoft.Json.Linq.JObject.Parse(System.IO.File.ReadAllText(textStylesPath));
                foreach (var p in table.Properties())
                {
                    if (!(p.Value is Newtonsoft.Json.Linq.JObject style)) continue;
                    var w = style["weight"];
                    int weight = w != null && (w.Type == Newtonsoft.Json.Linq.JTokenType.Integer || w.Type == Newtonsoft.Json.Linq.JTokenType.Float) ? (int)Math.Round((double)w) : 400;
                    bool italic = string.Equals((string)style["fontStyle"], "italic", StringComparison.OrdinalIgnoreCase);
                    if (weight >= 100 && weight <= 900) faces.Add((weight / 100 * 100, italic));
                }
            }
            catch (Exception e) when (e is System.IO.IOException || e is Newtonsoft.Json.JsonException || e is InvalidCastException || e is FormatException) { }
            return faces;
        }

        /// <summary>The faces UI Toolkit picks with <c>-unity-font-style</c>: 400 and 700 (normal and bold), upright and italic.</summary>
        internal static readonly (int weight, bool italic)[] StyleFaces = { (400, false), (400, true), (700, false), (700, true) };

        /// <summary>A face a compiled screen's text renders with: the element and the layer (or rich text) that need it.</summary>
        internal readonly struct NeededFace
        {
            public readonly int Weight;
            public readonly bool Italic;
            public readonly string Element;
            public readonly string Layer;

            public NeededFace(int weight, bool italic, string element, string layer)
            {
                Weight = weight;
                Italic = italic;
                Element = element;
                Layer = layer;
            }

            public (int weight, bool italic) Face => (Weight, Italic);
        }

        /// <summary>A face as the generated manifest records it: <c>400</c>, <c>700 italic</c>.</summary>
        internal static string FaceName((int weight, bool italic) f) => f.weight + (f.italic ? " italic" : "");

        static bool TryParseFace(string text, out (int weight, bool italic) face)
        {
            face = default;
            var parts = (text ?? "").Split(' ');
            if (parts.Length < 1 || parts.Length > 2 || !int.TryParse(parts[0], System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var w)) return false;
            if (parts.Length == 2 && parts[1] != "italic") return false;
            face = (w, parts.Length == 2);
            return true;
        }

        /// <summary>
        /// Every face the texts of a compiled screen render with, as UI Toolkit picks it: each text element's
        /// <c>-unity-font-style</c> in each of its layers (base and layer merged as <see cref="StyleMapper.FontStyleOf"/> writes
        /// it, so a weight-only layer over italic text needs bold italic), combined with the bold and italic tags of its rich
        /// text (<c>&lt;b&gt;</c> inside italic text is bold italic).
        /// </summary>
        internal static List<NeededFace> ScreenFaces(CompiledScreen screen)
        {
            var result = new List<NeededFace>();
            var seen = new HashSet<IrNode>();
            var empty = new Dictionary<string, string>();
            foreach (var e in screen.AllElements())
            {
                var n = e.Source;
                if (n?.Style == null || !seen.Add(n) || !RendersText(n)) continue;
                var runs = RichRuns(n);
                foreach (var kv in n.Style.OrderBy(kv => kv.Key, StringComparer.Ordinal))
                {
                    bool isBase = kv.Key == "base";
                    var css = kv.Value ?? empty;
                    var style = isBase ? StyleMapper.FontStyleOf(css, css) ?? "normal" : StyleMapper.FontStyleOf(css, Lowering.Basis(n, kv.Key));
                    if (style == null) continue;
                    bool bold = style.StartsWith("bold", StringComparison.Ordinal), italic = style.EndsWith("italic", StringComparison.Ordinal);
                    foreach (var (b, i) in runs)
                        result.Add(new NeededFace(bold || b ? 700 : 400, italic || i, n.Id, kv.Key + (b || i ? ", rich text" : "")));
                }
            }
            return result;
        }

        static bool RendersText(IrNode n) => n.Text != null || n.Kind == "text" || n.Kind == "input" || n.Kind == "dropdown";

        static readonly Regex RichTag = new Regex(@"<(/?)([A-Za-z]+)(?:=[^<>]*)?>", RegexOptions.CultureInvariant);

        /// <summary>The bold and italic tags each run of a rich text is inside (<c>&lt;b&gt;</c>, <c>&lt;i&gt;</c>, nested); one upright run without tags.</summary>
        static HashSet<(bool bold, bool italic)> RichRuns(IrNode n)
        {
            var runs = new HashSet<(bool, bool)>();
            if (n.Text != null && n.Text.Rich)
                foreach (var text in new[] { n.Text.Tr, n.Text.En })
                {
                    if (string.IsNullOrEmpty(text)) continue;
                    int bold = 0, italic = 0, at = 0;
                    void Run(int end)
                    {
                        for (int k = at; k < end; k++)
                            if (!char.IsWhiteSpace(text[k])) { runs.Add((bold > 0, italic > 0)); return; }
                    }
                    foreach (Match m in RichTag.Matches(text))
                    {
                        Run(m.Index);
                        at = m.Index + m.Length;
                        int step = m.Groups[1].Value.Length > 0 ? -1 : 1;
                        switch (m.Groups[2].Value.ToLowerInvariant())
                        {
                            case "b": case "strong": bold = Math.Max(0, bold + step); break;
                            case "i": case "em": italic = Math.Max(0, italic + step); break;
                        }
                    }
                    Run(text.Length);
                }
            if (runs.Count == 0) runs.Add((false, false));
            return runs;
        }

        /// <summary>Whether a TMP font has a face UI Toolkit picks for it: itself for 400, else its weight table's entry.</summary>
        internal static bool HasFace(TMP_FontAsset font, (int weight, bool italic) face)
        {
            if (face.weight == 400 && !face.italic) return true;
            var table = font.fontWeightTable;
            int i = face.weight / 100;
            if (table == null || i < 0 || i >= table.Length) return false;
            return face.italic ? table[i].italicTypeface != null : table[i].regularTypeface != null;
        }

        /// <summary>
        /// The faces a screen needs that a locale's font has not: an error for the reference locale (the design's font; UI
        /// Toolkit would synthesize the face), a note for another locale (its font renders that face synthesized).
        /// </summary>
        internal static void FaceProblems(FontsPlan plan, IReadOnlyList<NeededFace> needed, List<string> errors, List<string> notes)
        {
            foreach (var locale in plan.Locales)
            {
                if (!plan.Fonts.TryGetValue(locale, out var font) || font.Primary == null) continue;
                var family = font.Primary.faceInfo.familyName;
                foreach (var group in needed.GroupBy(f => f.Face).OrderBy(g => g.Key))
                {
                    if (HasFace(font.Primary, group.Key)) continue;
                    var first = group.First();
                    var others = group.Select(f => f.Element).Distinct().Count() - 1;
                    var where = "'" + first.Element + "' (" + first.Layer + ")" + (others > 0 ? " and " + others + " more element" + (others == 1 ? "" : "s") : "");
                    if (locale == plan.ReferenceLocale)
                        errors.Add(where + " renders " + family + " " + FaceName(group.Key) + ", but the reference locale's font '" + font.Primary.name +
                                   "' has no " + FaceName(group.Key) + " face in its weight table, so UI Toolkit would synthesize it; add that face to the TMP font " +
                                   "asset's weight table, or use a weight and style the font has");
                    else
                        notes.Add("locale '" + locale + "': font '" + font.Primary.name + "' has no " + FaceName(group.Key) + " face, so " + where +
                                  " renders with a synthesized one in that locale");
                }
            }
        }

        /// <summary>
        /// The faces that get twins: the kit's text styles' (<see cref="KitFaces"/>) and every compiled screen's of the
        /// profile (the <c>faces</c> its manifest records; one written before faces were recorded, or unreadable, counts every
        /// face UI Toolkit picks), except the screen in <paramref name="exceptFolder"/> (being compiled again). So importing
        /// one screen, or a kit sync, never takes a face away another screen renders with.
        /// </summary>
        internal static SortedSet<(int weight, bool italic)> ProfileFaces(DesignUiProfile profile, string textStylesPath, string exceptFolder = null)
        {
            var faces = KitFaces(textStylesPath);
            var outFolder = profile?.outputFolder?.Replace('\\', '/').TrimEnd('/');
            if (string.IsNullOrEmpty(outFolder) || !System.IO.Directory.Exists(outFolder)) return faces;
            var except = exceptFolder?.Replace('\\', '/').TrimEnd('/');
            foreach (var dir in System.IO.Directory.GetDirectories(outFolder).Select(d => d.Replace('\\', '/')).OrderBy(d => d, StringComparer.Ordinal))
            {
                if (except != null && string.Equals(dir, except, StringComparison.OrdinalIgnoreCase)) continue;
                GeneratedManifest m;
                try { m = GeneratedManifest.Load(GeneratedManifest.Combine(dir, ScreenCompiler.ManifestFileName)); }
                catch (System.IO.InvalidDataException) { m = new GeneratedManifest { faces = null }; }
                if (m == null) continue;
                if (m.faces == null) { foreach (var f in StyleFaces) faces.Add(f); continue; }
                foreach (var name in m.faces) if (TryParseFace(name, out var f)) faces.Add(f);
            }
            return faces;
        }

        /// <summary>The weight-table faces of the locales' fonts that get twins (<see cref="FontsPlan.Faces"/>), as "family weight[ italic] (TMP asset)".</summary>
        internal static List<string> ChosenFaces(FontsPlan plan)
        {
            var out_ = new List<string>();
            var seen = new HashSet<TMP_FontAsset>();
            foreach (var locale in plan.Locales)
            {
                if (!plan.Chains.TryGetValue(locale, out var chain)) continue;
                foreach (var f in chain)
                {
                    if (f == null || !seen.Add(f)) continue;
                    var family = f.faceInfo.familyName;
                    if (plan.Faces == null || plan.Faces.Contains((400, false))) out_.Add(family + " 400 (" + f.name + ")");
                    var table = f.fontWeightTable ?? new TMP_FontWeightPair[0];
                    for (int i = 1; i < table.Length && i <= 9; i++)
                    {
                        if (table[i].regularTypeface != null && table[i].regularTypeface != f && (plan.Faces == null || plan.Faces.Contains((i * 100, false))))
                            out_.Add(family + " " + i * 100 + " (" + table[i].regularTypeface.name + ")");
                        if (table[i].italicTypeface != null && (plan.Faces == null || plan.Faces.Contains((i * 100, true))))
                            out_.Add(family + " " + i * 100 + " italic (" + table[i].italicTypeface.name + ")");
                    }
                }
            }
            return out_;
        }

        /// <summary>How many faces the locales' weight tables have that get no twin.</summary>
        internal static int SkippedFaces(FontsPlan plan)
        {
            if (plan.Faces == null) return 0;
            int n = 0;
            var seen = new HashSet<TMP_FontAsset>();
            foreach (var f in plan.Locales.Where(plan.Chains.ContainsKey).SelectMany(l => plan.Chains[l]))
            {
                if (f == null || !seen.Add(f)) continue;
                var table = f.fontWeightTable ?? new TMP_FontWeightPair[0];
                for (int i = 1; i < table.Length && i <= 9; i++)
                {
                    if (table[i].regularTypeface != null && table[i].regularTypeface != f && !plan.Faces.Contains((i * 100, false))) n++;
                    if (table[i].italicTypeface != null && !plan.Faces.Contains((i * 100, true))) n++;
                }
            }
            return n;
        }

        /// <summary>
        /// Creates or updates the twin of every resolved locale's font and its line-box variants, with their own fallbacks,
        /// the plan's global fallbacks and the weight faces of <see cref="FontsPlan.Faces"/>. Twins keep their GUIDs, so <c>DesignFonts.uss</c> never needs a re-import for them.
        /// </summary>
        internal static FontTwinGenerator.TwinRun EnsureTwins(FontsPlan plan)
        {
            var run = new FontTwinGenerator.TwinRun(plan.Globals) { Faces = plan.Faces };
            foreach (var locale in plan.Locales)
                if (plan.Fonts.TryGetValue(locale, out var font))
                {
                    FontTwinGenerator.GetOrCreateTwin(font.Primary, plan.TwinFolder, run);
                    foreach (var box in plan.LineBoxes) FontTwinGenerator.GetOrCreateTwin(font.Primary, plan.TwinFolder, run, box);
                }
            // plain twins at their smallest (atlas pages sized to their glyphs, their own glyphs' font features), variants linked
            TwinAtlas.Maintain(run);
            return run;
        }
    }
}
