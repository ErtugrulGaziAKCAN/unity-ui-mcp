using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using TMPro;
using UnityEditor;

namespace DesignUi.Editor
{
    /// <summary>
    /// Deletes the font twins nothing uses any more: a face no text style and no compiled screen renders (weights an older
    /// package made twins of), a line box the text-style table no longer has, a twin of a TMP font asset no locale resolves
    /// to now. Kit sync and every import run it after their twins are current.
    /// <para>The twins kept are those of every profile whose <c>fontTwinFolder</c> is this one, each planned as its kit sync
    /// and imports make them (the locales' fonts, their fallbacks and weight faces of the faces the kit's text styles and the
    /// compiled screens use, plain and per line box of the kit's text-style table and its text-size steps and of the compiled
    /// screens' manifests), plus the twins of
    /// the run that just ran. Only twin files directly in the folder are candidates (<see cref="TwinPlayGuard.IsTwin"/>), each
    /// deleted on its own (AssetDatabase.DeleteAsset). When a profile sharing the folder cannot be planned, nothing is
    /// deleted and the reason is returned.</para>
    /// </summary>
    internal static class TwinPrune
    {
        internal sealed class Result
        {
            public readonly List<string> Deleted = new List<string>();
            /// <summary>Why nothing was deleted, or null.</summary>
            public string Skipped;
        }

        /// <summary>
        /// The twins kept for <paramref name="profile"/> (its <paramref name="plan"/> and the run that just ran, with the line
        /// boxes of its kit's table too) and for the profiles sharing its folder; deletes the rest.
        /// </summary>
        internal static Result Run(DesignUiProfile profile, FontMap.FontsPlan plan, FontTwinGenerator.TwinRun run, string kitDir = null)
        {
            kitDir = kitDir ?? profile?.kitDir;
            var result = new Result();
            var folder = Folder(profile?.fontTwinFolder);
            if (folder == null || !AssetDatabase.IsValidFolder(folder)) return result;
            var keep = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (run != null)
                foreach (var t in run.Twins.Values)
                    if (t != null) keep.Add(AssetDatabase.GetAssetPath(t));
            if (plan != null)
            {
                keep.UnionWith(Paths(plan));
                // an export carries the text-style table it was made with; the kit's own table may have more line boxes
                var styles = !string.IsNullOrEmpty(kitDir) ? Path.Combine(kitDir, KitTextStyles.FileName) : null;
                if (styles != null && File.Exists(styles))
                {
                    var boxes = plan.LineBoxes;
                    plan.LineBoxes = FontMap.ProfileLineBoxes(ScreenCompiler.ScaledLineBoxes(KitTextStyles.LineBoxesOf(styles), profile.textSizes), profile);
                    try { keep.UnionWith(Paths(plan)); }
                    finally { plan.LineBoxes = boxes; }
                }
                // and the line boxes the compiled screens were made with (an export's own table may have had others)
                var screenBoxes = ScreenLineBoxes(profile);
                if (screenBoxes.Count > 0)
                {
                    var boxes = plan.LineBoxes;
                    plan.LineBoxes = FontMap.ProfileLineBoxes(screenBoxes, profile);
                    try { keep.UnionWith(Paths(plan)); }
                    finally { plan.LineBoxes = boxes; }
                }
            }
            var profiles = new List<DesignUiProfile>();
            foreach (var guid in AssetDatabase.FindAssets("t:" + nameof(DesignUiProfile)))
            {
                var p = AssetDatabase.LoadAssetAtPath<DesignUiProfile>(AssetDatabase.GUIDToAssetPath(guid));
                if (p != null && p != profile && Folder(p.fontTwinFolder) == folder) profiles.Add(p);
            }
            foreach (var p in profiles)
            {
                var planned = Planned(p, out var why);
                if (planned == null)
                {
                    result.Skipped = "unused font twins were not removed: the twins of profile '" + AssetDatabase.GetAssetPath(p) + "' cannot be planned (" + why + ")";
                    return result;
                }
                keep.UnionWith(planned);
            }
            var stale = Directory.GetFiles(folder, "*.asset", SearchOption.TopDirectoryOnly)
                .Select(f => f.Replace('\\', '/')).Where(TwinPlayGuard.IsTwin).Where(f => !keep.Contains(f))
                .OrderBy(f => f, StringComparer.Ordinal).ToList();
            // variants before the twins whose glyphs they share
            foreach (var path in stale.OrderBy(f => IsVariant(f) ? 0 : 1).ThenBy(f => f, StringComparer.Ordinal))
                if (AssetDatabase.DeleteAsset(path)) result.Deleted.Add(path);
            return result;
        }

        static bool IsVariant(string path) => System.Text.RegularExpressions.Regex.IsMatch(path, @" r\d+s\d+(p\d+)?(x\d+(p\d+)?)?\.asset$");

        static string Folder(string f)
        {
            var folder = (f ?? "").Replace('\\', '/').Trim().TrimEnd('/');
            return folder.Length == 0 ? null : folder;
        }

        /// <summary>
        /// The twin paths a profile's kit sync and imports keep (see the class summary), without loading or writing a twin; null
        /// with the reason when its fonts cannot be planned.
        /// </summary>
        internal static HashSet<string> Planned(DesignUiProfile profile, out string why)
        {
            why = null;
            FontMap.FontsPlan plan;
            try { plan = FontMap.Plan(profile, FontMap.ResolverFor(profile)); }
            catch (FontSetupException e) { why = e.Message; return null; }
            if (plan.Errors.Count > 0) { why = plan.Errors[0]; return null; }
            var styles = !string.IsNullOrEmpty(profile.kitDir) ? Path.Combine(profile.kitDir, KitTextStyles.FileName) : null;
            var kitBoxes = styles != null && File.Exists(styles) ? KitTextStyles.LineBoxesOf(styles) : new FontTwinGenerator.LineBox[0];
            plan.LineBoxes = FontMap.ProfileLineBoxes(ScreenCompiler.ScaledLineBoxes(kitBoxes, profile.textSizes).Concat(ScreenLineBoxes(profile))
                .GroupBy(b => b.Key).Select(g => g.First()), profile);
            plan.Faces = FontMap.ProfileFaces(profile, styles);
            return Paths(plan);
        }

        /// <summary>The line boxes every compiled screen of the profile records in its manifest (<see cref="GeneratedManifest.lineBoxes"/>).</summary>
        internal static List<FontTwinGenerator.LineBox> ScreenLineBoxes(DesignUiProfile profile)
        {
            var boxes = new Dictionary<string, FontTwinGenerator.LineBox>(StringComparer.Ordinal);
            var outFolder = profile?.outputFolder?.Replace('\\', '/').TrimEnd('/');
            if (string.IsNullOrEmpty(outFolder) || !Directory.Exists(outFolder)) return boxes.Values.ToList();
            foreach (var dir in Directory.GetDirectories(outFolder))
            {
                GeneratedManifest m;
                try { m = GeneratedManifest.Load(GeneratedManifest.Combine(dir.Replace('\\', '/'), ScreenCompiler.ManifestFileName)); }
                catch (InvalidDataException) { continue; }
                foreach (var entry in m?.lineBoxes ?? new string[0])
                {
                    var parts = (entry ?? "").Split('/');
                    if (parts.Length != 2 ||
                        !double.TryParse(parts[0], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var size) ||
                        !double.TryParse(parts[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var line)) continue;
                    var box = FontTwinGenerator.LineBox.For(size, line);
                    if (box != null) boxes[box.Key] = box;
                }
            }
            return boxes.Values.OrderBy(b => b.Key, StringComparer.Ordinal).ToList();
        }

        /// <summary>A line box as a manifest records it: <c>fontSize/lineHeight</c> (CSS px, invariant culture).</summary>
        internal static string LineBoxName(FontTwinGenerator.LineBox box) =>
            box.FontSize.ToString("R", System.Globalization.CultureInfo.InvariantCulture) + "/" + box.LineHeight.ToString("R", System.Globalization.CultureInfo.InvariantCulture);

        /// <summary>The paths of the twins a run of <paramref name="plan"/> makes (<see cref="FontTwinGenerator.GetOrCreateTwin"/>'s reach).</summary>
        internal static HashSet<string> Paths(FontMap.FontsPlan plan)
        {
            var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var run = new FontTwinGenerator.TwinRun(plan.Globals) { Faces = plan.Faces };
            var visited = new HashSet<TMP_FontAsset>();
            void Visit(TMP_FontAsset f)
            {
                if (f == null || !visited.Add(f)) return;
                paths.Add(FontTwinGenerator.TwinPath(f, plan.TwinFolder));
                foreach (var box in plan.LineBoxes) paths.Add(FontTwinGenerator.TwinPath(f, plan.TwinFolder, box));
                var weights = f.fontWeightTable ?? new TMP_FontWeightPair[0];
                for (int i = 0; i < weights.Length; i++)
                {
                    if (weights[i].regularTypeface != null && i != 4 && run.Wants(i * 100, false)) Visit(weights[i].regularTypeface);
                    if (weights[i].italicTypeface != null && run.Wants(i * 100, true)) Visit(weights[i].italicTypeface);
                }
                var globals = run.GlobalChain.Contains(f) ? Enumerable.Empty<TMP_FontAsset>() : run.Globals;
                foreach (var g in (f.fallbackFontAssetTable ?? new List<TMP_FontAsset>()).Concat(globals))
                {
                    if (g == null || g == f || (g.fontWeightTable ?? new TMP_FontWeightPair[0]).Any(w => w.regularTypeface == f || w.italicTypeface == f)) continue;
                    Visit(g);
                }
            }
            foreach (var locale in plan.Locales)
                if (plan.Fonts.TryGetValue(locale, out var font)) Visit(font.Primary);
            return paths;
        }
    }
}
