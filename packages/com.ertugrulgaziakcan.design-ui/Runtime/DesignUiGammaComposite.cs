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
    /// <c>R8G8B8A8_UNorm</c> RenderTexture with <see cref="PanelSettings.forceGammaRendering"/> on, and at the end of every
    /// frame the texture is composited over the screen, decoded to linear light, so the screen stores the panel's colours
    /// unchanged. Within the panel every colour matches the verifier's capture; where the panel is translucent over the
    /// game's own camera image, that last blend is in linear light. Costs a screen-sized colour and depth-stencil texture
    /// (2 × 4 bytes per pixel, 29.5 MB at 2560×1440) and one full-screen pass per frame. Does nothing in a Gamma project.
    /// <para>
    /// Add it once per PanelSettings asset (for example next to the UIDocument). While it is enabled it owns the asset's
    /// <c>targetTexture</c>, <c>forceGammaRendering</c>, clear settings and screen-to-panel function, and gives them back
    /// when disabled or destroyed. Pointer input maps screen pixels to the texture's pixels, as for an on-screen panel.
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

        RenderTexture m_Target;
        Material m_Material;
        PanelSettings m_Owned;
        RenderTexture m_OldTarget;
        Func<Vector2, Vector3> m_OldMapping;
        Vector2Int m_Screen;
        bool m_OldForceGamma, m_OldClearColor;
        Color m_OldClearValue;
        Coroutine m_Loop;

        /// <summary>The texture the panels render into while the component runs, else null.</summary>
        public RenderTexture Target => m_Target;

        static readonly System.Collections.Generic.List<DesignUiGammaComposite> s_Attached = new System.Collections.Generic.List<DesignUiGammaComposite>();

        /// <summary>
        /// Whether an attached composite renders these PanelSettings (its own, or a runtime copy made from it while it was
        /// attached, which shares its texture).
        /// </summary>
        public static bool Drives(PanelSettings settings)
        {
            if (settings == null) return false;
            foreach (var c in s_Attached)
                if (c != null && (c.m_Owned == settings || c.m_Target != null && settings.targetTexture == c.m_Target)) return true;
            return false;
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
            if (m_Target != null && (m_Target.width != Screen.width || m_Target.height != Screen.height))
                Resize(new Vector2Int(Screen.width, Screen.height), new Vector2Int(Screen.width, Screen.height));
        }

        IEnumerator CompositeAtEndOfFrame()
        {
            var end = new WaitForEndOfFrame();
            while (true)
            {
                yield return end;
                Composite(null);
            }
        }

        /// <summary>Makes <paramref name="settings"/> render into a new gamma-space texture of the given size.</summary>
        internal void Attach(PanelSettings settings, Vector2Int target, Vector2Int screen)
        {
            int width = target.x, height = target.y;
            Detach();
            m_Owned = settings;
            m_OldTarget = settings.targetTexture;
            m_OldForceGamma = settings.forceGammaRendering;
            m_OldClearColor = settings.clearColor;
            m_OldClearValue = settings.colorClearValue;
            m_Target = CreateTarget(width, height);
            settings.targetTexture = m_Target;
            settings.forceGammaRendering = true;
            settings.clearColor = true;
            settings.colorClearValue = Color.clear;
            // pointer input: UI Toolkit passes screen pixels (origin top left, as for an on-screen panel) through this
            // function and divides by the panel's scale; it gives the texture's pixels, so a texture of another size than
            // the screen maps too (tested against an on-screen panel: GammaCompositeTests)
            m_OldMapping = AssignedMapping(settings);
            m_Screen = screen;
            settings.SetScreenToPanelSpaceFunction(ScreenToTexture);
            s_Attached.Add(this);
        }

        Vector2 ScreenToTexture(Vector2 screen)
        {
            if (m_Target == null || m_Screen.x <= 0 || m_Screen.y <= 0) return screen;
            return new Vector2(screen.x * m_Target.width / m_Screen.x, screen.y * m_Target.height / m_Screen.y);
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

        /// <summary>Gives the PanelSettings its own settings back and releases the texture.</summary>
        internal void Detach()
        {
            if (m_Owned != null)
            {
                m_Owned.targetTexture = m_OldTarget;
                m_Owned.forceGammaRendering = m_OldForceGamma;
                m_Owned.clearColor = m_OldClearColor;
                m_Owned.colorClearValue = m_OldClearValue;
                RestoreMapping(m_Owned, m_OldMapping);
            }
            m_Owned = null;
            m_OldMapping = null;
            s_Attached.Remove(this);
            Release(ref m_Target);
            if (m_Material != null) Free(m_Material);
            m_Material = null;
        }

        internal void Resize(Vector2Int target, Vector2Int screen)
        {
            if (m_Owned == null) return;
            var old = m_Target;
            m_Target = CreateTarget(target.x, target.y);
            m_Screen = screen;
            m_Owned.targetTexture = m_Target;
            Release(ref old);
        }

        /// <summary>
        /// Draws the panel texture over <paramref name="destination"/> (null: the screen): sRGB-encoded premultiplied
        /// colours decoded to linear light, blended "over" what is there.
        /// </summary>
        public void Composite(RenderTexture destination)
        {
            if (m_Target == null) return;
            if (m_Material == null)
            {
                var shader = Resources.Load<Shader>(ShaderResource);
                if (shader == null) return;
                m_Material = new Material(shader) { hideFlags = HideFlags.HideAndDontSave };
            }
            Graphics.Blit(m_Target, destination, m_Material);
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
