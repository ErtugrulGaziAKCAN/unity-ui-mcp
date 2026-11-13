using System;

namespace DesignUi
{
    /// <summary>
    /// The game's text-size setting, which design screens follow (spec 13): the game decides the options and their
    /// scales. A screen root carries the class <c>text-size-&lt;TextSize&gt;</c> and its text renders at the design's size
    /// times <see cref="TextScale"/>.
    /// </summary>
    public interface IDesignTextSizeSource
    {
        /// <summary>The option's key (<c>small</c>, <c>normal</c>, <c>large</c>…): lower-case ASCII letters, digits, '-' and '_'.</summary>
        string TextSize { get; }

        /// <summary>The option's scale; 1 renders the design's sizes.</summary>
        float TextScale { get; }

        /// <summary>Raised when the option or its scale changes.</summary>
        event Action TextSizeChanged;
    }
}
