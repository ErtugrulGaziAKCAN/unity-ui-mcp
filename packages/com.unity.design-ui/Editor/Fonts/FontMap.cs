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
        /// asset when it is set (a locale it gives no font for falls back to <see cref="DefaultResolver"/>), else DefaultResolver.
        /// Throws <see cref="FontSetupException"/> when the field references an asset that no longer loads; a resolver that
        /// throws is reported the same way when it is asked.
        /// </summary>
        public static IFontResolver ResolverFor(DesignUiProfile p)
        {
            if (p == null) throw new ArgumentNullException(nameof(p));
            if (p.fontResolver != null) return new ProjectFontResolver(p.fontResolver, DefaultResolver(p));
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
        /// primary twins, plain and line-box variants, with their kerning pairs (<see cref="DesignUi.DesignText.Prepare"/>, which
        /// also covers the weight faces and, for missing characters, the fallbacks), and saves the twins that gained characters.
        /// Without it the first layout of a text whose glyphs are new to a dynamic twin is unkerned (docs/findings/text-ink.md).
        /// Returns the characters no font of a locale's chain has. <paramref name="onlyLocale"/> limits it to one resolved
        /// locale (a locale's own translations).
        /// </summary>
        internal static string PrepareTwins(FontsPlan plan, FontTwinGenerator.TwinRun run, IEnumerable<string> strings, string onlyLocale = null)
        {
            var text = string.Concat((strings ?? Enumerable.Empty<string>()).Where(s => !string.IsNullOrEmpty(s)));
            if (text.Length == 0) return "";
            var all = run.Twins.Values.Where(t => t != null).Distinct().ToList();
            var before = all.ToDictionary(t => t, t => t.characterTable.Count);
            var missing = new System.Text.StringBuilder();
            foreach (var locale in plan.Locales)
            {
                if (onlyLocale != null && locale != onlyLocale) continue;
                if (!plan.Fonts.TryGetValue(locale, out var font)) continue;
                foreach (var twin in run.Twins.Where(kv => kv.Key.Item1 == font.Primary && kv.Value != null).Select(kv => kv.Value))
                    foreach (var c in DesignUi.DesignText.Prepare(twin, text)) if (missing.ToString().IndexOf(c) < 0) missing.Append(c);
            }
            foreach (var t in all)
                if (t.characterTable.Count != before[t])
                {
                    FontTwinGenerator.StoreSubAssets(t); // a new atlas page belongs in the twin's file too
                    UnityEditor.EditorUtility.SetDirty(t);
                    UnityEditor.AssetDatabase.SaveAssetIfDirty(t);
                }
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
            var steps = (textSizes ?? new DesignUi.DesignTextSize[0]).Where(t => t != null).Select(t => t.Clone()).ToArray();
            var set = AssetDatabase.LoadAssetAtPath<DesignUi.DesignFontSet>(path);
            if (set == null && System.IO.File.Exists(path))
                throw new FontSetupException("'" + path + "' is in the way of the generated font set: it is not a DesignFontSet. Move or delete it.");
            if (set != null && set.referenceLocale == plan.ReferenceLocale && (set.locales ?? new DesignUi.DesignFontSet.LocaleFonts[0]).Length == wanted.Length &&
                set.locales.Zip(wanted, (a, b) => a != null && a.locale == b.locale && (a.fonts ?? new UnityEngine.TextCore.Text.FontAsset[0]).SequenceEqual(b.fonts)).All(x => x) &&
                (set.textSizes ?? new DesignUi.DesignTextSize[0]).Length == steps.Length &&
                set.textSizes.Zip(steps, (a, b) => a != null && a.key == b.key && a.scale == b.scale).All(x => x))
                return null;
            bool created = set == null;
            if (created) set = UnityEngine.ScriptableObject.CreateInstance<DesignUi.DesignFontSet>();
            set.referenceLocale = plan.ReferenceLocale;
            set.locales = wanted;
            set.textSizes = steps;
            if (created) AssetDatabase.CreateAsset(set, path);
            else
            {
                EditorUtility.SetDirty(set);
                AssetDatabase.SaveAssetIfDirty(set);
            }
            return path;
        }

        /// <summary>
        /// Creates or updates the twin of every resolved locale's font and its line-box variants, with their own fallbacks,
        /// the plan's global fallbacks and their weight faces. Twins keep their GUIDs, so <c>DesignFonts.uss</c> never needs a re-import for them.
        /// </summary>
        internal static FontTwinGenerator.TwinRun EnsureTwins(FontsPlan plan)
        {
            var run = new FontTwinGenerator.TwinRun(plan.Globals);
            foreach (var locale in plan.Locales)
                if (plan.Fonts.TryGetValue(locale, out var font))
                {
                    FontTwinGenerator.GetOrCreateTwin(font.Primary, plan.TwinFolder, run);
                    foreach (var box in plan.LineBoxes) FontTwinGenerator.GetOrCreateTwin(font.Primary, plan.TwinFolder, run, box);
                }
            return run;
        }
    }
}
