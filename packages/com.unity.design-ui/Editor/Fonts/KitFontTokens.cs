using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using TMPro;

namespace DesignUi.Editor
{
    /// <summary>
    /// The kit's font tokens (<c>--font-*</c> in tokens.css) written from the synced fonts (kit sync): each token's first
    /// family becomes the family of a font TMP renders the profile's locales with, so designs that use the token pass lint
    /// (fonts.css declares exactly those families). Only the first family of a token's value changes; the rest of the line,
    /// its comment and every other line stay as they are. A token maps to a synced family when it names one (exactly), the
    /// TMP font asset of one, or one with the same USS name (letter case and punctuation aside); the kit's only font token
    /// maps to the reference locale's font (the kit's font, reported as a warning like every rewrite). Anything else is
    /// reported and kept. Tokens are the declarations of the file's <c>:root { … }</c> block, as design-export reads them.
    /// </summary>
    internal static class KitFontTokens
    {
        static readonly Regex Comment = new Regex(@"/\*[\s\S]*?(\*/|$)", RegexOptions.CultureInvariant);
        static readonly Regex Token = new Regex(@"(--font-[A-Za-z0-9_-]+)\s*:([^;{}]*);", RegexOptions.CultureInvariant);
        /// <summary>The tokens block as design-export reads it: from the first <c>:root {</c> to the file's last <c>}</c>.</summary>
        static readonly Regex Root = new Regex(@":root\s*\{([\s\S]*)\}", RegexOptions.CultureInvariant);

        public sealed class Result
        {
            /// <summary>The tokens file with the mapped families (the input when nothing changes).</summary>
            public string Text;
            /// <summary>Tokens rewritten to another family name (lint would fail on the old one).</summary>
            public readonly List<string> Changed = new List<string>();
            /// <summary>Tokens rewritten to the same family in another letter case (lint compares families ignoring case).</summary>
            public readonly List<string> Recased = new List<string>();
            /// <summary>Tokens no synced family maps to: left as they are.</summary>
            public readonly List<string> Unmapped = new List<string>();
            /// <summary>The names of the tokens that changed or cannot be mapped (<c>--font-ui</c>).</summary>
            public readonly List<string> Stale = new List<string>();
        }

        public static Result Apply(string css, FontMap.FontsPlan plan)
        {
            var result = new Result { Text = css ?? "" };
            if (string.IsNullOrEmpty(css)) return result;
            // tokens are matched outside comments only: a comment is blanked (same length) before matching
            var masked = new StringBuilder(css);
            foreach (Match c in Comment.Matches(css))
                for (int i = c.Index; i < c.Index + c.Length; i++)
                    if (masked[i] != '\n') masked[i] = ' ';
            var root = Root.Match(masked.ToString());
            if (!root.Success) return result;
            var block = root.Groups[1];
            var tokens = Token.Matches(masked.ToString()).Cast<Match>().Where(t => t.Index >= block.Index && t.Index + t.Length <= block.Index + block.Length).ToList();
            if (tokens.Count == 0) return result;

            var fonts = plan.Locales.Where(plan.Chains.ContainsKey).SelectMany(l => plan.Chains[l]).Where(f => f != null).Distinct().ToList();
            var families = plan.Families.Values.Distinct().ToList();
            var text = new StringBuilder(css);
            // replace from the end, so earlier indices stay valid
            foreach (var m in Enumerable.Reverse(tokens))
            {
                var name = m.Groups[1].Value;
                var value = m.Groups[2];
                if (!SplitFirstFamily(value.Value, out var family, out var lead, out var rest)) continue;
                if (families.Contains(family, StringComparer.Ordinal)) continue;
                var target = Map(family, plan, fonts, tokens.Count == 1, out var why);
                if (target == null)
                {
                    result.Unmapped.Insert(0, "tokens.css " + name + " names \"" + family + "\", which no synced font has (synced families: " +
                                              string.Join(", ", families.Select(f => "\"" + f + "\"")) + "): set it to one of them. Designs that use it fail lint (U-CSS-010).");
                    result.Stale.Insert(0, name);
                    continue;
                }
                // what surrounds the family comes from the file itself (the matched copy has its comments blanked)
                var original = css.Substring(value.Index, value.Length);
                var replaced = original.Substring(0, lead.Length) + "\"" + CssString(target) + "\"" + original.Substring(original.Length - rest.Length);
                text.Remove(value.Index, value.Length).Insert(value.Index, replaced);
                result.Stale.Insert(0, name);
                if (string.Equals(family, target, StringComparison.OrdinalIgnoreCase))
                    result.Recased.Insert(0, "tokens.css " + name + " written as \"" + target + "\" (was \"" + family + "\"), the synced family's own letter case");
                else
                    result.Changed.Insert(0, "tokens.css " + name + " was \"" + family + "\", which no synced font has: written as \"" + target + "\", " + why + ". " +
                                             "Designs and design systems that copied the old value fail lint (U-CSS-010) until they use the new one; " +
                                             "run design-export kit build to refresh RULES.md.");
            }
            result.Text = text.ToString();
            return result;
        }

        /// <summary>The synced family a token's family stands for, and why; null when none does.</summary>
        static string Map(string family, FontMap.FontsPlan plan, List<TMP_FontAsset> fonts, bool onlyToken, out string why)
        {
            var byAsset = fonts.Where(f => string.Equals(f.name, family, StringComparison.OrdinalIgnoreCase))
                .Select(f => f.faceInfo.familyName).Where(n => !string.IsNullOrWhiteSpace(n)).Distinct().ToList();
            if (byAsset.Count == 1)
            {
                why = "the family of the TMP font asset '" + fonts.First(f => string.Equals(f.name, family, StringComparison.OrdinalIgnoreCase)).name + "'";
                return byAsset[0];
            }
            string slug = null;
            try { slug = StyleMapper.FamilyNameSlug(family); }
            catch (UnsupportedStyleException) { }
            if (slug != null && plan.Families.TryGetValue(slug, out var same))
            {
                why = "the synced family with the same USS name (--font-" + slug + ")";
                return same;
            }
            if (onlyToken && plan.Fonts.TryGetValue(plan.ReferenceLocale, out var reference) && !string.IsNullOrWhiteSpace(reference.Primary.faceInfo.familyName))
            {
                why = "the family of the reference locale's font ('" + plan.ReferenceLocale + "': TMP font asset '" + reference.Primary.name + "'), as the kit's only font token";
                return reference.Primary.faceInfo.familyName;
            }
            why = null;
            return null;
        }

        /// <summary>
        /// Splits a token value (<c> "Inter UI", sans-serif</c>) into its first family (unquoted, escapes resolved), the
        /// whitespace before it and everything after it; false when it has none.
        /// </summary>
        static bool SplitFirstFamily(string value, out string family, out string lead, out string rest)
        {
            var v = value.TrimStart();
            lead = value.Substring(0, value.Length - v.Length);
            family = rest = null;
            if (v.Length == 0) return false;
            if (v[0] == '"' || v[0] == '\'')
            {
                var quote = v[0];
                var sb = new StringBuilder();
                int i = 1;
                for (; i < v.Length && v[i] != quote; i++)
                {
                    if (v[i] == '\\' && i + 1 < v.Length) i++;
                    sb.Append(v[i]);
                }
                if (i >= v.Length) return false; // unterminated string: not a family this can rewrite
                family = sb.ToString().Trim();
                rest = v.Substring(i + 1);
            }
            else
            {
                var comma = v.IndexOf(',');
                var segment = comma < 0 ? v : v.Substring(0, comma);
                var trimmed = segment.TrimEnd();
                family = Regex.Replace(trimmed, @"\s+", " ");
                rest = segment.Substring(trimmed.Length) + (comma < 0 ? "" : v.Substring(comma));
            }
            return family.Length > 0;
        }

        static string CssString(string s) => (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "").Replace("\r", "");
    }
}
