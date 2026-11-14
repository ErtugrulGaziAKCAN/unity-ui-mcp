using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.TextCore;
using UnityEngine.TextCore.LowLevel;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using TextCorePopulation = UnityEngine.TextCore.Text.AtlasPopulationMode;

namespace DesignUi.Editor
{
    /// <summary>
    /// UI Toolkit font twins (spec 6; docs/findings/m0.md, font twin). UI Toolkit text needs a TextCore <see cref="FontAsset"/>; a
    /// <see cref="TMP_FontAsset"/> cannot be referenced from USS. The twin of a TMP font asset is
    /// <c>&lt;folder&gt;/&lt;tmp.name&gt; UITK.asset</c>, made from the same source font with the TMP asset's sampling
    /// point size, padding and atlas size, always dynamic (the advanced text generator accepts no static font asset) with
    /// multi-atlas on. The render mode is the TMP asset's when it is an SDF or colour mode; a bitmap mode (SMOOTH, RASTER)
    /// becomes SDFAA, the mode the fidelity measurements used, and is logged.
    /// <para>Fallbacks follow TMP's search order: the TMP asset's own fallback list, then the global fallbacks (TMP
    /// Settings' list), as twins, without duplicates or the twin itself. TMP searches the global fallbacks once, after
    /// the whole chain of the font it started from, so a global fallback and the fonts in its own fallback chain list
    /// only their own fallbacks: with two or more global fallbacks they would otherwise list each other (a cycle). The
    /// weight table is mirrored as twins. The advanced text generator rejects any cycle through fallbacks and weight tables
    /// together, so the twins leave out a face's own entry, the regular face at 400, a fallback to a font whose weight table
    /// lists the face, and any other entry leading back to a twin being made (docs/findings/advanced-text.md).</para>
    /// <para>Idempotent: an up-to-date twin is returned as it is. Changed fallbacks or weights update the twin; changed
    /// atlas settings or source font rebuild it in place, keeping its GUID, so every reference to it survives. Tables are
    /// written through SerializedObject, so the font asset refreshes its lookup and native data (OnValidate). Writes use
    /// asset-specific saves only.</para>
    /// <para>Line-box variants (<see cref="LineBox"/>), one per font size and line height of the kit's text styles: CSS
    /// sets a line box of <c>line-height</c> and centres the font's ascent + descent in it (half-leading); UI Toolkit has no
    /// line height and lays a line out at the face's line height with the baseline at its ascent. The variant twin of a style
    /// is the same font with <c>faceInfo.lineHeight = (lineHeight / fontSize) × pointSize</c> and its ascent line where
    /// Chromium lays out that style's baseline (<see cref="LineBox.Baseline"/>), the descent line one line height below, so a
    /// line of that size is exactly <c>lineHeight</c> tall in UI Toolkit with every baseline where Chromium puts it. Glyph
    /// metrics are untouched. A variant falls back to the same size's variants of the fallbacks, and its weight table holds
    /// the same size's variants of the weight faces.</para>
    /// <para>Scaled-viewport variants (<see cref="LineBox.AtDeviceScale"/>): Unity sets text at whole device pixels (halves up), so
    /// at a scaled viewport's panel scale, where a style's size is a fraction of a device pixel, the variant made for that scale
    /// has <c>faceInfo.scale = exact / rounded</c> device size: glyphs, advances and the line box come out at the design's size
    /// (measured on 6000.3, docs/findings/viewport-classes.md). <c>DesignFonts.uss</c> selects them under the screen root's
    /// <see cref="DesignUi.DesignViewportScales"/> class.</para>
    /// </summary>
    public static class FontTwinGenerator
    {
        public const string Suffix = " UITK";

        /// <summary>
        /// The line box of a kit text style: its CSS font size and line height (px), with its key (twin name and USS variable
        /// suffix): <c>r</c>, the ratio <c>lineHeight / fontSize</c> to 4 decimals without the point, <c>s</c> and the font
        /// size with a decimal point written <c>p</c> (16/20 → <c>r125s16</c>, 12/16 → <c>r13333s12</c>). Sizes are whatever the
        /// text-style table holds (<see cref="Of"/>); kit sync checks that every style is whole device pixels at every viewport
        /// scale. One variant per size, not per ratio: where Chromium puts the baseline depends on the font's ascent and
        /// descent rounded at the font size (<see cref="Baseline"/>), so two sizes of one ratio need different ascents.
        /// </summary>
        public sealed class LineBox
        {
            /// <summary>The twin name suffix: <see cref="BaseKey"/>, and for a scaled-viewport variant <c>x</c> and its scale's key.</summary>
            public readonly string Key;
            /// <summary>The key of the style's line box (the USS variable suffix), the same for its scaled-viewport variants.</summary>
            public readonly string BaseKey;
            /// <summary><c>lineHeight / fontSize</c>.</summary>
            public readonly double Ratio;
            /// <summary>CSS font size and line height of the style (px).</summary>
            public readonly double FontSize, LineHeight;
            /// <summary>The panel scale a scaled-viewport variant is made for; null for the style's own variant.</summary>
            public readonly double? DeviceScale;
            /// <summary>
            /// The variant's <c>faceInfo.scale</c>: the exact device size over the size Unity sets (<see cref="UnitySize"/>), 1 for
            /// the style's own variant.
            /// </summary>
            public readonly double FaceScale = 1;

            LineBox(double fontSize, double lineHeight, double? deviceScale = null)
            {
                FontSize = fontSize;
                LineHeight = lineHeight;
                Ratio = lineHeight / fontSize;
                BaseKey = KeyOf(fontSize, lineHeight);
                Key = BaseKey;
                if (deviceScale.HasValue)
                {
                    DeviceScale = deviceScale;
                    FaceScale = fontSize * deviceScale.Value / UnitySize(fontSize * deviceScale.Value);
                    Key = BaseKey + "x" + DesignUi.DesignViewportScales.Key(deviceScale.Value);
                }
            }

            /// <summary>The device font size UI Toolkit sets for an exact one: whole device pixels, halves up (measured on 6000.3: 7.5 → 8, 22.5 → 23).</summary>
            public static double UnitySize(double devicePx) => Math.Max(1, Math.Floor(devicePx + 0.5));

            /// <summary>
            /// The variant of this style's line box for text at panel scale <paramref name="scale"/> (a scaled viewport's), or null
            /// when the font size is whole device pixels there (the style's own variant is exact) or this is already one.
            /// </summary>
            public LineBox AtDeviceScale(double scale)
            {
                if (DeviceScale.HasValue || !(scale > 0) || double.IsInfinity(scale)) return null;
                double px = FontSize * scale;
                return Math.Abs(px - Math.Round(px)) < 1e-6 ? null : new LineBox(FontSize, LineHeight, scale);
            }

            /// <summary><paramref name="boxes"/> and the variant of each at each of <paramref name="scales"/> where one is needed (each key once, ordered by key).</summary>
            public static IReadOnlyList<LineBox> WithDeviceScales(IEnumerable<LineBox> boxes, IEnumerable<double> scales)
            {
                var all = (boxes ?? Enumerable.Empty<LineBox>()).Where(b => b != null).ToList();
                var list = scales?.ToList() ?? new List<double>();
                return all.Concat(all.Where(b => !b.DeviceScale.HasValue).SelectMany(b => list.Select(b.AtDeviceScale)).Where(b => b != null))
                    .GroupBy(b => b.Key).Select(g => g.First()).OrderBy(b => b.Key, StringComparer.Ordinal).ToList();
            }

            static string Digits(double v) => Math.Round(v, 4).ToString("0.####", System.Globalization.CultureInfo.InvariantCulture);

            /// <summary>The key of a font size and line height: <c>r</c> + ratio digits, <c>s</c> + the size (decimal point as <c>p</c>).</summary>
            public static string KeyOf(double fontSize, double lineHeight) =>
                "r" + Digits(lineHeight / fontSize).Replace(".", "") + "s" + Digits(fontSize).Replace(".", "p");

            /// <summary>The line box of a font size and line height (CSS px), or null unless both are positive and finite.</summary>
            public static LineBox For(double fontSize, double lineHeight) =>
                fontSize > 0 && lineHeight > 0 && !double.IsInfinity(fontSize) && !double.IsInfinity(lineHeight) && !double.IsNaN(fontSize) && !double.IsNaN(lineHeight)
                    ? new LineBox(fontSize, lineHeight)
                    : null;

            /// <summary>One line box per distinct key of <paramref name="styles"/> (font size, line height), ordered by key.</summary>
            public static IReadOnlyList<LineBox> Of(IEnumerable<(double fontSize, double lineHeight)> styles) =>
                (styles ?? Enumerable.Empty<(double, double)>()).Select(s => For(s.fontSize, s.lineHeight)).Where(b => b != null)
                    .GroupBy(b => b.Key).Select(g => g.First()).OrderBy(b => b.Key, StringComparer.Ordinal).ToList();

            /// <summary>
            /// UI Toolkit ceils a text element's height, and the float arithmetic of an exact r × size line lands a hair above
            /// the whole pixel (measured on 6000.3: 21 px for a 20 px line box). The variant's line box is this fraction
            /// smaller (0.0002 px on a 20 px line), so n lines are exactly n × r × size tall.
            /// </summary>
            public const double Shrink = 1e-5;

            /// <summary>
            /// Chromium's first baseline below the line box top, in CSS px, for a font with <paramref name="face"/>'s ascent and
            /// descent (LayoutNG: the ascent and descent rounded at the font size, the half-leading floored;
            /// <c>floor((L − round(a·s) − round(d·s)) / 2) + round(a·s)</c>; measured on 396 Inter sizes and line heights,
            /// docs/findings/text-baselines.md). Further lines are one line height lower.
            /// </summary>
            public double Baseline(FaceInfo face)
            {
                double ascent = Math.Floor(face.ascentLine / face.pointSize * FontSize + 0.5);
                double descent = Math.Floor(-face.descentLine / face.pointSize * FontSize + 0.5);
                return Math.Floor((LineHeight - (ascent + descent)) / 2) + ascent;
            }

            /// <summary>The face of a variant: line height r × pointSize, ascent at Chromium's baseline, descent one line height below.</summary>
            public FaceInfo Face(FaceInfo face)
            {
                double target = Ratio * face.pointSize * (1 - Shrink);
                double ascent = Baseline(face) / FontSize * face.pointSize;
                face.lineHeight = (float)target;
                face.ascentLine = (float)ascent;
                face.descentLine = (float)(ascent - target);
                if (DeviceScale.HasValue) face.scale = (float)FaceScale;
                return face;
            }
        }

        /// <summary>The twin of <paramref name="tmp"/>, with TMP Settings' global fallbacks after its own.</summary>
        public static FontAsset GetOrCreateTwin(TMP_FontAsset tmp, string folder) =>
            GetOrCreateTwin(tmp, folder, new TwinRun(TmpSettingsFontResolver.GlobalFallbacks()));

        /// <summary>The twin of <paramref name="tmp"/> with the given global fallbacks after its own.</summary>
        internal static FontAsset GetOrCreateTwin(TMP_FontAsset tmp, string folder, IEnumerable<TMP_FontAsset> globals) =>
            GetOrCreateTwin(tmp, folder, new TwinRun(globals));

        /// <summary>The line-box variant twin of <paramref name="tmp"/> for a kit text style size, with TMP Settings' global fallbacks.</summary>
        public static FontAsset GetOrCreateTwin(TMP_FontAsset tmp, string folder, LineBox lineBox) =>
            GetOrCreateTwin(tmp, folder, new TwinRun(TmpSettingsFontResolver.GlobalFallbacks()), lineBox);

        /// <summary>
        /// The twin's asset path (<c>&lt;name&gt; UITK.asset</c>, a variant <c>&lt;name&gt; UITK &lt;key&gt;.asset</c>); throws
        /// <see cref="FontSetupException"/> when the folder is not inside Assets/.
        /// </summary>
        public static string TwinPath(TMP_FontAsset tmp, string folder, LineBox lineBox = null)
        {
            if (tmp == null) throw new ArgumentNullException(nameof(tmp));
            return CheckFolder(folder) + "/" + tmp.name + Suffix + (lineBox != null ? " " + lineBox.Key : "") + ".asset";
        }

        /// <summary>The twin's render mode: the TMP asset's, except bitmap modes (SMOOTH, RASTER), which become SDFAA.</summary>
        public static GlyphRenderMode TwinRenderMode(TMP_FontAsset tmp) => IsBitmap(tmp.atlasRenderMode) ? GlyphRenderMode.SDFAA : tmp.atlasRenderMode;

        static bool IsBitmap(GlyphRenderMode mode) =>
            mode == GlyphRenderMode.SMOOTH || mode == GlyphRenderMode.SMOOTH_HINTED || mode == GlyphRenderMode.RASTER || mode == GlyphRenderMode.RASTER_HINTED;

        internal static string BitmapNote(TMP_FontAsset tmp) =>
            "TMP font asset '" + tmp.name + "' renders in " + tmp.atlasRenderMode + "; its UI Toolkit twin uses SDFAA (the fidelity measurements used SDF, " +
            "and a bitmap atlas blurs when UI Toolkit scales text)";

        /// <summary>
        /// The face info the twin of <paramref name="tmp"/> has (the font engine at the twin's sampling size), without
        /// creating or touching any asset. The kit's text styles are checked against it before twins are written.
        /// </summary>
        internal static FaceInfo TwinFaceInfo(TMP_FontAsset tmp)
        {
            var font = TmpSourceFont.GetSourceFont(tmp);
            CheckSettings(tmp);
            FontEngine.InitializeFontEngine();
            if (FontEngine.LoadFontFace(font, SamplingSize(tmp)) != FontEngineError.Success)
                throw new FontSetupException(NoFace(tmp, font));
            return FontEngine.GetFaceInfo();
        }

        /// <summary>One generation pass: the global fallbacks, the twins made or checked (reused within the pass) and notes.</summary>
        internal sealed class TwinRun
        {
            public readonly IReadOnlyList<TMP_FontAsset> Globals;
            /// <summary>The global fallbacks and every font in their own fallback chains: their twins get no global fallbacks.</summary>
            public readonly HashSet<TMP_FontAsset> GlobalChain = new HashSet<TMP_FontAsset>();
            /// <summary>The twins of this pass by TMP asset and line-box key ("" for the plain twin).</summary>
            public readonly Dictionary<(TMP_FontAsset, string), FontAsset> Twins = new Dictionary<(TMP_FontAsset, string), FontAsset>();
            /// <summary>Each line-box variant of this pass with the plain twin it shares its glyphs with (<see cref="DesignUi.FontTwinLink"/>).</summary>
            public readonly Dictionary<FontAsset, FontAsset> Sources = new Dictionary<FontAsset, FontAsset>();
            /// <summary>The plain twins of this pass with their TMP font assets.</summary>
            public IEnumerable<(FontAsset twin, TMP_FontAsset tmp)> Plains =>
                Twins.Where(kv => kv.Key.Item2 == "" && kv.Value != null).Select(kv => (kv.Value, kv.Key.Item1));
            /// <summary>Render-mode substitutions and left-out fallback or weight entries of this pass, each once.</summary>
            public readonly List<string> Notes = new List<string>();
            /// <summary>The twins being made right now (the recursion's path): a table entry that leads back to one closes a cycle.</summary>
            public readonly HashSet<(TMP_FontAsset, string)> OnPath = new HashSet<(TMP_FontAsset, string)>();

            public void Note(string note)
            {
                if (!Notes.Contains(note)) Notes.Add(note);
            }
            /// <summary>The weight-table faces (weight, italic) that get twins; null: every face.</summary>
            public ISet<(int weight, bool italic)> Faces;

            public bool Wants(int weight, bool italic) => Faces == null || Faces.Contains((weight, italic));
            readonly Dictionary<string, TMP_FontAsset> _paths = new Dictionary<string, TMP_FontAsset>(StringComparer.OrdinalIgnoreCase);

            public TwinRun(IEnumerable<TMP_FontAsset> globals)
            {
                Globals = (globals ?? new TMP_FontAsset[0]).Where(f => f != null).Distinct().ToList();
                var queue = new Queue<TMP_FontAsset>(Globals);
                while (queue.Count > 0)
                {
                    var f = queue.Dequeue();
                    if (f == null || !GlobalChain.Add(f)) continue;
                    foreach (var own in f.fallbackFontAssetTable ?? new List<TMP_FontAsset>()) queue.Enqueue(own);
                }
            }

            public void Claim(string path, TMP_FontAsset tmp)
            {
                if (_paths.TryGetValue(path, out var other) && other != tmp)
                    throw new FontSetupException("TMP font assets '" + AssetDatabase.GetAssetPath(other) + "' and '" + AssetDatabase.GetAssetPath(tmp) +
                                                 "' have the same name, so their UI Toolkit twins would both be '" + path + "'. Rename one of them.");
                _paths[path] = tmp;
            }
        }

        internal static FontAsset GetOrCreateTwin(TMP_FontAsset tmp, string folder, TwinRun run, LineBox lineBox = null)
        {
            if (tmp == null) throw new ArgumentNullException(nameof(tmp));
            var key = (tmp, lineBox?.Key ?? "");
            if (run.Twins.TryGetValue(key, out var known)) return known;
            // a variant's face comes from the plain twin's (the font engine's metrics at the sampling size); it shares that
            // twin's glyphs and atlas (FontTwinLink) and keeps none of its own on disk
            var plain = lineBox != null ? GetOrCreateTwin(tmp, folder, run) : null;
            var face = lineBox != null ? lineBox.Face(plain.faceInfo) : (FaceInfo?)null;
            var path = TwinPath(tmp, folder, lineBox);
            run.Claim(path, tmp);
            var font = TmpSourceFont.GetSourceFont(tmp);
            CheckSettings(tmp);
            var mode = TwinRenderMode(tmp);
            if (mode != tmp.atlasRenderMode) run.Note(BitmapNote(tmp));

            var twin = AssetDatabase.LoadAssetAtPath<FontAsset>(path);
            if (twin == null && File.Exists(path))
                throw new FontSetupException("'" + path + "' is in the way of the UI Toolkit twin of TMP font asset '" + tmp.name + "': it is not a font asset. Move or delete it.");
            // a linked variant gets its own (empty) pages and tables back before its settings are compared or saved
            if (twin != null && lineBox != null) TwinLinks.Unlink(twin);
            var page = plain != null ? new Vector2Int(plain.atlasWidth, plain.atlasHeight) : TwinAtlas.InitialPage(tmp);
            bool built = false;
            if (twin == null)
            {
                twin = Create(tmp, font, mode, path, page);
                built = true;
            }
            else if (lineBox == null ? !SameSettings(twin, font, tmp, mode) : !SameVariantSettings(twin, font, tmp, mode) || !TwinLinks.IsEmpty(twin))
            {
                bool migrated = lineBox != null && SameVariantSettings(twin, font, tmp, mode);
                Rebuild(twin, tmp, font, mode, path, page);
                Debug.Log("Design UI: rebuilt the UI Toolkit font twin '" + path + "' in place (" +
                          (migrated ? "a line-box variant keeps no glyphs of its own: it shares those of '" + plain.name + "'" : "the source font or atlas settings of '" + tmp.name + "' changed") + ")", twin);
                built = true;
            }
            if (plain != null) run.Sources[twin] = plain;
            if (built && mode != tmp.atlasRenderMode) Debug.LogWarning(BitmapNote(tmp), twin);
            run.Twins[key] = twin; // before the recursion: fallback lists may form cycles
            run.OnPath.Add(key);

            // The advanced text generator accepts no cycle through fallback lists and weight tables together: it logs
            // "Circular reference detected" and leaves out every entry from which any cycle can be reached (so a script font
            // loses its Latin fallback, a regular face its bold face). TMP tables often have them: a face listing itself, a
            // bold face listing its regular face at 400 and falling back to it while the regular face lists the bold one. The
            // twins leave out what neither generator uses: a face's own entry, the regular face at 400 (never looked up in a
            // weight table) and a fallback to a font whose weight table lists this face (a weight face's own fallbacks count
            // only where it is the font of the text, which compiled screens never make it). Any other entry that leads back
            // to a twin being made now is left out too, and noted.
            bool IsWeightFaceOf(TMP_FontAsset f) =>
                (f.fontWeightTable ?? new TMP_FontWeightPair[0]).Any(w => w.regularTypeface == tmp || w.italicTypeface == tmp);
            FontAsset Entry(TMP_FontAsset f, string what)
            {
                if (f == null || f == tmp) return null;
                if (run.OnPath.Contains((f, lineBox?.Key ?? "")))
                {
                    run.Note("TMP font asset '" + tmp.name + "' " + what + " '" + f.name + "', which leads back to it: its UI Toolkit twin leaves that entry out " +
                             "(the advanced text generator rejects font cycles)");
                    return null;
                }
                return GetOrCreateTwin(f, folder, run, lineBox);
            }

            // the weight table's faces (index i is weight i × 100), those the run wants: the others get no twin
            var weights = tmp.fontWeightTable ?? new TMP_FontWeightPair[0];
            var regular = weights.Select((w, i) => w.regularTypeface != null && i != 4 && run.Wants(i * 100, false) ? Entry(w.regularTypeface, "lists at weight " + i * 100) : null).ToArray();
            var italic = weights.Select((w, i) => w.italicTypeface != null && run.Wants(i * 100, true) ? Entry(w.italicTypeface, "lists at weight " + i * 100 + " italic") : null).ToArray();
            // TMP's search order: the asset's own fallbacks, then the global ones (not for a global fallback or a font in
            // a global's own chain, which TMP searches without the globals again); twins without duplicates or itself
            var fallbacks = new List<FontAsset>();
            var globals = run.GlobalChain.Contains(tmp) ? Enumerable.Empty<TMP_FontAsset>() : run.Globals;
            foreach (var f in (tmp.fallbackFontAssetTable ?? new List<TMP_FontAsset>()).Concat(globals))
            {
                if (f == null || f == tmp || IsWeightFaceOf(f)) continue;
                var t = Entry(f, "falls back to");
                if (t != null && t != twin && !fallbacks.Contains(t)) fallbacks.Add(t);
            }
            run.OnPath.Remove(key);

            // kerning pairs keep no lookup flags (DesignText.ClearPairFlags: TextCore leaves values there that drop letter-spacing)
            if (DesignUi.DesignText.ClearPairFlags(twin) > 0 | Mirror(twin, fallbacks, regular, italic, face) || built)
            {
                EditorUtility.SetDirty(twin);
                using (TwinLinks.Saving()) AssetDatabase.SaveAssetIfDirty(twin);
            }
            return twin;
        }

        /// <summary>
        /// Writes the fallback list and the weight table through SerializedObject when they differ, so the font asset's
        /// OnValidate refreshes its lookup tables and native font data. Returns whether anything changed.
        /// </summary>
        static bool Mirror(FontAsset twin, List<FontAsset> fallbacks, FontAsset[] regular, FontAsset[] italic, FaceInfo? face)
        {
            using (var so = new SerializedObject(twin))
            {
                if (face.HasValue) SetFace(so, face.Value);
                // the characters (and kerning pairs) the compiler adds to a twin must reach player builds
                var clear = so.FindProperty("m_ClearDynamicDataOnBuild") ?? throw new FontSetupException("this Unity version's TextCore FontAsset has no m_ClearDynamicDataOnBuild field");
                if (clear.boolValue) clear.boolValue = false;
                var list = so.FindProperty("m_FallbackFontAssetTable");
                var table = so.FindProperty("m_FontWeightTable");
                if (list == null || table == null) throw new FontSetupException("this Unity version's TextCore FontAsset has no fallback list or weight table field");
                bool same = list.arraySize == fallbacks.Count;
                for (int i = 0; same && i < fallbacks.Count; i++) same = list.GetArrayElementAtIndex(i).objectReferenceValue == fallbacks[i];
                if (!same)
                {
                    list.arraySize = fallbacks.Count;
                    for (int i = 0; i < fallbacks.Count; i++) list.GetArrayElementAtIndex(i).objectReferenceValue = fallbacks[i];
                }
                for (int i = 0; i < table.arraySize; i++)
                {
                    var pair = table.GetArrayElementAtIndex(i);
                    Set(pair.FindPropertyRelative("regularTypeface"), i < regular.Length ? regular[i] : null);
                    Set(pair.FindPropertyRelative("italicTypeface"), i < italic.Length ? italic[i] : null);
                }
                return so.ApplyModifiedPropertiesWithoutUndo();
            }
        }

        /// <summary>Writes a variant's line metrics (line height, ascent and descent lines) and face scale when they differ.</summary>
        static void SetFace(SerializedObject so, FaceInfo face)
        {
            void Float(string name, float value)
            {
                var p = so.FindProperty("m_FaceInfo." + name) ?? throw new FontSetupException("this Unity version's TextCore FontAsset has no face info field " + name);
                if (Math.Abs(p.floatValue - value) > 1e-5f) p.floatValue = value;
            }
            Float("m_LineHeight", face.lineHeight);
            Float("m_AscentLine", face.ascentLine);
            Float("m_DescentLine", face.descentLine);
            Float("m_Scale", face.scale); // a scaled-viewport variant's exact / rounded size; 1 elsewhere
        }

        static void Set(SerializedProperty p, FontAsset value)
        {
            if (p != null && p.objectReferenceValue != value) p.objectReferenceValue = value;
        }

        /// <summary>A new dynamic TextCore font asset with atlas pages of <paramref name="page"/>, in memory.</summary>
        internal static FontAsset Build(TMP_FontAsset tmp, Font font, GlyphRenderMode mode, Vector2Int page)
        {
            var asset = FontAsset.CreateFontAsset(font, SamplingSize(tmp), tmp.atlasPadding, mode, page.x, page.y, TextCorePopulation.Dynamic, true);
            if (asset == null) throw new FontSetupException(NoFace(tmp, font));
            return asset;
        }

        /// <summary>The twin as a new asset, with its first atlas texture and its material stored inside it.</summary>
        static FontAsset Create(TMP_FontAsset tmp, Font font, GlyphRenderMode mode, string path, Vector2Int page)
        {
            var twin = Build(tmp, font, mode, page);
            twin.name = Path.GetFileNameWithoutExtension(path);
            EnsureFolder(Path.GetDirectoryName(path)?.Replace('\\', '/'));
            AssetDatabase.CreateAsset(twin, path);
            StoreSubAssets(twin);
            return twin;
        }

        /// <summary>Unity's object header fields, which stay the existing asset's when it is rebuilt.</summary>
        static readonly HashSet<string> Header = new HashSet<string>(StringComparer.Ordinal)
        {
            "m_ObjectHideFlags", "m_CorrespondingSourceObject", "m_PrefabInstance", "m_PrefabAsset", "m_GameObject", "m_Enabled", "m_EditorHideFlags",
            "m_Script", "m_Name", "m_EditorClassIdentifier",
        };

        /// <summary>
        /// Rebuilds an outdated twin in place: the existing asset object (and so its GUID and every reference to it) stays,
        /// its old atlas textures and material are removed, and the state of a freshly built font asset is copied in.
        /// </summary>
        internal static void Rebuild(FontAsset twin, TMP_FontAsset tmp, Font font, GlyphRenderMode mode, string path, Vector2Int page)
        {
            var fresh = Build(tmp, font, mode, page);
            // the old sub-assets leave the file; they are not destroyed: text generation may still hold a queued atlas texture
            foreach (var sub in AssetDatabase.LoadAllAssetsAtPath(path).Where(o => o != null && o != twin).ToList())
                AssetDatabase.RemoveObjectFromAsset(sub);
            using (var source = new SerializedObject(fresh))
            using (var target = new SerializedObject(twin))
            {
                var it = source.GetIterator();
                for (var enter = true; it.Next(enter); enter = false)
                    if (!Header.Contains(it.name)) target.CopyFromSerializedProperty(it);
                target.ApplyModifiedPropertiesWithoutUndo();
            }
            // the atlas texture and material now belong to the twin: detach them before the in-memory asset is destroyed
            fresh.atlasTextures = new Texture2D[0];
            fresh.material = null;
            UnityEngine.Object.DestroyImmediate(fresh);
            StoreSubAssets(twin);
        }

        internal static void StoreSubAssets(FontAsset twin)
        {
            foreach (var texture in twin.atlasTextures ?? new Texture2D[0])
                if (texture != null && !AssetDatabase.Contains(texture))
                {
                    texture.name = twin.name + " Atlas";
                    AssetDatabase.AddObjectToAsset(texture, twin);
                }
            var material = twin.material;
            if (material != null && !AssetDatabase.Contains(material))
            {
                material.name = twin.name + " Material";
                AssetDatabase.AddObjectToAsset(material, twin);
            }
        }

        static string NoFace(TMP_FontAsset tmp, Font font) =>
            "cannot load the font face of '" + AssetDatabase.GetAssetPath(font) + "' for the UI Toolkit twin of '" + tmp.name + "'; check that its importer includes the font data.";

        internal static int SamplingSize(TMP_FontAsset tmp) => Mathf.RoundToInt(tmp.faceInfo.pointSize);

        static void CheckSettings(TMP_FontAsset tmp)
        {
            if (SamplingSize(tmp) <= 0 || tmp.atlasWidth <= 0 || tmp.atlasHeight <= 0)
                throw new FontSetupException("TMP font asset '" + tmp.name + "' has no sampling point size or atlas size (" + SamplingSize(tmp) + ", " + tmp.atlasWidth + "×" +
                                             tmp.atlasHeight + "); regenerate it with the Font Asset Creator.");
        }

        /// <summary>
        /// Whether a plain twin is made as <paramref name="tmp"/> asks: its source font, sampling size, padding and render mode,
        /// dynamic with multi-atlas, and atlas pages no larger than the TMP asset's (<see cref="TwinAtlas"/> sizes them to the
        /// glyphs the twin holds).
        /// </summary>
        static bool SameSettings(FontAsset twin, Font font, TMP_FontAsset tmp, GlyphRenderMode mode) =>
            SameVariantSettings(twin, font, tmp, mode) &&
            twin.atlasWidth > 0 && twin.atlasWidth <= tmp.atlasWidth &&
            twin.atlasHeight > 0 && twin.atlasHeight <= tmp.atlasHeight;

        /// <summary>A line-box variant's settings: the plain twin's but its atlas pages (it renders from the plain twin's).</summary>
        static bool SameVariantSettings(FontAsset twin, Font font, TMP_FontAsset tmp, GlyphRenderMode mode) =>
            twin.sourceFontFile == font &&
            twin.atlasPopulationMode == TextCorePopulation.Dynamic &&
            Mathf.RoundToInt(twin.faceInfo.pointSize) == SamplingSize(tmp) &&
            twin.atlasPadding == tmp.atlasPadding &&
            twin.atlasRenderMode == mode &&
            twin.isMultiAtlasTexturesEnabled;

        static string CheckFolder(string folder)
        {
            var f = (folder ?? "").Replace('\\', '/').Trim().TrimEnd('/');
            if (f != "Assets" && !f.StartsWith("Assets/", StringComparison.Ordinal) || f.Split('/').Any(part => part.Length == 0 || part == "." || part == ".."))
                throw new FontSetupException("the font twin folder must be a folder inside Assets/ (the profile's fontTwinFolder is '" + folder + "')");
            return f;
        }

        static void EnsureFolder(string folder)
        {
            if (string.IsNullOrEmpty(folder) || AssetDatabase.IsValidFolder(folder)) return;
            var slash = folder.LastIndexOf('/');
            if (slash <= 0) return;
            EnsureFolder(folder.Substring(0, slash));
            AssetDatabase.CreateFolder(folder.Substring(0, slash), folder.Substring(slash + 1));
        }
    }
}
