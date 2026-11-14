using System.Collections;
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
    /// <c>targetTexture</c>, <c>forceGammaRendering</c> and clear settings, and restores them when disabled. Pointer input
    /// maps one to one, as the texture is the screen's size.
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
        bool m_OldForceGamma, m_OldClearColor;
        Color m_OldClearValue;
        Coroutine m_Loop;

        /// <summary>The texture the panels render into while the component runs, else null.</summary>
        public RenderTexture Target => m_Target;

        /// <summary>Whether the project needs the composite: only a Linear-colour-space project blends UI in linear light.</summary>
        public static bool Needed => QualitySettings.activeColorSpace == ColorSpace.Linear;

        void OnEnable()
        {
            if (!Needed || panelSettings == null) return;
            Attach(panelSettings, Screen.width, Screen.height);
            m_Loop = StartCoroutine(CompositeAtEndOfFrame());
        }

        void OnDisable()
        {
            if (m_Loop != null) StopCoroutine(m_Loop);
            m_Loop = null;
            Detach();
        }

        void Update()
        {
            if (m_Target != null && (m_Target.width != Screen.width || m_Target.height != Screen.height))
                Resize(Screen.width, Screen.height);
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
        internal void Attach(PanelSettings settings, int width, int height)
        {
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
            settings.SetScreenToPanelSpaceFunction(p => p); // the texture is the screen's size
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
            }
            m_Owned = null;
            Release(ref m_Target);
            if (m_Material != null) Free(m_Material);
            m_Material = null;
        }

        void Resize(int width, int height)
        {
            if (m_Owned == null) return;
            var old = m_Target;
            m_Target = CreateTarget(width, height);
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

        static void Free(Object o)
        {
            if (Application.isPlaying) Object.Destroy(o);
            else Object.DestroyImmediate(o);
        }
    }
}
