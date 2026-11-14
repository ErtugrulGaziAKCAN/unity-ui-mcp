using System;
using System.Collections;
using System.Reflection;
using UnityEngine;
using UnityEngine.Experimental.Rendering;
using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// Shows the panels of a PanelSettings asset as the design shows them in a Linear-colour-space project. UI Toolkit
    /// blends an on-screen panel in linear light there, the design's browser in sRGB, so translucent colours drift (up to
    /// ΔE2000 22 measured). This component takes Unity's documented route instead: the panel renders into a screen-sized
    /// <c>R8G8B8A8_UNorm</c> RenderTexture with <see cref="PanelSettings.forceGammaRendering"/> on, and the texture is
    /// composited over the screen, decoded to linear light, so the screen stores the panel's colours unchanged. Within the
    /// panel every colour matches the verifier's capture; where the panel is translucent over the game's own camera image,
    /// that last blend is in linear light. Costs, per PanelSettings it renders (the asset and each region's sort-order copy of
    /// it), a screen-sized colour and depth-stencil texture (2 × 4 bytes per pixel, 29.5 MB at 2560×1440, 66 MB at
    /// 3840×2160) and one full-screen pass per frame. Does nothing in a Gamma project.
    /// <para>
    /// The texture is drawn where UI Toolkit would draw the panel on screen (<see cref="DesignUiOverlayOrder"/>): over the
    /// Screen Space - Overlay canvases of a lower or the same sort order and under those of a higher one, and among other
    /// runtime panels by sort order (the same sort order: in the order the panels were made), the order pointer input
    /// follows. Where this Unity version does not allow that, or no overlay pass ran in a frame, it is drawn at the end of
    /// the frame, over everything (said once in the console).
    /// </para>
    /// <para>
    /// Add it once per PanelSettings asset (for example next to the UIDocument). While it is enabled it owns the asset's
    /// <c>targetTexture</c>, <c>forceGammaRendering</c>, clear settings and screen-to-panel function, and gives them back
    /// when disabled or destroyed. Pointer input maps screen pixels to the texture's pixels, as for an on-screen panel. A
    /// <see cref="DesignUiPanelRegion"/> that renders its document on a runtime copy of the asset (its own sort order) is
    /// followed: the copy renders into a texture of its own, whether it was made before or after the composite attached,
    /// is resized with the screen and gets its own settings back; the textures are composited in sort order.
    /// </para>
    /// </summary>
    [AddComponentMenu("Design UI/Gamma Composite")]
    [DisallowMultipleComponent]
    public sealed class DesignUiGammaComposite : MonoBehaviour
    {
        /// <summary>The composite shader, in the package's Resources so builds keep it.</summary>
        internal const string ShaderResource = "DesignUiGammaComposite";

        [Tooltip("The PanelSettings whose panels render in gamma space and are composited over the screen (the profile's design PanelSettings).")]
        public PanelSettings panelSettings;

        /// <summary>
        /// One PanelSettings the composite renders: the asset it was given, or a runtime copy of it a DesignUiPanelRegion made
        /// for its own sort order. Each renders into its own texture (a panel clears its target), and keeps what it had before,
        /// which <see cref="Detach"/> gives back.
        /// </summary>
        sealed class Driven
        {
            public PanelSettings Settings;
            public RenderTexture Target;
            public RenderTexture OldTarget;
            public Func<Vector2, Vector3> OldMapping;
            public bool OldForceGamma, OldClearColor;
            public Color OldClearValue;
            public Vector2Int Screen;

            public Vector2 ScreenToTexture(Vector2 screen)
            {
                if (Target == null || Screen.x <= 0 || Screen.y <= 0) return screen;
                return new Vector2(screen.x * Target.width / Screen.x, screen.y * Target.height / Screen.y);
            }
        }

        /// <summary>The asset first, then its copies in the order they were driven.</summary>
        readonly System.Collections.Generic.List<Driven> m_Driven = new System.Collections.Generic.List<Driven>();
        Material m_Material;
        PanelSettings m_Owned;
        Vector2Int m_Size, m_Screen;
        Coroutine m_Loop;
        bool m_Ordered;
        static bool s_WarnedUnordered;

        /// <summary>The texture the given PanelSettings asset renders into while the component runs, else null.</summary>
        public RenderTexture Target => m_Driven.Count > 0 ? m_Driven[0].Target : null;

        /// <summary>The texture <paramref name="settings"/> (the asset or a copy of it) renders into while the component drives it, else null.</summary>
        public RenderTexture TargetOf(PanelSettings settings)
        {
            foreach (var d in m_Driven) if (ReferenceEquals(d.Settings, settings)) return d.Target;
            return null;
        }

        static readonly System.Collections.Generic.List<DesignUiGammaComposite> s_Attached = new System.Collections.Generic.List<DesignUiGammaComposite>();
        /// <summary>The runtime copies of PanelSettings assets (a region's sort order) and the asset each was made from.</summary>
        static readonly System.Collections.Generic.Dictionary<PanelSettings, PanelSettings> s_Copies = new System.Collections.Generic.Dictionary<PanelSettings, PanelSettings>();

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics()
        {
            s_Attached.Clear();
            s_Copies.Clear();
        }

        /// <summary>
        /// Whether an attached composite renders these PanelSettings: its own asset, or a runtime copy of it a region made,
        /// before or after the composite attached.
        /// </summary>
        public static bool Drives(PanelSettings settings)
        {
            if (settings == null) return false;
            foreach (var c in s_Attached)
                if (c != null && c.TargetOf(settings) != null) return true;
            return false;
        }

        /// <summary>
        /// A region made <paramref name="copy"/> of <paramref name="source"/> (its own sort order): a composite that drives the
        /// source drives the copy too, from now on. Made while driven, the copy holds the composite's settings; what it gets
        /// back on <see cref="Detach"/> is what the source had before the composite.
        /// </summary>
        internal static void CopyMade(PanelSettings source, PanelSettings copy)
        {
            if (source == null || copy == null) return;
            s_Copies[copy] = source;
            foreach (var c in s_Attached.ToArray())
                if (c != null && c.m_Owned == source) c.Drive(copy, c.m_Driven.Count > 0 ? c.m_Driven[0] : null);
        }

        /// <summary>The region released <paramref name="copy"/> (it is destroyed next): no composite renders it any more.</summary>
        internal static void CopyReleased(PanelSettings copy)
        {
            // by reference: a copy already destroyed still has its texture to release
            if ((object)copy == null) return;
            s_Copies.Remove(copy);
            foreach (var c in s_Attached.ToArray()) c?.Undrive(copy);
        }

        /// <summary>Whether the project needs the composite: only a Linear-colour-space project blends UI in linear light.</summary>
        public static bool Needed => QualitySettings.activeColorSpace == ColorSpace.Linear;

        void OnEnable()
        {
            if (!Needed || panelSettings == null) return;
            var screen = new Vector2Int(Screen.width, Screen.height);
            Attach(panelSettings, screen, screen);
            m_Loop = StartCoroutine(CompositeAtEndOfFrame());
        }

        void OnDisable()
        {
            if (m_Loop != null) StopCoroutine(m_Loop);
            m_Loop = null;
            Detach();
        }

        void OnDestroy() => Detach();

        void Update()
        {
            // UI Toolkit (re)sets the overlay hooks when it starts: wrap them again when they were replaced
            if (m_Ordered) DesignUiOverlayOrder.Install();
            var target = Target;
            if (target != null && (target.width != Screen.width || target.height != Screen.height))
                Resize(new Vector2Int(Screen.width, Screen.height), new Vector2Int(Screen.width, Screen.height));
        }

        IEnumerator CompositeAtEndOfFrame()
        {
            var end = new WaitForEndOfFrame();
            while (true)
            {
                yield return end;
                // drawn in this frame's overlay pass at the panel's place: nothing left to do
                if (m_Ordered && DesignUiOverlayOrder.LastPassFrame == Time.frameCount) continue;
                Composite(null);
            }
        }

        /// <summary>
        /// Makes <paramref name="settings"/> and every runtime copy a region made of it render into new gamma-space
        /// textures of the given size.
        /// </summary>
        internal void Attach(PanelSettings settings, Vector2Int target, Vector2Int screen)
        {
            Detach();
            m_Owned = settings;
            m_Size = target;
            m_Screen = screen;
            s_Attached.Add(this);
            Drive(settings, null);
            foreach (var kv in new System.Collections.Generic.List<System.Collections.Generic.KeyValuePair<PanelSettings, PanelSettings>>(s_Copies))
                if (kv.Value == settings && kv.Key != null) Drive(kv.Key, null);
            m_Ordered = DesignUiOverlayOrder.Add(this);
            if (!m_Ordered && !s_WarnedUnordered && Application.isPlaying)
            {
                s_WarnedUnordered = true;
                Debug.LogWarning("DesignUiGammaComposite: this Unity version does not let the composite draw the panel at its sort order among " +
                                 "Screen Space - Overlay canvases and other panels, so it draws it at the end of the frame, over all of them " +
                                 "(pointer input still follows the sort order). Keep overlay canvases that must cover the screen off it, " +
                                 "or report the Unity version.", this);
            }
        }

        /// <summary>
        /// Renders <paramref name="settings"/> into a texture of its own; <paramref name="madeFrom"/>: the driven asset a copy
        /// was made from while driven (it holds the composite's settings; it gets back what the asset had), else null (it
        /// keeps its own).
        /// </summary>
        void Drive(PanelSettings settings, Driven madeFrom)
        {
            if (settings == null || TargetOf(settings) != null) return;
            var d = new Driven { Settings = settings, Screen = m_Screen };
            if (madeFrom != null)
            {
                d.OldTarget = madeFrom.OldTarget;
                d.OldForceGamma = madeFrom.OldForceGamma;
                d.OldClearColor = madeFrom.OldClearColor;
                d.OldClearValue = madeFrom.OldClearValue;
            }
            else
            {
                d.OldTarget = settings.targetTexture;
                d.OldForceGamma = settings.forceGammaRendering;
                d.OldClearColor = settings.clearColor;
                d.OldClearValue = settings.colorClearValue;
            }
            d.Target = CreateTarget(m_Size.x, m_Size.y);
            settings.targetTexture = d.Target;
            settings.forceGammaRendering = true;
            settings.clearColor = true;
            settings.colorClearValue = Color.clear;
            // pointer input: UI Toolkit passes screen pixels (origin top left, as for an on-screen panel) through this
            // function and divides by the panel's scale; it gives the texture's pixels, so a texture of another size than
            // the screen maps too (tested against an on-screen panel: GammaCompositeTests). A copy has none of its own
            // (a delegate is not copied), so it gets UI Toolkit's own back.
            d.OldMapping = AssignedMapping(settings);
            settings.SetScreenToPanelSpaceFunction(d.ScreenToTexture);
            m_Driven.Add(d);
        }

        /// <summary>Gives one driven PanelSettings what it had and releases its texture.</summary>
        void Undrive(PanelSettings settings)
        {
            for (int i = m_Driven.Count - 1; i >= 0; i--)
            {
                if (!ReferenceEquals(m_Driven[i].Settings, settings)) continue; // Unity's == calls any two destroyed objects equal
                Restore(m_Driven[i]);
                m_Driven.RemoveAt(i);
            }
        }

        /// <summary>
        /// Releases the textures of driven PanelSettings that were destroyed without being released (a copy destroyed by other
        /// code): nothing renders into them any more, and a resize would otherwise make them again.
        /// </summary>
        void PruneDestroyed()
        {
            for (int i = m_Driven.Count - 1; i >= 0; i--)
            {
                var d = m_Driven[i];
                if ((object)d.Settings == null || d.Settings != null) continue;
                Release(ref d.Target);
                m_Driven.RemoveAt(i);
            }
        }

        static void Restore(Driven d)
        {
            if (d.Settings != null)
            {
                d.Settings.targetTexture = d.OldTarget;
                d.Settings.forceGammaRendering = d.OldForceGamma;
                d.Settings.clearColor = d.OldClearColor;
                d.Settings.colorClearValue = d.OldClearValue;
                RestoreMapping(d.Settings, d.OldMapping);
            }
            Release(ref d.Target);
        }

        // PanelSettings has no getter for its screen-to-panel function (Unity 6000.3: the assigned one is m_AssignedScreenToPanel,
        // null for UI Toolkit's own, BaseRuntimePanel.DefaultScreenToPanelSpace); a null function cannot be set back
        static readonly FieldInfo s_AssignedMapping = typeof(PanelSettings).GetField("m_AssignedScreenToPanel", BindingFlags.Instance | BindingFlags.NonPublic);
        static readonly FieldInfo s_DefaultMapping = typeof(PanelSettings).Assembly.GetType("UnityEngine.UIElements.BaseRuntimePanel")
            ?.GetField("DefaultScreenToPanelSpace", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);

        /// <summary>The screen-to-panel function the game gave the PanelSettings, or null (UI Toolkit's own).</summary>
        static Func<Vector2, Vector3> AssignedMapping(PanelSettings settings) => s_AssignedMapping?.GetValue(settings) as Func<Vector2, Vector3>;

        /// <summary>Gives the PanelSettings the function it had: the game's, or UI Toolkit's own (left unassigned again).</summary>
        static void RestoreMapping(PanelSettings settings, Func<Vector2, Vector3> previous)
        {
            if (previous != null)
            {
                settings.SetScreenToPanelSpaceFunction3D(previous);
                return;
            }
            // UI Toolkit's own function; an on-screen panel's maps one to one (the fallback when the internals moved)
            var own = s_DefaultMapping?.GetValue(null) as Func<Vector2, Vector3> ?? (p => new Vector3(p.x, p.y, 0));
            settings.SetScreenToPanelSpaceFunction3D(own);
            s_AssignedMapping?.SetValue(settings, null);
        }

        /// <summary>Gives the PanelSettings (the asset and the copies it drives) their own settings back and releases the textures.</summary>
        internal void Detach()
        {
            DesignUiOverlayOrder.Remove(this);
            m_Ordered = false;
            foreach (var d in m_Driven) Restore(d);
            m_Driven.Clear();
            m_Owned = null;
            s_Attached.Remove(this);
            if (m_Material != null) Free(m_Material);
            m_Material = null;
        }

        /// <summary>New textures of the given size for every driven PanelSettings (the screen changed size); the old ones are released.</summary>
        internal void Resize(Vector2Int target, Vector2Int screen)
        {
            if (m_Owned == null) return;
            m_Size = target;
            m_Screen = screen;
            PruneDestroyed();
            foreach (var d in m_Driven)
            {
                var old = d.Target;
                d.Target = CreateTarget(target.x, target.y);
                d.Screen = screen;
                if (d.Settings != null) d.Settings.targetTexture = d.Target;
                Release(ref old);
            }
        }

        /// <summary>
        /// Draws the panel texture over <paramref name="destination"/> (null: the screen): sRGB-encoded premultiplied
        /// colours decoded to linear light, blended "over" what is there.
        /// </summary>
        public void Composite(RenderTexture destination)
        {
            PruneDestroyed();
            if (m_Driven.Count == 0 || !EnsureMaterial()) return;
            // in the panels' sort order, as UI Toolkit draws them on screen (the asset before a copy of the same order)
            s_Order.Clear();
            for (int i = 0; i < m_Driven.Count; i++) if (m_Driven[i].Target != null && m_Driven[i].Settings != null) s_Order.Add((m_Driven[i].Settings.sortingOrder, i));
            s_Order.Sort((a, b) => a.order != b.order ? a.order.CompareTo(b.order) : a.index.CompareTo(b.index));
            foreach (var (_, i) in s_Order) Graphics.Blit(m_Driven[i].Target, destination, m_Material);
        }

        static readonly System.Collections.Generic.List<(float order, int index)> s_Order = new System.Collections.Generic.List<(float, int)>();

        bool EnsureMaterial()
        {
            if (m_Material != null) return true;
            var shader = Resources.Load<Shader>(ShaderResource);
            if (shader == null) return false;
            m_Material = new Material(shader) { hideFlags = HideFlags.HideAndDontSave };
            return true;
        }

        /// <summary>
        /// Draws the texture of <paramref name="settings"/> (the asset or a copy this composite renders) over the target the
        /// overlay pass has bound, as <see cref="Composite"/> does: called by <see cref="DesignUiOverlayOrder"/> when UI
        /// Toolkit's walk over its screen panels reaches that panel. False when this composite does not render it.
        /// </summary>
        internal bool DrawInPass(PanelSettings settings)
        {
            var target = TargetOf(settings);
            if (target == null || !EnsureMaterial()) return false;
            m_Material.mainTexture = target;
            if (!m_Material.SetPass(0)) return false;
            GL.PushMatrix();
            GL.LoadOrtho();
            GL.Begin(GL.QUADS);
            GL.TexCoord2(0, 0); GL.Vertex3(0, 0, 0);
            GL.TexCoord2(0, 1); GL.Vertex3(0, 1, 0);
            GL.TexCoord2(1, 1); GL.Vertex3(1, 1, 0);
            GL.TexCoord2(1, 0); GL.Vertex3(1, 0, 0);
            GL.End();
            GL.PopMatrix();
            return true;
        }

        static RenderTexture CreateTarget(int width, int height)
        {
            var desc = new RenderTextureDescriptor(Mathf.Max(1, width), Mathf.Max(1, height))
            {
                graphicsFormat = GraphicsFormat.R8G8B8A8_UNorm,
                depthStencilFormat = GraphicsFormat.D24_UNorm_S8_UInt, // rounded clipping uses the stencil
                msaaSamples = 1,
                mipCount = 1,
                useMipMap = false,
                sRGB = false,
            };
            var rt = new RenderTexture(desc) { name = "DesignUiGammaComposite", hideFlags = HideFlags.HideAndDontSave };
            rt.Create();
            return rt;
        }

        static void Release(ref RenderTexture rt)
        {
            if (rt == null) return;
            rt.Release();
            Free(rt);
            rt = null;
        }

        static void Free(UnityEngine.Object o)
        {
            if (Application.isPlaying) UnityEngine.Object.Destroy(o);
            else UnityEngine.Object.DestroyImmediate(o);
        }
    }
}
