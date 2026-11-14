// Composites a design panel rendered in gamma space (an R8G8B8A8_UNorm RenderTexture with
// PanelSettings.forceGammaRendering, as the design's browser blends) over the screen of a Linear-colour-space project:
// the texture holds sRGB-encoded, premultiplied colours, which this pass decodes to linear light, so the screen's sRGB
// target stores the panel's bytes unchanged where the panel is opaque (DesignUiGammaComposite).
Shader "Hidden/DesignUi/GammaComposite"
{
    Properties
    {
        _MainTex ("Panel", 2D) = "black" {}
    }
    SubShader
    {
        Cull Off ZWrite Off ZTest Always
        Blend One OneMinusSrcAlpha
        Pass
        {
            CGPROGRAM
            #pragma vertex vert_img
            #pragma fragment frag
            #include "UnityCG.cginc"

            sampler2D _MainTex;

            float3 Decode(float3 c)
            {
                // the exact sRGB transfer function (GammaToLinearSpace is an approximation)
                return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
            }

            float4 frag(v2f_img i) : SV_Target
            {
                float4 c = tex2D(_MainTex, i.uv);
                if (c.a <= 0) return 0;
                float3 straight = saturate(c.rgb / c.a);
                return float4(Decode(straight) * c.a, c.a);
            }
            ENDCG
        }
    }
    Fallback Off
}
