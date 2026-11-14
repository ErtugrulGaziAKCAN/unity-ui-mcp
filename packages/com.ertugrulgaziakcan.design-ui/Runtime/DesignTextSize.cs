using System;
using UnityEngine;

namespace DesignUi
{
    /// <summary>
    /// One step of the game's text-size setting (spec 13): its key and the scale it gives every design text size. The
    /// DesignUiProfile lists the steps; the compiler writes their rules (<c>.text-size-&lt;key&gt;</c> on the screen root:
    /// every font size times the scale, each kit line box with its scaled line-box twin) and records them in the font set,
    /// so the runtime only swaps the root class.
    /// </summary>
    [Serializable]
    public sealed class DesignTextSize
    {
        [Tooltip("The option's key, as the game's IDesignTextSizeSource reports it: lower-case ASCII letters, digits, '-' and '_'.")]
        public string key;

        [Tooltip("The factor every design text size is multiplied by (1: the design's sizes).")]
        public float scale = 1f;

        public DesignTextSize Clone() => (DesignTextSize)MemberwiseClone();
    }
}
