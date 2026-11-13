using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// A generated item view of a repeat (<c>data-u-repeat</c>). Before every bind the repeat tells the item its index;
    /// the item clears its action events then, so the bind callback subscribes the item's actions for the data it shows.
    /// </summary>
    public interface IDesignRepeatItem
    {
        void BeginBind(int index);
    }

    /// <summary>
    /// An inline repeat (spec 10): pooled items inside the repeat container. The first item is the one the screen's UXML
    /// holds; more are cloned from the item template when a count first needs them and stay in the pool: a smaller count
    /// hides the rest (<c>display: none</c>), a larger one shows them again. The first shown item keeps the
    /// <c>__first</c> class the design's gap needs. Allocates only when the pool grows.
    /// </summary>
    public sealed class DesignInlineRepeat<TItem> where TItem : class, IDesignRepeatItem
    {
        readonly VisualElement m_Container;
        readonly VisualTreeAsset m_Template;
        readonly Func<VisualElement[], TItem> m_Create;
        readonly bool[] m_First;
        readonly List<VisualElement[]> m_Roots = new List<VisualElement[]>();
        readonly List<TItem> m_Items = new List<TItem>();
        readonly List<VisualElement> m_Clone = new List<VisualElement>();

        /// <param name="container">The repeat container.</param>
        /// <param name="rootNames">The names of an item's root elements (usually one; a shadowed item has its host too).</param>
        /// <param name="template">The item template (<c>&lt;Repeat&gt;Item.uxml</c>) more items are cloned from.</param>
        /// <param name="create">Creates the item view over an item's root elements.</param>
        public DesignInlineRepeat(VisualElement container, string[] rootNames, VisualTreeAsset template, Func<VisualElement[], TItem> create)
        {
            m_Container = container ?? throw new ArgumentNullException(nameof(container));
            m_Template = template;
            m_Create = create ?? throw new ArgumentNullException(nameof(create));
            if (rootNames == null || rootNames.Length == 0) throw new ArgumentException("an item has at least one root element", nameof(rootNames));
            var first = new VisualElement[rootNames.Length];
            for (int k = 0; k < rootNames.Length; k++)
            {
                foreach (var child in container.Children())
                    if (child.name == rootNames[k]) { first[k] = child; break; }
                if (first[k] == null)
                    throw new InvalidOperationException("repeat container '" + container.name + "' has no item element '" + rootNames[k] + "'; recompile the screen when the design changed");
            }
            m_First = new bool[first.Length];
            for (int k = 0; k < first.Length; k++) m_First[k] = first[k].ClassListContains(DesignView.FirstItemClass);
            m_Roots.Add(first);
            m_Items.Add(create(first));
        }

        /// <summary>The number of items shown by the last <see cref="SetItems"/>; -1 before it (the screen's UXML shows its one item).</summary>
        public int Count { get; private set; } = -1;

        /// <summary>The number of items made so far (shown and pooled).</summary>
        public int PoolSize => m_Items.Count;

        /// <summary>Item <paramref name="index"/> of the pool (shown or not).</summary>
        public TItem this[int index] => m_Items[index];

        /// <summary>Shows <paramref name="count"/> items and calls <paramref name="bind"/> for each, in order.</summary>
        public void SetItems(int count, Action<TItem, int> bind)
        {
            if (count < 0) throw new ArgumentOutOfRangeException(nameof(count));
            while (m_Items.Count < count) Grow();
            for (int i = 0; i < m_Items.Count; i++) Show(m_Roots[i], i < count);
            Count = count;
            for (int i = 0; i < count; i++)
            {
                var item = m_Items[i];
                item.BeginBind(i);
                bind?.Invoke(item, i);
            }
        }

        void Grow()
        {
            if (m_Template == null) throw new InvalidOperationException("repeat container '" + m_Container.name + "' has no item template to clone more items from");
            var holder = new VisualElement();
            m_Template.CloneTree(holder);
            m_Clone.Clear();
            foreach (var child in holder.Children()) m_Clone.Add(child);
            if (m_Clone.Count != m_First.Length)
                throw new InvalidOperationException("the item template of '" + m_Container.name + "' has " + m_Clone.Count + " root elements, the screen's item " + m_First.Length +
                                                    "; recompile the screen");
            var roots = m_Clone.ToArray();
            var last = m_Roots[m_Roots.Count - 1];
            int at = m_Container.IndexOf(last[last.Length - 1]) + 1;
            for (int k = 0; k < roots.Length; k++)
            {
                roots[k].RemoveFromHierarchy();
                if (m_First[k]) roots[k].RemoveFromClassList(DesignView.FirstItemClass); // only the first item has it
                m_Container.Insert(at++, roots[k]);
            }
            m_Roots.Add(roots);
            m_Items.Add(m_Create(roots));
        }

        static void Show(VisualElement[] roots, bool show)
        {
            for (int k = 0; k < roots.Length; k++)
            {
                var style = roots[k].style;
                if (show)
                {
                    if (style.display.keyword != StyleKeyword.Null) style.display = StyleKeyword.Null;
                }
                else if (style.display.keyword != StyleKeyword.Undefined || style.display.value != DisplayStyle.None) style.display = DisplayStyle.None;
            }
        }
    }

    /// <summary>
    /// A list repeat (spec 10): a virtualized ListView whose slots hold the item template. The ListView makes as many
    /// slots as fit and rebinds them while scrolling; each slot has one item view for its life. With fixed-height slots
    /// (items of one px height) the compiler sets <c>fixed-item-height</c>; otherwise the ListView measures each item
    /// (dynamic height) and the view keeps the <c>__first</c> class on the first item for the design's gap.
    /// </summary>
    public sealed class DesignListRepeat<TItem> where TItem : class, IDesignRepeatItem
    {
        sealed class Slot
        {
            public TItem Item;
            public VisualElement[] Roots;
            public bool[] First;
        }

        readonly ListView m_List;
        readonly VisualTreeAsset m_Template;
        readonly Func<VisualElement[], TItem> m_Create;
        readonly DesignCountList m_Source = new DesignCountList();
        readonly List<TItem> m_Made = new List<TItem>();
        Action<TItem, int> m_Bind;

        public DesignListRepeat(ListView list, VisualTreeAsset template, Func<VisualElement[], TItem> create)
        {
            m_List = list ?? throw new ArgumentNullException(nameof(list));
            m_Template = template ?? throw new ArgumentNullException(nameof(template));
            m_Create = create ?? throw new ArgumentNullException(nameof(create));
            list.makeItem = MakeItem;
            list.bindItem = BindItem;
        }

        /// <summary>The number of items in the list.</summary>
        public int Count => m_Source.Count;

        /// <summary>The item views the ListView made so far (its slots).</summary>
        public IReadOnlyList<TItem> Made => m_Made;

        /// <summary>
        /// Gives the list <paramref name="count"/> items; <paramref name="bind"/> is called for each item the ListView shows,
        /// now and whenever it binds a slot to another index (scrolling).
        /// </summary>
        public void SetItems(int count, Action<TItem, int> bind)
        {
            if (count < 0) throw new ArgumentOutOfRangeException(nameof(count));
            m_Bind = bind;
            m_Source.Count = count;
            if (m_List.itemsSource != m_Source) m_List.itemsSource = m_Source;
            else m_List.RefreshItems();
        }

        VisualElement MakeItem()
        {
            var slot = new VisualElement();
            m_Template.CloneTree(slot);
            var roots = new VisualElement[slot.childCount];
            for (int k = 0; k < roots.Length; k++) roots[k] = slot[k];
            var first = new bool[roots.Length];
            for (int k = 0; k < roots.Length; k++) first[k] = roots[k].ClassListContains(DesignView.FirstItemClass);
            var item = m_Create(roots);
            m_Made.Add(item);
            slot.userData = new Slot { Item = item, Roots = roots, First = first };
            return slot;
        }

        void BindItem(VisualElement element, int index)
        {
            if (!(element.userData is Slot slot)) return;
            for (int k = 0; k < slot.Roots.Length; k++)
                if (slot.First[k]) slot.Roots[k].EnableInClassList(DesignView.FirstItemClass, index == 0);
            slot.Item.BeginBind(index);
            m_Bind?.Invoke(slot.Item, index);
        }
    }

    /// <summary>A read-only list of the indices 0..Count-1, the items source of a list repeat (no data is copied).</summary>
    public sealed class DesignCountList : IList
    {
        int m_Count;

        public int Count
        {
            get => m_Count;
            set => m_Count = value < 0 ? throw new ArgumentOutOfRangeException(nameof(value)) : value;
        }

        public object this[int index]
        {
            get => index >= 0 && index < m_Count ? index : throw new ArgumentOutOfRangeException(nameof(index));
            set => throw new NotSupportedException();
        }

        public bool IsFixedSize => false;
        public bool IsReadOnly => true;
        public bool IsSynchronized => false;
        public object SyncRoot => this;
        public int Add(object value) => throw new NotSupportedException();
        public void Clear() => throw new NotSupportedException();
        public bool Contains(object value) => IndexOf(value) >= 0;
        public int IndexOf(object value) => value is int i && i >= 0 && i < m_Count ? i : -1;
        public void Insert(int index, object value) => throw new NotSupportedException();
        public void Remove(object value) => throw new NotSupportedException();
        public void RemoveAt(int index) => throw new NotSupportedException();

        public void CopyTo(Array array, int index)
        {
            for (int i = 0; i < m_Count; i++) array.SetValue(i, index + i);
        }

        public IEnumerator GetEnumerator()
        {
            for (int i = 0; i < m_Count; i++) yield return i;
        }
    }
}
