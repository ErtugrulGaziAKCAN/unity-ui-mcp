using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// The root element of a compiled design screen. It carries the screen's own reference to the compiled font set
    /// (<c>DesignFonts.asset</c>, the UXML attribute <c>fonts</c>), so the generated view prepares bound text in the locale's
    /// twins without any wiring by the game, and it tells a <see cref="LocaleFontController"/> above it that it was attached
    /// (anywhere below the controller's root), so the screen gets the locale, right-to-left and text-size classes at once.
    /// Otherwise it is a plain VisualElement: it adds no style and no class.
    /// </summary>
    [UxmlElement]
    public partial class DesignScreen : VisualElement
    {
        /// <summary>The compiled font set of the screen (written by the compiler), or null.</summary>
        [UxmlAttribute("fonts")]
        public DesignFontSet Fonts { get; set; }

        public DesignScreen()
        {
            RegisterCallback<AttachToPanelEvent>(OnAttach);
            RegisterCallback<DetachFromPanelEvent>(OnDetach);
        }

        void OnAttach(AttachToPanelEvent e) => LocaleFontController.ScreenAttached(this);

        void OnDetach(DetachFromPanelEvent e) => LocaleFontController.ScreenDetached(this);
    }
}
