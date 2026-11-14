using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEngine;
using UnityEngine.SceneManagement;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using TextAsset = UnityEngine.TextCore.Text.TextAsset;

namespace DesignUi
{
    /// <summary>
    /// Keeps font assets that were unloaded and loaded again findable by UI Toolkit's advanced text generator (Unity 6000.3).
    /// <para>TextCore registers a font asset by its instance ID when the asset is enabled (<c>TryAdd</c>, so an existing entry
    /// wins) and removes the entry only in <c>OnDestroy</c>. Unity unloads assets without that call: after a scene change
    /// (<c>Resources.UnloadUnusedAssets</c>), with <c>Resources.UnloadAsset</c>, in the Editor's own asset cleanup. The entry
    /// of the unloaded asset stays, and the asset loaded again under the same instance ID cannot register. The advanced
    /// generator looks up the font asset of every text mesh by that ID: it then drops the asset's glyphs (the text renders
    /// nothing) or fails converting the mesh (<c>ArgumentOutOfRangeException</c> in <c>ATGTextJobSystem</c>), and one failing
    /// element stops the text of the elements after it. The standard generator does not use the registry. A font asset made
    /// in memory (<c>FontAsset.CreateFontAsset</c>) has a new instance ID and is not affected, so the twins (assets on disk)
    /// were.</para>
    /// <para><see cref="Repair(FontAsset)"/> points the entries of a font asset, its fallbacks and its weight faces at the loaded
    /// assets again. The locale controller repairs its fonts while a screen uses the advanced generator, every scene load
    /// repairs the loaded font assets, and the Editor repairs them after a script reload and when Play starts or stops. On a
    /// Unity version whose TextCore has no such registry, every call does nothing (<see cref="Lookup"/> says so).</para>
    /// </summary>
    public static class TextAssetRegistry
    {
        static Dictionary<int, WeakReference<TextAsset>> s_Map;
        static string s_Lookup;
        static bool s_LookedUp;
        static readonly HashSet<FontAsset> s_Seen = new HashSet<FontAsset>();
        static readonly Stack<FontAsset> s_Pending = new Stack<FontAsset>();

        /// <summary>What the registry was found as on this Unity version, or why it was not.</summary>
        public static string Lookup
        {
            get
            {
                Find();
                return s_Lookup;
            }
        }

        /// <summary>Whether this Unity version has the registry this class repairs.</summary>
        public static bool Supported
        {
            get
            {
                Find();
                return s_Map != null;
            }
        }

        static void Find()
        {
            if (s_LookedUp) return;
            s_LookedUp = true;
            var field = typeof(TextAsset).GetField("kTextAssetByInstanceId", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
            if (field == null)
            {
                s_Lookup = "none: UnityEngine.TextCore.Text.TextAsset has no kTextAssetByInstanceId on Unity " + Application.unityVersion;
                return;
            }
            s_Map = field.GetValue(null) as Dictionary<int, WeakReference<TextAsset>>;
            s_Lookup = s_Map != null
                ? "UnityEngine.TextCore.Text.TextAsset.kTextAssetByInstanceId"
                : "none: TextAsset.kTextAssetByInstanceId is a " + field.FieldType + " on Unity " + Application.unityVersion;
        }

        /// <summary>Whether the advanced generator finds <paramref name="font"/> by its instance ID (true where there is no registry).</summary>
        public static bool IsRegistered(FontAsset font)
        {
            Find();
            if (font == null || s_Map == null) return true;
            return s_Map.TryGetValue(font.instanceID, out var entry) && entry.TryGetTarget(out var target) && ReferenceEquals(target, font);
        }

        /// <summary>
        /// Registers <paramref name="font"/>, every font of its fallback lists and every face of their weight tables, where the
        /// registry holds no live entry for them. Returns how many entries it wrote. Allocates nothing when all are registered.
        /// Main thread only, outside text generation (UI Toolkit reads the registry from its text jobs).
        /// </summary>
        public static int Repair(FontAsset font)
        {
            Find();
            if (font == null || s_Map == null) return 0;
            int fixedCount = 0;
            s_Seen.Clear();
            s_Pending.Clear();
            s_Pending.Push(font);
            while (s_Pending.Count > 0)
            {
                var f = s_Pending.Pop();
                if (f == null || !s_Seen.Add(f)) continue;
                if (RepairOne(f)) fixedCount++;
                var fallbacks = f.fallbackFontAssetTable;
                if (fallbacks != null)
                    for (int i = 0; i < fallbacks.Count; i++) s_Pending.Push(fallbacks[i]);
                var weights = f.fontWeightTable;
                if (weights != null)
                    for (int i = 0; i < weights.Length; i++)
                    {
                        s_Pending.Push(weights[i].regularTypeface);
                        s_Pending.Push(weights[i].italicTypeface);
                    }
            }
            s_Seen.Clear();
            return fixedCount;
        }

        /// <summary><see cref="Repair(FontAsset)"/> for each font of <paramref name="fonts"/>.</summary>
        public static int Repair(IReadOnlyList<FontAsset> fonts)
        {
            if (fonts == null) return 0;
            int n = 0;
            for (int i = 0; i < fonts.Count; i++) n += Repair(fonts[i]);
            return n;
        }

        /// <summary>Registers every font asset that is loaded now. Returns how many entries it wrote. Main thread only.</summary>
        public static int RepairLoaded()
        {
            Find();
            if (s_Map == null) return 0;
            int n = 0;
            foreach (var f in Resources.FindObjectsOfTypeAll<FontAsset>())
                if (f != null && RepairOne(f)) n++;
            return n;
        }

        static bool RepairOne(FontAsset f)
        {
            int id = f.instanceID;
            if (s_Map.TryGetValue(id, out var entry) && entry.TryGetTarget(out var target) && ReferenceEquals(target, f)) return false;
            s_Map[id] = new WeakReference<TextAsset>(f);
            return true;
        }

        /// <summary>A scene load may have unloaded font assets that the new scene loads again.</summary>
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        static void RepairOnSceneLoads()
        {
            SceneManager.sceneLoaded -= OnSceneLoaded;
            SceneManager.sceneLoaded += OnSceneLoaded;
        }

        static void OnSceneLoaded(Scene scene, LoadSceneMode mode) => RepairLoaded();
    }
}
