using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The warning a <see cref="DesignUiPanelRegion"/> gives in a Linear-colour-space project whose panel no
    /// <see cref="DesignUiGammaComposite"/> renders, through the components themselves in Play mode: a composite on the same
    /// GameObject attaches after or before the region (component order) and no warning comes; without one the region warns
    /// once, however often the screen opens.
    /// </summary>
    public class PanelRegionColourWarningTests
    {
        const string Warning = "without DesignUiGammaComposite";

        /// <summary>A screen GameObject, inactive: a region, its document and (when asked) a composite, in the given order.</summary>
        static GameObject Screen(string name, PanelSettings settings, bool composite, bool compositeFirst)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.SetActive(false);
            var doc = go.AddComponent<UIDocument>();
            doc.panelSettings = settings;
            if (composite && compositeFirst) go.AddComponent<DesignUiGammaComposite>().panelSettings = settings;
            var region = go.AddComponent<DesignUiPanelRegion>();
            region.Settings = new DesignUiHostSettings { sortingOrder = 3 }; // a sort-order copy: the composite renders it too
            if (composite && !compositeFirst) go.AddComponent<DesignUiGammaComposite>().panelSettings = settings;
            return go;
        }

        static IEnumerator Frames(int n)
        {
            for (int i = 0; i < n; i++) yield return null;
        }

        [UnityTest]
        public IEnumerator Region_WarnsOnlyWithoutAComposite_WhicheverComponentAttachesFirst_AndOncePerRegion()
        {
            if (QualitySettings.activeColorSpace != ColorSpace.Linear) Assert.Ignore("the warning is for Linear-colour-space projects");
            yield return new EnterPlayMode();
            // in a method of its own: entering Play mode reloads the domain, and state made before it (a closure) is lost
            yield return InPlayMode();
        }

        IEnumerator InPlayMode()
        {
            var warnings = new List<string>();
            void Collect(string message, string stack, LogType type)
            {
                if (type == LogType.Warning && message.Contains(Warning)) warnings.Add(message);
            }
            var locales = DesignLocaleSources.Default;
            DesignLocaleSources.Default = null; // the Unity Localization adapter's source is not under test
            Application.logMessageReceived += Collect;
            // one PanelSettings asset per screen (a composite owns its asset), each with sort order 0
            PanelSettings Settings(string name)
            {
                var s = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
                s.name = name;
                s.sortingOrder = 0;
                return s;
            }
            var settings = Settings("Colour Warning Panel 1");
            var other = Settings("Colour Warning Panel 2");
            var own = Settings("Colour Warning Panel 3");
            var second = Settings("Colour Warning Panel 4");
            string result = null;
            try
            {
                var regionFirst = Screen("region, then composite", settings, composite: true, compositeFirst: false);
                regionFirst.SetActive(true);
                var compositeFirst = Screen("composite, then region", other, composite: true, compositeFirst: true);
                compositeFirst.SetActive(true);
                result = "opened";
            }
            catch (Exception e) { result = e.ToString(); }
            yield return Frames(3);
            var withComposite = warnings.ToList();

            var alone = Screen("no composite", own, composite: false, compositeFirst: false);
            alone.SetActive(true);
            yield return Frames(3);
            var aloneOnce = warnings.Count - withComposite.Count;
            // the screen opens again (a menu shown twice): no second warning for the same region
            alone.SetActive(false);
            yield return null;
            alone.SetActive(true);
            yield return Frames(3);
            var aloneTwice = warnings.Count - withComposite.Count;
            // another region without a composite warns too (no process-wide latch)
            var alsoAlone = Screen("another without composite", second, composite: false, compositeFirst: false);
            alsoAlone.SetActive(true);
            yield return Frames(3);
            var both = warnings.Count - withComposite.Count;

            Application.logMessageReceived -= Collect;
            DesignLocaleSources.Default = locales;
            yield return new ExitPlayMode();
            foreach (var s in new[] { settings, other, own, second }) Object.DestroyImmediate(s);

            Assert.AreEqual("opened", result);
            Assert.IsEmpty(withComposite, "a composite on the screen's GameObject, attached after or before the region: no warning");
            Assert.AreEqual(1, aloneOnce, "a region whose panel no composite renders warns");
            Assert.AreEqual(1, aloneTwice, "once per region, however often its screen opens");
            Assert.AreEqual(2, both, "a second region without a composite warns as well");
            StringAssert.Contains("'no composite'", warnings[warnings.Count - 2]);
            StringAssert.Contains("'another without composite'", warnings.Last());
        }
    }
}
