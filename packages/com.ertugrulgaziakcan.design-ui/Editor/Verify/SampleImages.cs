using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi.Editor
{
    /// <summary>
    /// The pictures of a design's image binds in its sample data (each repeat item's own image), for the Unity capture. The
    /// export's files are copied into a temporary folder of the project the capture runs in (a temporary copy of the
    /// project, by contract), <c>Assets/DesignUiCaptureSamples/&lt;run&gt;/_assets/</c>, never into the screens'
    /// <c>_assets</c>, and imported with the settings of the design's own assets (<see cref="AssetPlan"/>: kind, extension
    /// and recorded hash checked). <see cref="Dispose"/> deletes the folder when the capture ends, and the root once no
    /// capture holds a folder (the held folders are a static list). A folder a capture left without disposing it goes
    /// with the root, at the next import or disposal that finds no folder held: after an Editor that quit midway, the next
    /// session's first capture; after a run dropped without disposal, only once a script reload or Editor restart has
    /// emptied the list, since that run still counts as holding its folder. A file the export does not have is listed in
    /// <see cref="Missing"/>, so each capture fails naming it instead of showing the template's image.
    /// </summary>
    internal sealed class SampleImages : IDisposable
    {
        public const string Root = "Assets/DesignUiCaptureSamples";

        /// <summary>The folders of the captures that hold sample images now (the others under <see cref="Root"/> are leftovers).</summary>
        static readonly HashSet<string> s_Live = new HashSet<string>(StringComparer.Ordinal);

        readonly Dictionary<string, Background> _loaded = new Dictionary<string, Background>(StringComparer.Ordinal);
        string _folder;

        /// <summary>The sample image files the export does not have, with where the sample data first uses each.</summary>
        public readonly List<(string File, string Where)> Missing = new List<(string File, string Where)>();

        /// <summary>No image samples (an export without image binds, or none read yet).</summary>
        public static SampleImages None => new SampleImages();

        /// <summary>
        /// Copies, imports and loads every image the sample data shows (none: nothing is written). Throws when a file does
        /// not match its recorded hash or kind, or does not import as an image; a file the export lacks goes to
        /// <see cref="Missing"/>.
        /// </summary>
        public static SampleImages Import(string exportDir, IrFixtures fixtures, DesignUiProfile profile)
        {
            var result = new SampleImages();
            var present = new List<IrAsset>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (image, where) in Used(fixtures, ""))
            {
                if (!seen.Add(image.File)) continue;
                if (File.Exists(Path.Combine(exportDir, image.File))) present.Add(image);
                else result.Missing.Add((image.File, where));
            }
            if (present.Count == 0) return result;

            if (s_Live.Count == 0 && AssetDatabase.IsValidFolder(Root)) AssetDatabase.DeleteAsset(Root); // leftovers (see the class)
            if (!AssetDatabase.IsValidFolder(Root)) AssetDatabase.CreateFolder("Assets", Path.GetFileName(Root));
            var run = Guid.NewGuid().ToString("N").Substring(0, 12);
            AssetDatabase.CreateFolder(Root, run);
            result._folder = Root + "/" + run;
            s_Live.Add(result._folder);
            try
            {
                var plan = new AssetPlan(exportDir, result._folder, profile);
                var paths = new List<string>();
                AssetDatabase.StartAssetEditing();
                try
                {
                    foreach (var image in present) paths.Add(plan.Add(image));
                    plan.Apply(null);
                }
                finally { AssetDatabase.StopAssetEditing(); }
                for (int i = 0; i < present.Count; i++) result._loaded[present[i].File] = Load(paths[i], present[i]);
            }
            catch
            {
                result.Dispose();
                throw;
            }
            return result;
        }

        /// <summary>The image of a sample as game code passes it to <c>Set&lt;Name&gt;(Background)</c>; no image for null.</summary>
        public Background Get(IrAsset image)
        {
            if (image == null) return default;
            if (_loaded.TryGetValue(image.File, out var background)) return background;
            throw new InvalidOperationException("the sample image '" + image.File + "' was not imported for the capture");
        }

        /// <summary>Deletes the capture's folder (and the root once no capture holds one).</summary>
        public void Dispose()
        {
            if (_folder == null) return;
            _loaded.Clear();
            s_Live.Remove(_folder);
            if (AssetDatabase.IsValidFolder(_folder)) AssetDatabase.DeleteAsset(_folder);
            if (s_Live.Count == 0 && AssetDatabase.IsValidFolder(Root)) AssetDatabase.DeleteAsset(Root);
            _folder = null;
        }

        /// <summary>Every image a sample shows, with its place in the sample data (<c>/rows[2]/row.crest</c>), in file order.</summary>
        static IEnumerable<(IrAsset Image, string Where)> Used(IrFixtures data, string at)
        {
            foreach (var kv in data.Images)
                if (kv.Value != null) yield return (kv.Value, at + "/" + kv.Key);
            foreach (var kv in data.Repeats)
                for (int i = 0; i < kv.Value.Count; i++)
                    foreach (var used in Used(kv.Value[i], at + "/" + kv.Key + "[" + i + "]"))
                        yield return used;
        }

        static Background Load(string path, IrAsset image)
        {
            if (image.Kind == "svg")
            {
                var vector = AssetDatabase.LoadAssetAtPath<VectorImage>(path);
                if (vector != null) return Background.FromVectorImage(vector);
            }
            else
            {
                var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
                if (texture != null) return Background.FromTexture2D(texture);
            }
            throw new InvalidOperationException("the sample image '" + image.File + "' did not import as " + (image.Kind == "svg" ? "a vector image" : "a texture") +
                                                " ('" + path + "')");
        }
    }
}
