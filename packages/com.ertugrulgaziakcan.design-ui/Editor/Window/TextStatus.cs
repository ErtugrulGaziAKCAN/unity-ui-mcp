using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using TMPro;
using UnityEditor;
using UnityEngine;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using TextCorePopulation = UnityEngine.TextCore.Text.AtlasPopulationMode;

namespace DesignUi.Editor
{
    /// <summary>
    /// The window's Text row, checked without writing anything: whether the kit's fonts are what a kit sync would write now
    /// (<c>fonts.json</c>, the font files, the profile's values in <c>kit.config.json</c>), whether every UI Toolkit twin
    /// a kit sync or import makes exists with its TMP font's current settings, and whether the generated
    /// <c>DesignFonts.asset</c> exists.
    /// </summary>
    internal sealed class TextStatus
    {
        public bool KitCurrent;
        public string Kit = "";
        public bool TwinsCurrent;
        public string Twins = "";
        public bool FontSetExists;
        public string FontSet = "";
        /// <summary>Which font resolver kit sync and the compile use (<see cref="FontMap.ResolverDescription"/>).</summary>
        public string Resolver = "";
        /// <summary>The faces that get twins (the kit's text styles'; an import adds a design's own) and how many do not.</summary>
        public string Faces = "";

        const string RunKitSync = " Run Kit Sync.";

        public static TextStatus Check(DesignUiProfile profile, string kitDir)
        {
            var s = new TextStatus();
            if (profile == null)
            {
                s.Kit = s.Twins = s.FontSet = s.Resolver = s.Faces = "no DesignUiProfile (create one above)";
                return s;
            }
            var folder = (profile.outputFolder ?? "").Replace('\\', '/').TrimEnd('/');
            var setPath = folder + "/" + DesignFontSet.FileName;
            s.FontSetExists = folder.Length > 0 && AssetDatabase.LoadAssetAtPath<DesignFontSet>(setPath) != null;
            s.FontSet = s.FontSetExists ? setPath : "not generated yet: the first import writes " + setPath;

            s.Resolver = FontMap.ResolverDescription(profile);
            FontMap.FontsPlan plan;
            IFontResolver resolver = null;
            try { plan = FontMap.Plan(profile, resolver = FontMap.ResolverFor(profile)); }
            catch (FontSetupException e)
            {
                s.Kit = s.Twins = e.Message;
                return s;
            }
            if (FontMap.FallbackNote(resolver) is string fellBack) s.Resolver += "; " + fellBack;
            var problems = plan.Errors.Concat(plan.Missing.Select(l => "Font not resolvable: " + FontMap.NoFont(l))).ToList();
            if (problems.Count > 0)
            {
                s.Kit = s.Twins = problems[0];
                return s;
            }
            var boxes = s.CheckKit(profile, plan, kitDir, out var stylesPath);
            plan.Faces = FontMap.ProfileFaces(profile, stylesPath);
            var chosen = FontMap.ChosenFaces(plan);
            var skipped = FontMap.SkippedFaces(plan);
            s.Faces = string.Join(", ", chosen) + (skipped > 0 ? " (" + skipped + " more face" + (skipped == 1 ? "" : "s") + " in the weight tables get no twin: no text style or compiled screen uses them)" : "");
            s.CheckTwins(plan, boxes);
            return s;
        }

        /// <summary>Compares the kit with what a kit sync would write; returns the kit's line boxes for the twin check.</summary>
        IReadOnlyList<FontTwinGenerator.LineBox> CheckKit(DesignUiProfile profile, FontMap.FontsPlan plan, string kitDir, out string stylesPath)
        {
            stylesPath = null;
            var boxes = (IReadOnlyList<FontTwinGenerator.LineBox>)new FontTwinGenerator.LineBox[0];
            if (string.IsNullOrEmpty(kitDir))
            {
                Kit = "no kit folder (kitDir in design-ui.config.json or the profile)";
                return boxes;
            }
            if (!Path.IsPathRooted(kitDir)) kitDir = Path.GetFullPath(Path.Combine(DesignUiBridgeSettings.ProjectRoot, kitDir));
            JObject config;
            try { config = JObject.Parse(File.ReadAllText(Path.Combine(kitDir, KitSync.ConfigFileName))); }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is JsonException)
            {
                Kit = "cannot read " + KitSync.ConfigFileName + " in " + kitDir + ": " + e.Message;
                return boxes;
            }
            string Rel(string key, string fallback) => config[key]?.Type == JTokenType.String ? config.Value<string>(key) : fallback;
            var fontsCss = Rel("fontsCss", "fonts/fonts.css");
            var tokensCss = Path.Combine(kitDir, Rel("tokensCss", "tokens.css"));
            var styles = Path.Combine(kitDir, Rel("textStyles", "text-styles.json"));
            stylesPath = styles;
            try { if (File.Exists(styles)) boxes = KitTextStyles.LineBoxesOf(styles); }
            catch (Exception e) when (e is IOException || e is JsonException) { }

            var stale = new List<string>();
            // fonts.json: locale → families in TMP's search order
            var fontsJson = Path.Combine(kitDir, Regex.Replace(fontsCss, @"\.css$", "", RegexOptions.IgnoreCase) + ".json");
            var expected = new JObject();
            foreach (var locale in plan.Locales.OrderBy(l => l, StringComparer.Ordinal))
                if (plan.LocaleFamilies.TryGetValue(locale, out var families)) expected[locale] = new JArray(families.Cast<object>().ToArray());
            try
            {
                if (!JToken.DeepEquals(JObject.Parse(File.ReadAllText(fontsJson)), expected)) stale.Add(Path.GetFileName(fontsJson) + " lists other families");
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is JsonException) { stale.Add(Path.GetFileName(fontsJson) + " is missing"); }

            // the font files: byte for byte the project's source fonts
            var fontsDir = Path.GetDirectoryName(Path.Combine(kitDir, fontsCss));
            int files = 0;
            foreach (var source in KitFaces(plan).Select(SourceOf).Distinct())
            {
                if (source.StartsWith("!", StringComparison.Ordinal)) { stale.Add(source.Substring(1)); continue; }
                files++;
                var copy = Path.Combine(fontsDir, Path.GetFileName(source));
                if (!File.Exists(copy)) stale.Add(Path.GetFileName(source) + " is missing");
                else if (!SameBytes(Path.GetFullPath(source), copy)) stale.Add(Path.GetFileName(source) + " differs from " + source);
            }

            // the font tokens name the synced families (kit sync writes them; a token it cannot map stays stale)
            try
            {
                if (File.Exists(tokensCss))
                {
                    var tokens = KitFontTokens.Apply(File.ReadAllText(tokensCss), plan);
                    if (tokens.Stale.Count > 0) stale.Add(Path.GetFileName(tokensCss) + ": " + string.Join(", ", tokens.Stale) + " name" + (tokens.Stale.Count == 1 ? "s" : "") + " no synced font family");
                }
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { stale.Add(Path.GetFileName(tokensCss) + " cannot be read: " + e.Message); }

            // the profile's values the sync writes into kit.config.json
            var viewports = KitSync.ViewportsJson(profile);
            if (!JToken.DeepEquals(config["locales"], new JArray(plan.Locales.Cast<object>().ToArray())) ||
                !JToken.DeepEquals(config["reference"], new JArray(profile.referenceResolution.x, profile.referenceResolution.y)) ||
                !JToken.DeepEquals(config["viewports"], viewports))
                stale.Add(KitSync.ConfigFileName + " has other locales, reference or viewports than the profile");

            KitCurrent = stale.Count == 0;
            Kit = KitCurrent
                ? "current (" + files + (files == 1 ? " font file" : " font files") + " in " + kitDir + ")"
                : "out of date: " + string.Join("; ", stale.Take(3)) + (stale.Count > 3 ? "; …" : "") + "." + RunKitSync;
            return boxes;
        }

        /// <summary>Every twin a kit sync makes: each font TMP searches for a locale, its fallbacks and weight faces, plain and per line box.</summary>
        void CheckTwins(FontMap.FontsPlan plan, IReadOnlyList<FontTwinGenerator.LineBox> boxes)
        {
            var missing = new List<string>();
            var outdated = new List<string>();
            int count = 0;
            foreach (var tmp in TwinFonts(plan, plan.Faces))
                foreach (var box in new FontTwinGenerator.LineBox[] { null }.Concat(boxes))
                {
                    string path;
                    try { path = FontTwinGenerator.TwinPath(tmp, plan.TwinFolder, box); }
                    catch (FontSetupException e)
                    {
                        Twins = e.Message;
                        return;
                    }
                    count++;
                    var twin = AssetDatabase.LoadAssetAtPath<FontAsset>(path);
                    if (twin == null) missing.Add(Path.GetFileName(path));
                    else if (!SameSettings(twin, tmp)) outdated.Add(Path.GetFileName(path));
                }
            TwinsCurrent = missing.Count == 0 && outdated.Count == 0;
            Twins = TwinsCurrent
                ? "current (" + count + " in " + plan.TwinFolder + ")"
                : string.Join("; ", new[]
                  {
                      missing.Count > 0 ? "missing: " + string.Join(", ", missing.Take(3)) + (missing.Count > 3 ? ", …" : "") : null,
                      outdated.Count > 0 ? "out of date: " + string.Join(", ", outdated.Take(3)) + (outdated.Count > 3 ? ", …" : "") : null,
                  }.Where(x => x != null)) + "." + RunKitSync;
        }

        /// <summary>The fonts of every locale's chain with their own fallbacks and the weight faces that get twins, without duplicates.</summary>
        static List<TMP_FontAsset> TwinFonts(FontMap.FontsPlan plan, ISet<(int weight, bool italic)> wanted)
        {
            var all = new List<TMP_FontAsset>();
            var queue = new Queue<TMP_FontAsset>(plan.Locales.Where(plan.Chains.ContainsKey).SelectMany(l => plan.Chains[l]));
            while (queue.Count > 0)
            {
                var f = queue.Dequeue();
                if (f == null || all.Contains(f)) continue;
                all.Add(f);
                foreach (var g in f.fallbackFontAssetTable ?? new List<TMP_FontAsset>()) queue.Enqueue(g);
                var table = f.fontWeightTable ?? new TMP_FontWeightPair[0];
                for (int i = 0; i < table.Length; i++)
                {
                    if (wanted == null || wanted.Contains((i * 100, false))) queue.Enqueue(table[i].regularTypeface);
                    if (wanted == null || wanted.Contains((i * 100, true))) queue.Enqueue(table[i].italicTypeface);
                }
            }
            return all;
        }

        /// <summary>The fonts whose files a kit sync copies: each locale's chain and the faces of their weight tables.</summary>
        static IEnumerable<TMP_FontAsset> KitFaces(FontMap.FontsPlan plan)
        {
            foreach (var locale in plan.Locales)
            {
                if (!plan.Chains.TryGetValue(locale, out var chain)) continue;
                foreach (var f in chain)
                {
                    if (f == null) continue;
                    yield return f;
                    var table = f.fontWeightTable ?? new TMP_FontWeightPair[0];
                    for (int i = 1; i < table.Length && i <= 9; i++)
                    {
                        if (table[i].regularTypeface != null) yield return table[i].regularTypeface;
                        if (table[i].italicTypeface != null) yield return table[i].italicTypeface;
                    }
                }
            }
        }

        /// <summary>The project path of the TMP font's source file, or "!" and the reason.</summary>
        static string SourceOf(TMP_FontAsset tmp)
        {
            try { return TmpSourceFont.GetSourceFontPath(tmp); }
            catch (FontSetupException e) { return "!" + e.Message; }
        }

        static bool SameBytes(string a, string b)
        {
            try
            {
                if (new FileInfo(a).Length != new FileInfo(b).Length) return false;
                return File.ReadAllBytes(a).SequenceEqual(File.ReadAllBytes(b));
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { return false; }
        }

        /// <summary>What the twin generator rebuilds a twin for: another source font or other atlas settings (a variant's pages are its twin's).</summary>
        static bool SameSettings(FontAsset twin, TMP_FontAsset tmp)
        {
            Font font;
            try { font = TmpSourceFont.GetSourceFont(tmp); }
            catch (FontSetupException) { return false; }
            return twin.sourceFontFile == font &&
                   twin.atlasPopulationMode == TextCorePopulation.Dynamic &&
                   Mathf.RoundToInt(twin.faceInfo.pointSize) == Mathf.RoundToInt(tmp.faceInfo.pointSize) &&
                   twin.atlasPadding == tmp.atlasPadding &&
                   twin.atlasRenderMode == FontTwinGenerator.TwinRenderMode(tmp) &&
                   // pages sized to the twin's glyphs (TwinAtlas), never larger than the TMP asset's atlas
                   twin.atlasWidth > 0 && twin.atlasWidth <= tmp.atlasWidth &&
                   twin.atlasHeight > 0 && twin.atlasHeight <= tmp.atlasHeight &&
                   twin.isMultiAtlasTexturesEnabled;
        }
    }
}
