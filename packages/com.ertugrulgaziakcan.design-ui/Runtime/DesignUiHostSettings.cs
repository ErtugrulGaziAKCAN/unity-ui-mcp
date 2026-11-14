using System;
using UnityEngine;

namespace DesignUi
{
    /// <summary>
    /// How a design screen sits next to a uGUI shell (spec 16, uGUI coexistence). The project's DesignUiProfile holds the
    /// values; a <see cref="DesignUiPanelRegion"/> added in the Editor copies them.
    /// <para>
    /// Unity 6000.3 has no input priority of its own for a panel: with an EventSystem, uGUI's PanelRaycaster orders a
    /// panel's raycasts by the panel's sort order, so <see cref="sortingOrder"/> sets both where the screen draws and
    /// whether it takes the pointer before a canvas. Hosts that route pointer input outside the EventSystem ask
    /// <see cref="DesignUiPanelRegion.IsPointerOverPanel"/>.
    /// </para>
    /// </summary>
    [Serializable]
    public sealed class DesignUiHostSettings
    {
        [Tooltip("Sort order of the panel the screen renders on (PanelSettings.sortingOrder): draw order against other panels and Screen Space Overlay canvases, and, with an EventSystem, the order of its pointer raycasts against canvases. When the document's PanelSettings asset has another value, the region renders it on a runtime copy with this value.")]
        public float sortingOrder;

        [Tooltip("Order of the screen's document among the documents on the same panel (UIDocument.sortingOrder): a higher value draws above them and is picked first.")]
        public float documentOrder;

        public DesignUiHostSettings Clone() => (DesignUiHostSettings)MemberwiseClone();
    }
}
