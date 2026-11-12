// M0 spike (throwaway, deleted in Task 4): renders a UI Toolkit twin into a 2560x1440 RenderTexture,
// reads it back to PNG and writes per-element boxes in the same JSON shape as spike/measure-chromium.ts.
// Internal UI Toolkit / TextCore members are reached through reflection; each use is marked INTERNAL.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using UnityEngine;
using UnityEngine.Experimental.Rendering;
using UnityEngine.Rendering;
using UnityEngine.TextCore.LowLevel;
using UnityEngine.TextCore.Text;
using UnityEngine.UIElements;
using TextElement = UnityEngine.UIElements.TextElement;

namespace DesignUi.Spike
{
    /// <summary>RenderTexture colour setup used for a capture (R8).</summary>
    public enum SpikeTarget
    {
        /// <summary>R8G8B8A8_SRGB target, PanelSettings.forceGammaRendering = false.</summary>
        SrgbRt,
        /// <summary>R8G8B8A8_UNorm target, PanelSettings.forceGammaRendering = false.</summary>
        LinearRt,
        /// <summary>R8G8B8A8_UNorm target, PanelSettings.forceGammaRendering = true.</summary>
        LinearRtForceGamma,
        /// <summary>R8G8B8A8_SRGB target, PanelSettings.forceGammaRendering = true.</summary>
        SrgbRtForceGamma,
    }

    public enum SpikeReadback { ReadPixels, AsyncGpu }

    /// <summary>One mounted twin: RenderTexture + PanelSettings + UIDocument.</summary>
    public sealed class SpikeSession : IDisposable
    {
        public RenderTexture Target;
        public PanelSettings Settings;
        public GameObject Host;
        public UIDocument Document;
        public VisualElement TwinRoot;
        public SpikeTarget Mode;
        public string DocRootBefore = "";   // document root worldBound before the explicit stretch
        public bool StretchApplied;
        /// <summary>Glyph quads per text element from TextElement.PostProcessTextVertices (element-local, y down).</summary>
        public readonly Dictionary<TextElement, List<Rect>> Glyphs = new Dictionary<TextElement, List<Rect>>();
        public readonly Dictionary<TextElement, int> GlyphCallbacks = new Dictionary<TextElement, int>();

        public IPanel Panel => Document != null && Document.rootVisualElement != null ? Document.rootVisualElement.panel : null;

        public void Dispose()
        {
            if (Host != null) UnityEngine.Object.DestroyImmediate(Host);
            if (Settings != null) UnityEngine.Object.DestroyImmediate(Settings);
            if (Target != null) { Target.Release(); UnityEngine.Object.DestroyImmediate(Target); }
        }
    }

    public static class SpikeCapture
    {
        public const int W = 2560, H = 1440;
        const BindingFlags Any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

        /// <summary>Output root (absolute). Set by the test from SPIKE_OUT or the repo's spike/out/unity.</summary>
        public static string OutRoot;

        public static string FixtureDir(string fixture)
        {
            if (string.IsNullOrEmpty(OutRoot)) throw new InvalidOperationException("SpikeCapture.OutRoot is not set");
            var d = Path.Combine(OutRoot, fixture);
            Directory.CreateDirectory(d);
            return d;
        }

        // ---------------------------------------------------------------- target + panel

        public static RenderTexture CreateTarget(SpikeTarget mode)
        {
            bool srgb = mode == SpikeTarget.SrgbRt || mode == SpikeTarget.SrgbRtForceGamma;
            var desc = new RenderTextureDescriptor(W, H)
            {
                graphicsFormat = srgb ? GraphicsFormat.R8G8B8A8_SRGB : GraphicsFormat.R8G8B8A8_UNorm,
                depthStencilFormat = GraphicsFormat.D24_UNorm_S8_UInt, // UI Toolkit clips rounded overflow with stencil
                msaaSamples = 1,
                mipCount = 1,
                useMipMap = false,
                sRGB = srgb,
            };
            var rt = new RenderTexture(desc) { name = "SpikeTarget_" + mode, hideFlags = HideFlags.DontSave };
            rt.Create();
            return rt;
        }

        public static bool ForceGamma(SpikeTarget mode) => mode == SpikeTarget.LinearRtForceGamma || mode == SpikeTarget.SrgbRtForceGamma;

        public static PanelSettings CreatePanelSettings(RenderTexture rt, bool forceGamma)
        {
            var ps = ScriptableObject.CreateInstance<PanelSettings>();
            ps.hideFlags = HideFlags.DontSave;
            ps.themeStyleSheet = null; // twins assume no theme stylesheet
            ps.scaleMode = PanelScaleMode.ScaleWithScreenSize;
            ps.referenceResolution = new Vector2Int(W, H);
            ps.screenMatchMode = PanelScreenMatchMode.MatchWidthOrHeight;
            ps.match = 0.5f;
            ps.targetTexture = rt;
            ps.clearColor = true;
            ps.colorClearValue = new Color(1f, 0f, 1f, 1f); // magenta = pixels the twin did not cover
            ps.forceGammaRendering = forceGamma;
            TrySet(ps, "disableNoThemeWarning", true); // INTERNAL: silences the no-theme warning only
            return ps;
        }

        /// <summary>Mounts a twin through the public UIDocument path. The host is created inactive so the
        /// document registers once, with its PanelSettings and tree already set.</summary>
        public static SpikeSession Mount(VisualTreeAsset twin, SpikeTarget mode)
        {
            var s = new SpikeSession { Mode = mode };
            s.Target = CreateTarget(mode);
            s.Settings = CreatePanelSettings(s.Target, ForceGamma(mode));
            s.Host = new GameObject("SpikeDoc") { hideFlags = HideFlags.DontSave };
            s.Host.SetActive(false);
            s.Document = s.Host.AddComponent<UIDocument>();
            s.Document.panelSettings = s.Settings;
            s.Document.visualTreeAsset = twin;
            s.Host.SetActive(true);
            var docRoot = s.Document.rootVisualElement;
            if (docRoot == null) throw new InvalidOperationException("UIDocument.rootVisualElement is null after mount");
            s.TwinRoot = docRoot.Q("root");
            if (s.TwinRoot == null) throw new InvalidOperationException("twin has no element named 'root'");
            return s;
        }

        /// <summary>Called after the first layout pass: without a theme the document root is not stretched to the
        /// panel, so the twin's 100% root collapses. Stretch it explicitly and report whether that was needed.</summary>
        public static bool EnsureStretched(SpikeSession s)
        {
            var docRoot = s.Document.rootVisualElement;
            var b = docRoot.worldBound;
            s.DocRootBefore = R(b);
            if (Mathf.Abs(b.width - W) < 0.5f && Mathf.Abs(b.height - H) < 0.5f && Mathf.Abs(b.x) < 0.5f && Mathf.Abs(b.y) < 0.5f) return false;
            docRoot.style.position = Position.Absolute;
            docRoot.style.left = 0; docRoot.style.top = 0; docRoot.style.right = 0; docRoot.style.bottom = 0;
            s.StretchApplied = true;
            return true;
        }

        // ---------------------------------------------------------------- EditMode update + render (INTERNAL)

        static Type s_RuntimeUtility;
        static Type RuntimeUtility => s_RuntimeUtility ??= typeof(PanelSettings).Assembly.GetType("UnityEngine.UIElements.UIElementsRuntimeUtility", true);

        /// <summary>
        /// INTERNAL: UIElementsRuntimeUtility.RepaintPanel(BaseRuntimePanel) (styles, layout, render data) followed by
        /// UIElementsRuntimeUtility.RenderPanel(BaseRuntimePanel, restoreState) (draws into PanelSettings.targetTexture).
        /// Used only for the EditMode route; in Play mode the player loop does this every frame.
        /// </summary>
        public static void Pump(SpikeSession s, int passes = 3)
        {
            var panel = s.Panel ?? throw new InvalidOperationException("no panel");
            var repaint = RuntimeUtility.GetMethod("RepaintPanel", Any);
            var render = RuntimeUtility.GetMethod("RenderPanel", Any);
            for (int i = 0; i < passes; i++)
            {
                repaint.Invoke(null, new object[] { panel });
                render.Invoke(null, new object[] { panel, true });
            }
        }

        // ---------------------------------------------------------------- readback

        public static Texture2D ReadBack(RenderTexture rt, SpikeReadback how)
        {
            // linear:true keeps Texture2D from tagging the bytes as sRGB; bytes are stored as read either way.
            var tex = new Texture2D(rt.width, rt.height, TextureFormat.RGBA32, false, true) { hideFlags = HideFlags.DontSave };
            if (how == SpikeReadback.ReadPixels)
            {
                var prev = RenderTexture.active;
                RenderTexture.active = rt;
                tex.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0, false);
                tex.Apply(false);
                RenderTexture.active = prev;
            }
            else
            {
                var req = AsyncGPUReadback.Request(rt, 0); // raw bytes of the target format
                req.WaitForCompletion();
                if (req.hasError) throw new InvalidOperationException("AsyncGPUReadback failed");
                var data = req.GetData<byte>();
                if (data.Length != rt.width * rt.height * 4) throw new InvalidOperationException("AsyncGPUReadback size " + data.Length);
                tex.SetPixelData(data, 0);
                tex.Apply(false);
            }
            return tex;
        }

        public static void WritePng(Texture2D tex, string path)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllBytes(path, tex.EncodeToPNG());
        }

        /// <summary>Pixel at top-left-origin coordinates (CSS px).</summary>
        public static Color32 Sample(Texture2D tex, int x, int yTop) => tex.GetPixel(x, tex.height - 1 - yTop);

        public static string Hex(Color32 c) => string.Format("#{0:x2}{1:x2}{2:x2}{3:x2}", c.r, c.g, c.b, c.a);

        public static int CountColor(Texture2D tex, Color32 c)
        {
            int n = 0;
            foreach (var p in tex.GetPixels32()) if (p.r == c.r && p.g == c.g && p.b == c.b) n++;
            return n;
        }

        // ---------------------------------------------------------------- fonts (R4)

        /// <summary>Dynamic TextCore FontAsset with explicit sampling size, padding, render mode and atlas size.</summary>
        public static FontAsset CreateDynamicFontAsset(Font font, string name, int sampling, int padding, GlyphRenderMode mode, int atlas)
        {
            var fa = FontAsset.CreateFontAsset(font, sampling, padding, mode, atlas, atlas, AtlasPopulationMode.Dynamic, true);
            if (fa == null) throw new InvalidOperationException("FontAsset.CreateFontAsset returned null for " + font);
            fa.name = name;
            fa.hideFlags = HideFlags.DontSave;
            return fa;
        }

        public static string DescribeFace(FontAsset fa)
        {
            var f = fa.faceInfo;
            return string.Format(CultureInfo.InvariantCulture,
                "family={0} style={1} pointSize={2} scale={3} unitsPerEM={4} lineHeight={5} ascentLine={6} descentLine={7} capLine={8} meanLine={9} baseline={10} atlasPadding={11} atlasRenderMode={12} population={13} atlas={14}x{15}",
                f.familyName, f.styleName, f.pointSize, f.scale, "n/a", f.lineHeight, f.ascentLine, f.descentLine, f.capLine, f.meanLine, f.baseline,
                fa.atlasPadding, fa.atlasRenderMode, fa.atlasPopulationMode, fa.atlasWidth, fa.atlasHeight);
        }

        // ---------------------------------------------------------------- pointer events (R6)

        /// <summary>Dispatches a pointer event built from an IMGUI Event through the panel's visual tree (panel coordinates).</summary>
        public static void SendPointer(IPanel panel, EventType type, Vector2 panelPos)
        {
            var e = new Event { type = type, mousePosition = panelPos, button = 0, clickCount = type == EventType.MouseDown ? 1 : 0 };
            EventBase evt;
            switch (type)
            {
                case EventType.MouseMove: evt = PointerMoveEvent.GetPooled(e); break;
                case EventType.MouseDown: evt = PointerDownEvent.GetPooled(e); break;
                case EventType.MouseUp: evt = PointerUpEvent.GetPooled(e); break;
                default: throw new ArgumentException(type.ToString());
            }
            using (evt) panel.visualTree.SendEvent(evt);
        }

        /// <summary>INTERNAL: VisualElement.pseudoStates.</summary>
        public static string PseudoStates(VisualElement ve)
        {
            var p = typeof(VisualElement).GetProperty("pseudoStates", Any);
            return p == null ? "?" : p.GetValue(ve).ToString();
        }

        // ---------------------------------------------------------------- text lines (R7)

        public sealed class LineBox
        {
            public float x, y, w, h, baseline;   // absolute panel px
            public int first = -1, last = -1;
        }

        public sealed class TextProbe
        {
            public string route;
            public readonly List<LineBox> lines = new List<LineBox>();
            public float? baseline;          // first line, absolute panel px
            public float? lineBoxHeight;     // baseline-to-baseline, else content height
            public string error;
            public string raw = "null";      // route-specific JSON
        }

        /// <summary>Public route (6.3): hook TextElement.PostProcessTextVertices on every text element before the first
        /// render; the callback receives the glyph quads (element-local, y down).</summary>
        public static void HookGlyphs(SpikeSession s)
        {
            foreach (var te in s.TwinRoot.Query<TextElement>().ToList())
            {
                var el = te;
                s.Glyphs[el] = new List<Rect>();
                s.GlyphCallbacks[el] = 0;
                el.PostProcessTextVertices = glyphs =>
                {
                    s.GlyphCallbacks[el]++;
                    var list = s.Glyphs[el];
                    list.Clear();
                    foreach (var g in glyphs)
                    {
                        var v = g.vertices;
                        if (v.Length == 0) continue;
                        float x0 = float.MaxValue, y0 = float.MaxValue, x1 = float.MinValue, y1 = float.MinValue;
                        for (int i = 0; i < v.Length; i++)
                        {
                            var p = v[i].position;
                            x0 = Mathf.Min(x0, p.x); y0 = Mathf.Min(y0, p.y); x1 = Mathf.Max(x1, p.x); y1 = Mathf.Max(y1, p.y);
                        }
                        list.Add(Rect.MinMaxRect(x0, y0, x1, y1));
                    }
                };
            }
        }

        /// <summary>Lines from glyph quads: quads whose vertical centres lie within half a quad height are one line.</summary>
        public static TextProbe ProbeGlyphs(SpikeSession s, TextElement te)
        {
            var probe = new TextProbe { route = "TextElement.PostProcessTextVertices glyph quads (public)" };
            if (!s.Glyphs.TryGetValue(te, out var quads) || quads.Count == 0)
            {
                probe.error = "no glyph callback (calls=" + (s.GlyphCallbacks.TryGetValue(te, out var n) ? n : -1) + ")";
                return probe;
            }
            var groups = new List<List<Rect>>();
            foreach (var q in quads)
            {
                var g = groups.Find(gr => Mathf.Abs(gr[0].center.y - q.center.y) < Mathf.Max(gr[0].height, q.height) * 0.5f);
                if (g == null) groups.Add(g = new List<Rect>());
                g.Add(q);
            }
            groups.Sort((a, b) => a[0].center.y.CompareTo(b[0].center.y));
            var sb = new StringBuilder("{\"calls\": ").Append(s.GlyphCallbacks[te]).Append(", \"quads\": ").Append(quads.Count).Append(", \"lines\": [");
            for (int i = 0; i < groups.Count; i++)
            {
                float x0 = float.MaxValue, y0 = float.MaxValue, x1 = float.MinValue, y1 = float.MinValue;
                foreach (var q in groups[i]) { x0 = Mathf.Min(x0, q.xMin); y0 = Mathf.Min(y0, q.yMin); x1 = Mathf.Max(x1, q.xMax); y1 = Mathf.Max(y1, q.yMax); }
                var tl = te.LocalToWorld(new Vector2(x0, y0));
                var br = te.LocalToWorld(new Vector2(x1, y1));
                probe.lines.Add(new LineBox { x = tl.x, y = tl.y, w = br.x - tl.x, h = br.y - tl.y, baseline = float.NaN });
                sb.Append(i == 0 ? "" : ", ").Append("{\"glyphs\": ").Append(groups[i].Count).Append(", \"inkWithPadding\": [")
                  .Append(N(tl.x)).Append(", ").Append(N(tl.y)).Append(", ").Append(N(br.x - tl.x)).Append(", ").Append(N(br.y - tl.y)).Append("]}");
            }
            probe.raw = sb.Append("]}").ToString();
            return probe;
        }

        /// <summary>Public route: ITextSelection.GetCursorPositionFromStringIndex for every string index (element-local).
        /// Measured semantics (6000.3): x = caret x (advance position), y = bottom of the caret's line (line top +
        /// line height). Indices are grouped into lines by y; a line's width is its largest caret x (the caret after
        /// the last character); its top is the previous line's bottom. The baseline is not exposed: it is derived from
        /// the public FontAsset.faceInfo (ascentLine * fontSize / pointSize) below the line top.</summary>
        public static TextProbe ProbeCursor(TextElement te)
        {
            var probe = new TextProbe { route = "TextElement.selection.GetCursorPositionFromStringIndex + FontAsset.faceInfo ascent (public)" };
            try
            {
                var sel = te.selection;
                var text = te.text ?? "";
                var fa = te.resolvedStyle.unityFontDefinition.fontAsset;
                float ascentPx = fa == null ? float.NaN : fa.faceInfo.ascentLine * te.resolvedStyle.fontSize / fa.faceInfo.pointSize;
                var sb = new StringBuilder("{\"ascentPx\": ").Append(N(ascentPx)).Append(", \"positions\": [");
                var groups = new List<(float y, float minX, float maxX, int first, int last)>();
                for (int i = 0; i <= text.Length; i++)
                {
                    var p = sel.GetCursorPositionFromStringIndex(i);
                    sb.Append(i == 0 ? "" : ", ").Append("[").Append(N(p.x)).Append(", ").Append(N(p.y)).Append("]");
                    int g = groups.Count - 1;
                    if (g < 0 || Mathf.Abs(groups[g].y - p.y) > 0.5f) groups.Add((p.y, p.x, p.x, i, i));
                    else groups[g] = (groups[g].y, Mathf.Min(groups[g].minX, p.x), Mathf.Max(groups[g].maxX, p.x), groups[g].first, i);
                }
                float top = 0f;
                foreach (var g in groups)
                {
                    var tl = te.LocalToWorld(new Vector2(g.minX, top));
                    var br = te.LocalToWorld(new Vector2(g.maxX, g.y));
                    probe.lines.Add(new LineBox { x = tl.x, y = tl.y, w = br.x - tl.x, h = br.y - tl.y, baseline = tl.y + ascentPx, first = g.first, last = g.last });
                    top = g.y;
                }
                if (probe.lines.Count > 0)
                {
                    probe.baseline = probe.lines[0].baseline;
                    float sum = 0; foreach (var l in probe.lines) sum += l.h;
                    probe.lineBoxHeight = sum / probe.lines.Count;
                }
                probe.raw = sb.Append("], \"contentRect\": \"").Append(R(te.contentRect)).Append("\"}").ToString();
            }
            catch (Exception ex) { probe.error = ex.GetType().Name + ": " + ex.Message; }
            return probe;
        }

        /// <summary>INTERNAL route that also serves the advanced generator: TextHandle.GetLineNumber(index) and
        /// TextHandle.GetLineInfoFromCharacterIndex(index) (public methods of the internal TextHandle).</summary>
        public static TextProbe ProbeHandle(TextElement te)
        {
            var probe = new TextProbe { route = "uitkTextHandle.GetLineNumber + GetLineInfoFromCharacterIndex (internal)" };
            try
            {
                var handle = typeof(TextElement).GetProperty("uitkTextHandle", Any)?.GetValue(te);
                var ht = handle.GetType();
                MethodInfo lineNo = null, lineInfo = null;
                for (var t = ht; t != null && (lineNo == null || lineInfo == null); t = t.BaseType)
                {
                    lineNo ??= t.GetMethod("GetLineNumber", Any | BindingFlags.DeclaredOnly);
                    lineInfo ??= t.GetMethod("GetLineInfoFromCharacterIndex", Any | BindingFlags.DeclaredOnly);
                }
                var text = te.text ?? "";
                var content = te.contentRect;
                var origin = te.LocalToWorld(new Vector2(content.x, content.y));
                var raw = new StringBuilder("{\"lineNumbers\": [");
                int lastLine = -1;
                for (int i = 0; i < text.Length; i++)
                {
                    int ln = Convert.ToInt32(lineNo.Invoke(handle, new object[] { i }), CultureInfo.InvariantCulture);
                    raw.Append(i == 0 ? "" : ", ").Append(ln);
                    if (ln == lastLine) { probe.lines[probe.lines.Count - 1].last = i; continue; }
                    lastLine = ln;
                    var li = lineInfo.Invoke(handle, new object[] { i });
                    var lt = li.GetType();
                    float F(string n) => Convert.ToSingle(lt.GetField(n, Any).GetValue(li), CultureInfo.InvariantCulture);
                    float asc = F("ascender"), bl = F("baseline"), desc = F("descender");
                    probe.lines.Add(new LineBox { x = origin.x, y = origin.y + content.height - asc, w = F("width"), h = asc - desc, baseline = origin.y + content.height - bl, first = i, last = i });
                }
                probe.raw = raw.Append("]}").ToString();
                if (probe.lines.Count > 0)
                {
                    probe.baseline = probe.lines[0].baseline;
                    probe.lineBoxHeight = probe.lines.Count > 1 ? (probe.lines[probe.lines.Count - 1].baseline - probe.lines[0].baseline) / (probe.lines.Count - 1) : content.height;
                }
            }
            catch (Exception ex) { probe.error = (ex.InnerException ?? ex).GetType().Name + ": " + (ex.InnerException ?? ex).Message; }
            return probe;
        }

        /// <summary>
        /// INTERNAL route: TextElement.uitkTextHandle (UITKTextHandle : TextCore TextHandle) -> ComputeSettingsAndUpdate()
        /// -> textInfo (TextInfo) -> lineCount + lineInfo[] (LineInfo: ascender, baseline, descender, lineHeight, width,
        /// lineExtents). Measured: LineInfo y values are y-up from the BOTTOM of the content rect (first line's
        /// ascender = content height); lineExtents are glyph-quad extents (SDF padding included), not advances.
        /// </summary>
        public static TextProbe ProbeInternal(TextElement te, bool forceUpdate)
        {
            var probe = new TextProbe { route = "TextElement.uitkTextHandle.textInfo.lineInfo (internal)" + (forceUpdate ? " after ComputeSettingsAndUpdate" : "") };
            try
            {
                var handle = typeof(TextElement).GetProperty("uitkTextHandle", Any)?.GetValue(te);
                if (handle == null) { probe.error = "uitkTextHandle not found"; return probe; }
                var ht = handle.GetType();
                if (forceUpdate) FindMethod(ht, "ComputeSettingsAndUpdate")?.Invoke(handle, null);
                bool adv = false;
                var advP = FindProperty(ht, "useAdvancedText");
                if (advP != null) adv = (bool)advP.GetValue(handle);
                float ppp = float.NaN;
                var pppM = FindMethod(ht, "GetPixelsPerPoint");
                if (pppM != null) ppp = Convert.ToSingle(pppM.Invoke(handle, null), CultureInfo.InvariantCulture);
                var ti = FindProperty(ht, "textInfo")?.GetValue(handle);
                if (ti == null) { probe.error = "textInfo is null"; return probe; }
                int count = (int)ti.GetType().GetField("lineCount", Any).GetValue(ti);
                var arr = (Array)ti.GetType().GetField("lineInfo", Any).GetValue(ti);
                var content = te.contentRect;
                var origin = te.LocalToWorld(new Vector2(content.x, content.y));
                float scale = float.IsNaN(ppp) || ppp <= 0 ? 1f : 1f / ppp;
                var raw = new StringBuilder("{\"advanced\": ").Append(adv ? "true" : "false").Append(", \"pixelsPerPoint\": ").Append(N(ppp)).Append(", \"lines\": [");
                for (int i = 0; i < count && arr != null && i < arr.Length; i++)
                {
                    var li = arr.GetValue(i);
                    var lt = li.GetType();
                    float F(string n) => Convert.ToSingle(lt.GetField(n, Any).GetValue(li), CultureInfo.InvariantCulture);
                    var ext = lt.GetField("lineExtents", Any).GetValue(li);
                    var et = ext.GetType();
                    var min = (Vector2)et.GetField("min", Any).GetValue(ext);
                    var max = (Vector2)et.GetField("max", Any).GetValue(ext);
                    float asc = F("ascender"), bl = F("baseline"), desc = F("descender"), lh = F("lineHeight");
                    int first = (int)lt.GetField("firstCharacterIndex", Any).GetValue(li);
                    int last = (int)lt.GetField("lastCharacterIndex", Any).GetValue(li);
                    probe.lines.Add(new LineBox
                    {
                        x = origin.x + min.x * scale,
                        w = (max.x - min.x) * scale,
                        y = origin.y + content.height - asc * scale,
                        h = (asc - desc) * scale,
                        baseline = origin.y + content.height - bl * scale,
                        first = first, last = last,
                    });
                    raw.Append(i == 0 ? "" : ", ").Append("{\"ascender\": ").Append(N(asc)).Append(", \"baseline\": ").Append(N(bl))
                       .Append(", \"descender\": ").Append(N(desc)).Append(", \"lineHeight\": ").Append(N(lh))
                       .Append(", \"width\": ").Append(N(F("width"))).Append(", \"extMin\": [").Append(N(min.x)).Append(", ").Append(N(min.y))
                       .Append("], \"extMax\": [").Append(N(max.x)).Append(", ").Append(N(max.y)).Append("], \"first\": ").Append(first)
                       .Append(", \"last\": ").Append(last).Append("}");
                }
                probe.raw = raw.Append("]}").ToString();
                if (probe.lines.Count > 0)
                {
                    probe.baseline = probe.lines[0].baseline;
                    probe.lineBoxHeight = probe.lines.Count > 1
                        ? (probe.lines[probe.lines.Count - 1].baseline - probe.lines[0].baseline) / (probe.lines.Count - 1)
                        : content.height;
                }
                else probe.error = "lineCount 0";
            }
            catch (Exception ex) { probe.error = (ex.InnerException ?? ex).GetType().Name + ": " + (ex.InnerException ?? ex).Message; }
            return probe;
        }

        static PropertyInfo FindProperty(Type t, string name)
        {
            for (; t != null; t = t.BaseType) { var p = t.GetProperty(name, Any | BindingFlags.DeclaredOnly); if (p != null) return p; }
            return null;
        }

        static MethodInfo FindMethod(Type t, string name)
        {
            for (; t != null; t = t.BaseType) { var m = t.GetMethod(name, Any | BindingFlags.DeclaredOnly, null, Type.EmptyTypes, null); if (m != null) return m; }
            return null;
        }

        // ---------------------------------------------------------------- boxes JSON

        static void AppendLines(StringBuilder sb, TextProbe p)
        {
            sb.Append("{\"route\": ").Append(Q(p.route)).Append(", \"lineCount\": ").Append(p.lines.Count).Append(", \"lines\": [");
            for (int i = 0; i < p.lines.Count; i++)
            {
                var l = p.lines[i];
                sb.Append(i == 0 ? "" : ", ").Append("{\"x\": ").Append(N(l.x)).Append(", \"y\": ").Append(N(l.y))
                  .Append(", \"w\": ").Append(N(l.w)).Append(", \"h\": ").Append(N(l.h)).Append(", \"baseline\": ").Append(N(l.baseline))
                  .Append(", \"first\": ").Append(l.first).Append(", \"last\": ").Append(l.last).Append("}");
            }
            sb.Append("], \"baseline\": ").Append(p.baseline.HasValue ? N(p.baseline.Value) : "null")
              .Append(", \"lineBoxHeight\": ").Append(p.lineBoxHeight.HasValue ? N(p.lineBoxHeight.Value) : "null");
            if (p.error != null) sb.Append(", \"error\": ").Append(Q(p.error));
            sb.Append(", \"raw\": ").Append(p.raw).Append("}");
        }

        /// <summary>Boxes in the Chromium JSON shape; text elements carry the internal route as text.lines/baseline/
        /// lineBoxHeight plus every route under text.routes.</summary>
        public static string BoxesJson(SpikeSession s, string fixture, string state, IDictionary<string, string> meta)
        {
            var sb = new StringBuilder();
            sb.Append("{\n  \"fixture\": ").Append(Q(fixture)).Append(",\n  \"state\": ").Append(Q(state));
            sb.Append(",\n  \"viewport\": [").Append(W).Append(", ").Append(H).Append("]");
            sb.Append(",\n  \"unity\": {");
            bool firstMeta = true;
            foreach (var kv in meta) { sb.Append(firstMeta ? "\n    " : ",\n    ").Append(Q(kv.Key)).Append(": ").Append(Q(kv.Value)); firstMeta = false; }
            sb.Append("\n  },\n  \"elements\": [");
            bool first = true;
            foreach (var ve in Walk(s.TwinRoot))
            {
                if (string.IsNullOrEmpty(ve.name)) continue;
                var b = ve.worldBound;
                sb.Append(first ? "\n    {" : ",\n    {"); first = false;
                sb.Append("\"id\": ").Append(Q(ve.name)).Append(", \"x\": ").Append(N(b.x)).Append(", \"y\": ").Append(N(b.y))
                  .Append(", \"w\": ").Append(N(b.width)).Append(", \"h\": ").Append(N(b.height));
                if (ve.resolvedStyle.display == DisplayStyle.None) sb.Append(", \"hidden\": true");
                sb.Append(", \"bg\": ").Append(Q(Hex((Color32)ve.resolvedStyle.backgroundColor)));
                if (ve is TextElement te)
                {
                    var cursor = ProbeCursor(te);
                    var glyphs = ProbeGlyphs(s, te);
                    bool advanced = te.resolvedStyle.unityTextGenerator == TextGeneratorType.Advanced;
                    // TextHandle.textInfo logs an error under the advanced generator ("use textGenerationInfo instead")
                    var internalNow = advanced ? new TextProbe { route = "skipped (advanced generator)", error = "textInfo not available with Advanced Text" } : ProbeInternal(te, false);
                    var internalForced = advanced ? internalNow : ProbeInternal(te, true);
                    var handleProbe = ProbeHandle(te);
                    var p = internalForced.lines.Count > 0 ? internalForced : cursor;
                    sb.Append(", \"text\": {\"lines\": [");
                    for (int i = 0; i < p.lines.Count; i++)
                    {
                        var l = p.lines[i];
                        sb.Append(i == 0 ? "" : ", ").Append("{\"x\": ").Append(N(l.x)).Append(", \"y\": ").Append(N(l.y))
                          .Append(", \"w\": ").Append(N(l.w)).Append(", \"h\": ").Append(N(l.h)).Append(", \"baseline\": ").Append(N(l.baseline)).Append("}");
                    }
                    sb.Append("], \"baseline\": ").Append(p.baseline.HasValue ? N(p.baseline.Value) : "null")
                      .Append(", \"lineBoxHeight\": ").Append(p.lineBoxHeight.HasValue ? N(p.lineBoxHeight.Value) : "null")
                      .Append(", \"content\": ").Append(Q(te.text))
                      .Append(", \"fontSize\": ").Append(N(te.resolvedStyle.fontSize))
                      .Append(", \"generator\": ").Append(Q(te.resolvedStyle.unityTextGenerator.ToString()))
                      .Append(", \"primary\": ").Append(Q(p.route))
                      .Append(", \"routes\": {\"internal\": ");
                    AppendLines(sb, internalForced);
                    sb.Append(", \"handle\": ");
                    AppendLines(sb, handleProbe);
                    sb.Append(", \"internalNoUpdate\": ");
                    AppendLines(sb, internalNow);
                    sb.Append(", \"cursor\": ");
                    AppendLines(sb, cursor);
                    sb.Append(", \"glyphs\": ");
                    AppendLines(sb, glyphs);
                    sb.Append("}}");
                }
                sb.Append("}");
            }
            sb.Append("\n  ]\n}\n");
            return sb.ToString();
        }

        public static IEnumerable<VisualElement> Walk(VisualElement root)
        {
            yield return root;
            foreach (var c in root.Children())
                foreach (var d in Walk(c)) yield return d;
        }

        public static Dictionary<string, string> EnvMeta(SpikeSession s)
        {
            return new Dictionary<string, string>
            {
                ["version"] = Application.unityVersion,
                ["graphicsDeviceType"] = SystemInfo.graphicsDeviceType.ToString(),
                ["graphicsDeviceName"] = SystemInfo.graphicsDeviceName,
                ["batchMode"] = Application.isBatchMode.ToString(),
                ["isPlaying"] = Application.isPlaying.ToString(),
                ["colorSpace"] = QualitySettings.activeColorSpace.ToString(),
                ["target"] = s.Mode.ToString(),
                ["rtGraphicsFormat"] = s.Target.graphicsFormat.ToString(),
                ["rtSRGB"] = s.Target.sRGB.ToString(),
                ["forceGammaRendering"] = s.Settings.forceGammaRendering.ToString(),
                ["panelRoot"] = s.Panel == null ? "" : R(s.Panel.visualTree.worldBound),
                ["docRootBeforeStretch"] = s.DocRootBefore,
                ["docRootStretchApplied"] = s.StretchApplied.ToString(),
            };
        }

        public static string N(float v) => float.IsNaN(v) || float.IsInfinity(v) ? "null" : Math.Round(v, 4).ToString("0.####", CultureInfo.InvariantCulture);
        public static string R(Rect r) => string.Format(CultureInfo.InvariantCulture, "{0},{1},{2},{3}", N(r.x), N(r.y), N(r.width), N(r.height));
        public static string Q(string v)
        {
            if (v == null) return "null";
            var sb = new StringBuilder("\"");
            foreach (var ch in v)
            {
                switch (ch)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                        else sb.Append(ch);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }

        static void TrySet(object target, string prop, object value)
        {
            try { target.GetType().GetProperty(prop, Any)?.SetValue(target, value); } catch { /* spike: optional */ }
        }
    }
}
