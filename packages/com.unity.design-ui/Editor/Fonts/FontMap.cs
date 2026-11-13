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
    /// swapping that class on the root switches the font of every text below it.
    /// </summary>
    public static class FontMap
    {
        public const string FileName = "DesignFonts.uss";
        public const string LocaleClassPrefix = "locale-";

        static readonly Regex LocaleCode = new Regex("^[A-Za-z0-9]+([_-][A-Za-z0-9]+)*$", RegexOptions.Compiled);

        /// <summary>The project's resolver: the profile's per-locale fonts over TMP Settings' default font and global fallbacks.</summary>
        public static IFontResolver DefaultResolver(DesignUiProfile p) => new ProfileLocaleFontResolver(p, new TmpSettingsFontResolver());

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
                        used.Add(d.Value.Substring(prefix.Length, d.Value.Length - prefix.Length - 1));
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

        /// <summary>DesignFonts.uss: per resolved locale, every family's variable points at the locale's twin.</summary>
        internal static string WriteUss(FontsPlan plan)
        {
            var sb = new StringBuilder();
            sb.Append(UssWriter.Header).Append('\n');
            foreach (var locale in plan.Locales)
            {
                if (!plan.Fonts.TryGetValue(locale, out var font)) continue;
                var url = Url(FontTwinGenerator.TwinPath(font.Primary, plan.TwinFolder));
                sb.Append("\n.").Append(LocaleClass(locale)).Append(" {\n");
                foreach (var slug in plan.Families.Keys) sb.Append("    --font-").Append(slug).Append(": ").Append(url).Append(";\n");
                sb.Append("}\n");
            }
            return sb.ToString();
        }

        /// <summary>
        /// Creates or updates the twin of every resolved locale's font, with its own fallbacks, the plan's global fallbacks
        /// and its weight faces. Twins keep their GUIDs, so <c>DesignFonts.uss</c> never needs a re-import for them.
        /// </summary>
        internal static FontTwinGenerator.TwinRun EnsureTwins(FontsPlan plan)
        {
            var run = new FontTwinGenerator.TwinRun(plan.Globals);
            foreach (var locale in plan.Locales)
                if (plan.Fonts.TryGetValue(locale, out var font))
                    FontTwinGenerator.GetOrCreateTwin(font.Primary, plan.TwinFolder, run);
            return run;
        }
    }
}
