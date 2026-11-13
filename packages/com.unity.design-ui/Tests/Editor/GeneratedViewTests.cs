using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using DesignUi.Editor.Tests.Generated;
using Newtonsoft.Json;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.TestTools.Constraints;
using UnityEngine.UIElements;
using static DesignUi.Editor.Tests.TestIr;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The generated view (spec 9) compiled and driven: <c>Generated/ViewSampleView.g.cs</c> is the writer's output for
    /// <see cref="SampleIr"/>, checked in so the test assembly compiles it; a snapshot test keeps it current.
    /// </summary>
    public class GeneratedViewTests
    {
        const string Namespace = "DesignUi.Editor.Tests.Generated";
        const string ClassName = "ViewSampleView";

        static string FixturePath() => IrReaderTests.PackagePath("Tests", "Editor", "Generated", ClassName + ".g.cs");

        static IrNode Inter(IrNode text, string size)
        {
            text.Style["base"]["font-family"] = "Inter";
            text.Style["base"]["font-size"] = size;
            text.Style["base"]["color"] = "#ffffff";
            return text;
        }

        /// <summary>
        /// A screen with a bound text (32 px, for the kerning check), a text with a Smart String argument, a button action,
        /// a plain element with an action and a selection class, a button with a disabled layer, an inline repeat with a gap
        /// and an action in its items, and a list repeat whose rows bind a text, raise an action and hold a nested inline
        /// repeat; two states.
        /// </summary>
        internal static IrScreen SampleIr()
        {
            var club = Inter(Text("club", "x", ("align-self", "flex-start")), "32px");
            club.Bind = "club.name";
            var title = Inter(Text("title", "Hoş geldin {name}", ("align-self", "flex-start")), "16px");
            title.Text.Args = new[] { "name" };

            var play = Node("play", "button", ("width", "100px"), ("height", "30px"), ("background-color", "#444444"))
                .Add(Inter(Text("play-label", "Oyna"), "16px"));
            play.Action = "play";
            var card = Node("card", "container", ("width", "100px"), ("height", "40px"), ("background-color", "#666666"))
                .With("class:is-selected", ("background-color", "#00ff00"));
            card.Action = "open-card";
            var save = Inter(Node("save", "button", ("width", "100px"), ("height", "30px"), ("background-color", "#444444")), "16px")
                .With("disabled", ("opacity", "0.5"));
            save.Text = new IrText { Key = "test.save", Tr = "Kaydet", En = "Save" };
            save.Initial = new IrInitial();

            var chipLabel = Inter(Text("chip-label", "a"), "16px");
            chipLabel.Bind = "chip.name";
            var chip = Node("chip", "container", ("width", "60px"), ("height", "20px"), ("background-color", "#333333")).Add(chipLabel);
            chip.Action = "pick-chip";
            var chips = Node("chips", "container", ("display", "flex"), ("flex-direction", "row"), ("gap", "4px"), ("height", "20px")).Add(chip);
            chips.Repeat = new IrRepeat { Name = "chip", Mode = "inline", Count = 3 };

            var cellValue = Inter(Text("cell-value", "1"), "16px");
            cellValue.Bind = "cell.value";
            var cell = Node("cell", "container", ("width", "20px"), ("height", "20px")).Add(cellValue);
            var cells = Node("cells", "container", ("display", "flex"), ("flex-direction", "row"), ("gap", "2px")).Add(cell);
            cells.Repeat = new IrRepeat { Name = "cell", Mode = "inline", Count = 2 };
            var rowName = Inter(Text("row-name", "b", ("width", "100px")), "16px");
            rowName.Bind = "row.name";
            var row = Node("row", "container", ("display", "flex"), ("flex-direction", "row"), ("height", "20px")).Add(rowName, cells);
            row.Action = "open-row";
            var rows = Node("rows", "list", ("display", "flex"), ("flex-direction", "column"), ("overflow-y", "auto"), ("height", "100px")).Add(row);
            rows.Repeat = new IrRepeat { Name = "row", Mode = "list", Count = 4 };

            var root = Node("root", "container", ("display", "flex"), ("flex-direction", "column"), ("width", "800px"), ("height", "600px"))
                .With("state:loading", ("opacity", "0.5"))
                .Add(club, title, play, card, save, chips, rows);
            return TestIr.Screen(root, "view.sample");
        }

        internal static string Generate() => ViewCodeWriter.Write(ScreenBuilder.Build(SampleIr(), RelativeAsset, null, null), Namespace, ClassName);

        const string Out = "Assets/DesignUiGeneratedViewTests";
        /// <summary>Strongly kerned pairs in Inter: AV, VA, AT, TA, To, Wa, Ya; none of A, V, T, R, W is in the screen's strings.</summary>
        const string Kerned = "AVATAR Toyota Wave";

        readonly List<string> _temp = new List<string>();
        readonly List<LocaleFontController> _controllers = new List<LocaleFontController>();
        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;
        DesignFontSet _previousFonts;

        [SetUp]
        public void Remember()
        {
            _previousFonts = DesignText.Fonts;
            DesignText.Fonts = null; // the view must find the font set itself
        }

        [TearDown]
        public void Cleanup()
        {
            foreach (var c in _controllers) c.Dispose();
            _controllers.Clear();
            if (_go != null) Object.DestroyImmediate(_go);
            if (_settings != null) Object.DestroyImmediate(_settings);
            if (_rt != null) Object.DestroyImmediate(_rt);
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            if (AssetDatabase.IsValidFolder(Out)) AssetDatabase.DeleteAsset(Out);
            FontFixture.Delete(); // fresh twins for every test: their atlas starts empty
            DesignText.Fonts = _previousFonts;
        }

        string TempDir()
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-view-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            return dir;
        }

        /// <summary>Compiles <see cref="SampleIr"/> into <see cref="Out"/> (no view file: the test assembly has the checked-in one).</summary>
        DesignFontSet Compile(Action<DesignUiProfile> setup = null)
        {
            var dir = TempDir();
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(SampleIr(), Formatting.Indented));
            var profile = ScriptableObject.CreateInstance<DesignUiProfile>();
            profile.outputFolder = Out;
            FontFixture.Use(profile);
            setup?.Invoke(profile);
            var result = ScreenCompiler.Compile(dir, profile, false, NoView());
            Object.DestroyImmediate(profile);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var vta = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/ViewSample/ViewSample.uxml");
            Assert.IsFalse(vta.importedWithErrors || vta.importedWithWarnings, "the screen's UXML (font set reference, item templates) imports cleanly");
            return AssetDatabase.LoadAssetAtPath<DesignFontSet>(Out + "/" + DesignFontSet.FileName);
        }

        VisualElement Panel()
        {
            _rt = new RenderTexture(800, 600, 24);
            _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.targetTexture = _rt;
            _go = new GameObject("GeneratedViewTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            return doc.rootVisualElement;
        }

        static VisualElement Instantiate() => AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/ViewSample/ViewSample.uxml").Instantiate();

        /// <summary>A click at the element's centre: pointer down and up sent to the panel, as a user's mouse.</summary>
        static void Press(VisualElement element)
        {
            var at = element.worldBound.center;
            var tree = element.panel.visualTree;
            using (var down = PointerDownEvent.GetPooled(new Event { type = EventType.MouseDown, mousePosition = at, button = 0, clickCount = 1 })) tree.SendEvent(down);
            using (var up = PointerUpEvent.GetPooled(new Event { type = EventType.MouseUp, mousePosition = at, button = 0 })) tree.SendEvent(up);
        }

        static IEnumerator Frames(int n)
        {
            for (int i = 0; i < n; i++) yield return null;
        }

        static void AssertColor(string hex, Color actual)
        {
            ColorUtility.TryParseHtmlString(hex, out var expected);
            Assert.AreEqual(expected.r, actual.r, 0.01f, hex);
            Assert.AreEqual(expected.g, actual.g, 0.01f, hex);
            Assert.AreEqual(expected.b, actual.b, 0.01f, hex);
        }

        static List<VisualElement> Shown(VisualElement container) =>
            container.Children().Where(c => c.resolvedStyle.display != DisplayStyle.None).ToList();

        // ---- the checked-in view -----------------------------------------------------------------------------------------

        [Test]
        public void CheckedInView_IsTheWritersOutput()
        {
            var actual = Generate();
            var dump = Path.Combine(Path.GetTempPath(), "design-ui-actual-" + ClassName + ".g.cs");
            File.WriteAllText(dump, actual);
            var path = FixturePath();
            Assert.IsTrue(File.Exists(path), "missing " + path + " (actual written to " + dump + ")");
            Assert.AreEqual(File.ReadAllText(path).Replace("\r\n", "\n"), actual, "the checked-in view differs from the writer's output (actual written to " + dump + ")");
        }

        // ---- driving the compiled sample ---------------------------------------------------------------------------------

        [UnityTest]
        public IEnumerator Setters_WriteThroughDesignText_WithTheScreensOwnFontSet_SoABoundTextsFirstLayoutIsKerned()
        {
            var set = Compile();
            Assert.IsNotNull(set);
            var root = Panel();
            yield return Frames(2);
            var tree = Instantiate();
            root.Add(tree);
            var screen = tree.Q("root") as DesignScreen;
            Assert.IsNotNull(screen, "a compiled screen root is a DesignScreen");
            Assert.AreSame(set, screen.Fonts, "it references the compiled font set itself; nothing was wired");
            var view = new ViewSampleView(tree);
            Assert.IsNull(view.Club.resolvedStyle.unityFontDefinition.fontAsset, "no style pass yet: the font is not resolved");
            view.SetClubName(Kerned); // the frame the screen is attached
            yield return Frames(5);
            var width = view.Club.layout.width;

            var twin = set.FontsFor("tr")[0];
            Assert.AreSame(twin, view.Club.resolvedStyle.unityFontDefinition.fontAsset);
            float unkerned = Kerned.Sum(c => twin.characterLookupTable[c].glyph.metrics.horizontalAdvance) * 32f / twin.faceInfo.pointSize;
            Assert.Less(width, unkerned - 4, "the first layout of the bound text is kerned");
            var again = new Label(Kerned);
            again.style.position = Position.Absolute;
            again.style.fontSize = 32;
            again.style.unityFontDefinition = FontDefinition.FromSDFFont(twin);
            root.Add(again);
            yield return Frames(5);
            Assert.AreEqual(again.layout.width, width, 0.01f, "and equals a later layout of the same text");
        }

        [UnityTest]
        public IEnumerator Setters_FillBindsAndArguments_SkipUnchangedValues_AndAllocateNothingThen()
        {
            Compile();
            var root = Panel();
            yield return Frames(2);
            var tree = Instantiate();
            root.Add(tree);
            var view = new ViewSampleView(tree);
            yield return Frames(3);
            Assert.AreEqual("Hoş geldin {name}", view.Title.text, "the design text is the template");
            view.SetClubName("Galatasaray");
            view.SetName("Ali");
            Assert.AreEqual("Galatasaray", view.Club.text);
            Assert.AreEqual("Hoş geldin Ali", view.Title.text, "the argument is filled into the template");
            Assert.IsFalse(view.Club.enableRichText, "a bound value is plain text");

            view.Club.text = "changed elsewhere";
            view.SetClubName("Galatasaray");
            Assert.AreEqual("changed elsewhere", view.Club.text, "an unchanged value writes nothing");
            view.SetClubName("Beşiktaş");
            Assert.AreEqual("Beşiktaş", view.Club.text);
            view.SetName(null);
            Assert.AreEqual("Hoş geldin ", view.Title.text, "null is an empty value");

            view.SetName("Ali");
            TestDelegate sameBind = () => view.SetClubName("Beşiktaş");
            TestDelegate sameArgument = () => view.SetName("Ali");
            sameBind(); // first calls compile the delegates
            sameArgument();
            Assert.That(sameBind, UnityEngine.TestTools.Constraints.Is.Not.AllocatingGCMemory(), "an unchanged bind");
            Assert.That(sameArgument, UnityEngine.TestTools.Constraints.Is.Not.AllocatingGCMemory(), "an unchanged argument");
        }

        [UnityTest]
        public IEnumerator Actions_RaiseEvents_AButtonThroughClicked_AnotherElementThroughClickEvent()
        {
            Compile();
            var root = Panel();
            yield return Frames(2);
            var tree = Instantiate();
            root.Add(tree);
            var view = new ViewSampleView(tree);
            yield return Frames(3);
            int play = 0, card = 0;
            view.PlayRequested += () => play++;
            view.OpenCardRequested += () => card++;
            Press(view.Play);
            Assert.AreEqual(1, play, "the button");
            Assert.AreEqual(0, card);
            Press(view.Card);
            Assert.AreEqual(1, card, "the plain element");
            Assert.AreEqual(1, play);
        }

        [UnityTest]
        public IEnumerator StateSelectionAndEnabled_ToggleTheClassesAndStateTheDesignsLayersUse()
        {
            Compile();
            var root = Panel();
            yield return Frames(2);
            var tree = Instantiate();
            root.Add(tree);
            var view = new ViewSampleView(tree);
            yield return Frames(3);

            view.SetState(ViewSampleView.State.Loading);
            yield return Frames(2);
            Assert.IsTrue(view.Root.ClassListContains("state-loading"));
            Assert.AreEqual(0.5f, view.Root.resolvedStyle.opacity, 1e-4f);
            view.SetState(ViewSampleView.State.Default);
            yield return Frames(2);
            Assert.IsFalse(view.Root.ClassListContains("state-loading"));
            Assert.AreEqual(1f, view.Root.resolvedStyle.opacity, 1e-4f);

            view.SetSelected(view.Card, true);
            yield return Frames(2);
            Assert.IsTrue(view.Card.ClassListContains("is-selected"));
            AssertColor("#00ff00", view.Card.resolvedStyle.backgroundColor);
            view.SetSelected(view.Card, false);
            yield return Frames(2);
            AssertColor("#666666", view.Card.resolvedStyle.backgroundColor);

            view.SetEnabled(view.Save, false);
            yield return Frames(2);
            Assert.IsFalse(view.Save.enabledSelf);
            Assert.AreEqual(0.5f, view.Save.resolvedStyle.opacity, 1e-4f, "the :disabled layer");
            view.SetEnabled(view.Save, true);
            yield return Frames(2);
            Assert.AreEqual(1f, view.Save.resolvedStyle.opacity, 1e-4f);
        }

        [UnityTest]
        public IEnumerator InlineRepeat_PoolsItems_RebindsThem_AndKeepsTheGapClassOnTheFirst()
        {
            Compile();
            var root = Panel();
            yield return Frames(2);
            var tree = Instantiate();
            root.Add(tree);
            var view = new ViewSampleView(tree);
            yield return Frames(2);
            Assert.AreEqual(1, view.Chips.childCount, "the screen's UXML holds the first item");

            var bound = new List<int>();
            var picked = new List<int>();
            view.SetChip(3, (item, i) =>
            {
                bound.Add(i);
                Assert.AreEqual(i, item.Index);
                item.SetChipName("c" + i);
                item.PickChipRequested += () => picked.Add(i);
            });
            yield return Frames(3);
            CollectionAssert.AreEqual(new[] { 0, 1, 2 }, bound);
            var items = view.Chips.Children().ToList();
            Assert.AreEqual(3, items.Count);
            CollectionAssert.AreEqual(new[] { "c0", "c1", "c2" }, items.Select(c => c.Q<Label>("chip-label").text).ToArray());
            CollectionAssert.AreEqual(new[] { true, false, false }, items.Select(c => c.ClassListContains(DesignView.FirstItemClass)).ToArray(), "only the first item has the gap's first-item class");
            Assert.AreEqual(0f, items[0].resolvedStyle.marginLeft);
            Assert.AreEqual(4f, items[1].resolvedStyle.marginLeft, "the gap");
            Assert.AreEqual(items[0].layout.xMax + 4f, items[1].layout.x, 0.01f);

            Press(items[2]);
            CollectionAssert.AreEqual(new[] { 2 }, picked, "the item's action, subscribed in its bind");

            bound.Clear();
            view.SetChip(1, (item, i) => bound.Add(i));
            yield return Frames(2);
            CollectionAssert.AreEqual(new[] { 0 }, bound);
            Assert.AreEqual(3, view.Chips.childCount, "the other items stay in the pool");
            Assert.AreEqual(1, Shown(view.Chips).Count, "hidden");

            bound.Clear();
            view.SetChip(3, (item, i) => bound.Add(i));
            yield return Frames(2);
            CollectionAssert.AreEqual(new[] { 0, 1, 2 }, bound, "rebound");
            CollectionAssert.AreEqual(items, view.Chips.Children().ToList(), "the same elements: reused, none made");
            Assert.AreEqual(3, Shown(view.Chips).Count);
            picked.Clear();
            Press(items[2]);
            CollectionAssert.IsEmpty(picked, "a rebind clears the item's events");

            view.SetChip(0, null);
            yield return Frames(2);
            Assert.AreEqual(0, Shown(view.Chips).Count, "no items");
        }

        [UnityTest]
        public IEnumerator ListRepeat_IsAVirtualizedListView_WithReusedSlots_ItemActions_AndANestedRepeat()
        {
            Compile();
            var root = Panel();
            yield return Frames(2);
            var tree = Instantiate();
            root.Add(tree);
            var view = new ViewSampleView(tree);
            yield return Frames(2);
            Assert.AreEqual(20f, view.Rows.fixedItemHeight, "items of one px height: fixed-height slots");

            var opened = new List<int>();
            var made = new HashSet<ViewSampleView.RowItemView>();
            void Bind(ViewSampleView.RowItemView row, int i)
            {
                made.Add(row);
                row.SetRowName("r" + i);
                row.SetCell(i % 3 + 1, (cell, j) => cell.SetCellValue(i + "." + j));
                row.OpenRowRequested += () => opened.Add(i);
            }
            view.SetRow(40, Bind);
            yield return Frames(5);
            var slots = view.Rows.Query(className: BaseVerticalCollectionView.itemUssClassName).ToList().Where(x => x.resolvedStyle.display != DisplayStyle.None).ToList();
            Assert.LessOrEqual(slots.Count, 7, "virtualized: only the slots that fit 100 px are made (40 items)");
            Assert.GreaterOrEqual(slots.Count, 5);
            var first = slots.OrderBy(x => x.layout.y).First();
            Assert.AreEqual("r0", first.Q<Label>("row-name").text);
            var second = slots.OrderBy(x => x.layout.y).ElementAt(2);
            Assert.AreEqual("r2", second.Q<Label>("row-name").text);
            var cells = second.Q("cells").Children().Where(c => c.resolvedStyle.display != DisplayStyle.None).ToList();
            Assert.AreEqual(3, cells.Count, "the nested repeat of row 2");
            CollectionAssert.AreEqual(new[] { "2.0", "2.1", "2.2" }, cells.Select(c => c.Q<Label>("cell-value").text).ToArray());

            Press(second.Q("row"));
            CollectionAssert.AreEqual(new[] { 2 }, opened, "the row's action");

            var slotCount = made.Count;
            view.SetRow(2, Bind);
            yield return Frames(3);
            var shown = view.Rows.Query(className: BaseVerticalCollectionView.itemUssClassName).ToList().Where(x => x.resolvedStyle.display != DisplayStyle.None).ToList();
            Assert.AreEqual(2, shown.Count, "two items");
            Assert.AreEqual(slotCount, made.Count, "the slots are reused: no item view made");
            view.SetRow(40, Bind);
            yield return Frames(3);
            Assert.AreEqual(slotCount, made.Count);
        }

        [UnityTest]
        public IEnumerator Screen_InsertedDeepBelowALocaleController_GetsItsClassesAtOnce()
        {
            Compile(p => p.textSizes = new[] { new DesignTextSize { key = "large", scale = 2f } });
            var root = Panel();
            yield return Frames(2);
            var deep = new VisualElement();
            var deeper = new VisualElement();
            deep.Add(deeper);
            root.Add(deep);
            var locales = new LocaleFontControllerTests.Locales("tr");
            var controller = new LocaleFontController(root, null, new DesignLocaleRules(), locales);
            _controllers.Add(controller);
            locales.Set("en");
            controller.SetTextSize("large", 2f);

            var tree = Instantiate();
            deeper.Add(tree); // not a direct child of the controller's root
            var screen = tree.Q("root");
            Assert.IsTrue(screen.ClassListContains("locale-en"), "the DesignScreen reports itself on attach: no Refresh, no frame");
            Assert.IsFalse(screen.ClassListContains("locale-tr"));
            Assert.IsTrue(screen.ClassListContains("text-size-large"));
            yield return Frames(3);
            Assert.AreEqual(64f, screen.Q<Label>("club").resolvedStyle.fontSize, 1e-4f, "the compiled step's rule: 32 px x 2");

            controller.SetTextSize("normal", 1f);
            Assert.IsFalse(screen.ClassListContains("text-size-large"), "a later text size reaches it too");
            tree.RemoveFromHierarchy();
            locales.Set("tr");
            Assert.IsTrue(screen.ClassListContains("locale-en"), "a detached screen is forgotten");
        }

        // ---- generated code of other shapes compiles ---------------------------------------------------------------------

        [UnityTest]
        public IEnumerator GeneratedViews_OfOtherScreens_CompileWithoutWarnings()
        {
            var dir = TempDir();
            var screens = new (string ns, string cls, IrScreen ir)[]
            {
                ("Gen.Sample", "SampleScreenView", IrReader.Read(IrReaderTests.SamplePath())),
                ("Gen.Showcase", "TestShowcaseView", Showcase()),
                ("Gen.Values", "ValuesView", ViewCodeWriterTests.Values()),
                ("Gen.Repeats", "RepeatsView", ViewCodeWriterTests.Repeats()),
            };
            var kit = new Dictionary<string, double> { { "label", 16.515625 }, { "body", 23.125 }, { "title", 46.28125 } };
            var files = new List<string>();
            foreach (var (ns, cls, ir) in screens)
            {
                var path = Path.Combine(dir, cls + ".g.cs");
                File.WriteAllText(path, ViewCodeWriter.Write(ScreenBuilder.Build(ir, RelativeAsset, null, kit), ns, cls));
                files.Add(path);
            }
            CompilerMessage[] messages = null;
            // AssemblyBuilder is marked for deprecation in 6000.3 but still builds with the project's compiler and references,
            // into a folder outside the project (no script reload)
#pragma warning disable CS0618
            var builder = new AssemblyBuilder(Path.Combine(dir, "GeneratedViews.dll"), files.ToArray()) { referencesOptions = ReferencesOptions.UseEngineModules };
            builder.buildFinished += (_, m) => messages = m;
            Assert.IsTrue(builder.Build(), "the build starts");
#pragma warning restore CS0618
            var started = DateTime.UtcNow;
            while (messages == null && (DateTime.UtcNow - started).TotalSeconds < 120) yield return null;
            Assert.IsNotNull(messages, "the build finished within 2 minutes");
            Assert.IsTrue(File.Exists(Path.Combine(dir, "GeneratedViews.dll")), "the assembly was built");
            var problems = messages.Where(m => m.type == CompilerMessageType.Error || m.type == CompilerMessageType.Warning).Select(m => m.message).ToList();
            CollectionAssert.IsEmpty(problems, string.Join("\n", problems));
        }
    }
}
