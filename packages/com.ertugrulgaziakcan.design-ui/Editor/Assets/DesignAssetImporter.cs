using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Unity.VectorGraphics.Editor;
using UnityEditor;
using UnityEngine;

namespace DesignUi.Editor
{
    /// <summary>
    /// Imports the exported design assets (PNG images, 9-slice shadow PNGs, SVG icons and gradients) with import settings
    /// that suit UI Toolkit backgrounds (spec 14).
    /// Asset files are content-addressed (<c>assets/&lt;sha256&gt;.&lt;ext&gt;</c>), so every screen shares one folder,
    /// <c>&lt;outputFolder&gt;/_assets/</c>: the same image used by two screens is one file and one import. A file that already
    /// holds the same bytes and the wanted settings is neither copied nor imported again. Which screens use which asset is
    /// recorded (by screen folder name) in <c>_assets/.design-ui-assets.json</c>; an asset no screen uses any more is reported, never deleted.
    /// New files take their settings in <see cref="DesignAssetPostprocessor"/> during their first import, so the import can be
    /// queued inside an asset-editing batch (an importer does not exist yet for a file that has not been imported).
    /// Only the settings set here are owned by the generator; other importer options a person changes are left alone.
    /// </summary>
    public static class DesignAssetImporter
    {
        /// <summary>Folder under the output folder that holds every imported asset.</summary>
        public const string SharedFolderName = "_assets";

        /// <summary>Which screens use which shared asset.</summary>
        public const string ManifestFileName = ".design-ui-assets.json";

        /// <summary>The importer bakes SVG gradients into a 64-step ramp; this is the resolution measured in the fidelity spike.</summary>
        public const int GradientResolution = 64;

        /// <summary>Largest texture size, so the importer never downscales a design image (the default is 2048).</summary>
        internal const int MaxTextureSize = 8192;

        /// <summary>Settings to apply at the first import of a path, by project path.</summary>
        static readonly Dictionary<string, Action<AssetImporter>> Pending = new Dictionary<string, Action<AssetImporter>>(StringComparer.Ordinal);

        /// <summary>Imports and settings changes queued by this class since the editor started (tests count them).</summary>
        internal static int ImportCount { get; set; }

        /// <summary>
        /// Plans, copies and imports one asset at once (see <see cref="AssetPlan"/>): the project path for <c>url()</c>. An
        /// outFolder outside the project only receives the copy and the result is the path relative to a screen folder
        /// (<c>../_assets/&lt;file&gt;</c>). Call it inside <c>AssetDatabase.StartAssetEditing</c> to batch the imports.
        /// </summary>
        public static string Import(IrAsset asset, string exportDir, string outFolder, DesignUiProfile profile)
        {
            var plan = new AssetPlan(exportDir, outFolder, profile);
            var path = plan.Add(asset);
            plan.Apply(null);
            return path;
        }

        /// <summary>Queues the first import of a path with its settings; a path already queued in this batch is not queued again.</summary>
        internal static void QueueFirstImport(string projectPath, Action<AssetImporter> configure)
        {
            if (Pending.ContainsKey(projectPath)) return;
            Pending[projectPath] = configure;
            ImportCount++;
            AssetDatabase.ImportAsset(projectPath, ImportAssetOptions.ForceUpdate);
        }

        /// <summary>Applies and forgets the settings queued for a path; false when none are queued. Called during an import.</summary>
        internal static bool TryApplyPending(string path, AssetImporter importer)
        {
            if (!Pending.TryGetValue(path, out var configure)) return false;
            Pending.Remove(path);
            configure(importer);
            return true;
        }

        /// <summary>The importer settings of an asset, after checking that its kind fits its file extension.</summary>
        internal static Action<AssetImporter> Settings(IrAsset asset, DesignUiProfile profile)
        {
            var compression = profile != null ? profile.textureCompression : TextureImporterCompression.Uncompressed;
            var ext = Path.GetExtension(asset.File ?? "").ToLowerInvariant();
            switch (asset.Kind)
            {
                case "image":
                case "shadow9":
                    if (ext != ".png" && ext != ".jpg" && ext != ".jpeg")
                        throw new IrFormatException("asset '" + asset.File + "' is a " + asset.Kind + " but its file is not a PNG or JPEG");
                    return i => ConfigureTexture((TextureImporter)i, compression);
                case "svg":
                    if (ext != ".svg") throw new IrFormatException("asset '" + asset.File + "' is an svg but its file is not an .svg");
                    return i => ConfigureSvg((SVGImporter)i);
                default:
                    throw new IrFormatException("asset '" + asset.File + "' has the unknown kind '" + asset.Kind + "'");
            }
        }

        /// <summary>
        /// Colour texture for a USS background: default type, sRGB, one mip level (a background is drawn near 1:1 and a mip
        /// chain would blur it), no power-of-two scaling, premultiplied-safe edges (alphaIsTransparency), bilinear, clamped.
        /// 9-slice insets are not stored here: the compiler writes <c>-unity-slice-*</c> into the USS.
        /// </summary>
        static void ConfigureTexture(TextureImporter t, TextureImporterCompression compression)
        {
            t.textureType = TextureImporterType.Default;
            t.sRGBTexture = true;
            t.mipmapEnabled = false;
            t.npotScale = TextureImporterNPOTScale.None;
            t.alphaIsTransparency = true;
            t.filterMode = FilterMode.Bilinear;
            t.wrapMode = TextureWrapMode.Clamp;
            t.maxTextureSize = MaxTextureSize;
            t.textureCompression = compression;
            t.isReadable = false;
        }

        /// <summary>
        /// SVG as a UI Toolkit VectorImage: gradients are baked into a 64-step ramp, edges antialiased by the shader.
        /// A currentColor icon is exported white, so <c>-unity-background-image-tint-color</c> multiplies it to the node's colour.
        /// The importer sizes a VectorImage by its shapes' bounds (PreserveViewport does not apply to VectorImage), so the
        /// exporter pins every svg's viewBox with a transparent rect.
        /// </summary>
        static void ConfigureSvg(SVGImporter s)
        {
            s.SvgType = SVGType.VectorImage;
            s.GradientResolution = GradientResolution;
            s.TessellationMode = TessellationMode.AntialiasedArcEncodings;
            s.PreserveViewport = false;
        }

        internal static bool Matches(AssetImporter importer, IrAsset asset, DesignUiProfile profile)
        {
            if (importer is TextureImporter t)
            {
                var compression = profile != null ? profile.textureCompression : TextureImporterCompression.Uncompressed;
                return asset.Kind != "svg" && t.textureType == TextureImporterType.Default && t.sRGBTexture && !t.mipmapEnabled &&
                       t.npotScale == TextureImporterNPOTScale.None && t.alphaIsTransparency && t.filterMode == FilterMode.Bilinear &&
                       t.wrapMode == TextureWrapMode.Clamp && t.maxTextureSize == MaxTextureSize && t.textureCompression == compression;
            }
            if (importer is SVGImporter s)
                return asset.Kind == "svg" && s.SvgType == SVGType.VectorImage && s.GradientResolution == GradientResolution &&
                       s.TessellationMode == TessellationMode.AntialiasedArcEncodings && !s.PreserveViewport;
            return false;
        }
    }

    /// <summary>
    /// The assets of one compile. <see cref="Add"/> validates an asset (file, kind and extension, recorded hash) and returns
    /// the path for <c>url()</c> without touching the disk; <see cref="Apply"/> then copies and imports what changed, inside
    /// the caller's asset-editing batch, once the compile is sure to write.
    /// </summary>
    internal sealed class AssetPlan
    {
        sealed class Entry
        {
            public IrAsset Asset;
            public byte[] Bytes;
            public string Target;
            public string ProjectPath;
            public string Name;
        }

        readonly string _exportDir;
        readonly string _folder;
        readonly DesignUiProfile _profile;
        readonly Dictionary<string, Entry> _entries = new Dictionary<string, Entry>(StringComparer.Ordinal);
        readonly List<Entry> _order = new List<Entry>();

        public AssetPlan(string exportDir, string outFolder, DesignUiProfile profile)
        {
            if (string.IsNullOrEmpty(outFolder)) throw new ArgumentException("no output folder", nameof(outFolder));
            _exportDir = exportDir ?? "";
            _folder = outFolder.Replace('\\', '/').TrimEnd('/') + "/" + DesignAssetImporter.SharedFolderName;
            _profile = profile;
        }

        /// <summary>True when an asset lies inside the Unity project (its copy and import need the asset-editing batch).</summary>
        public bool HasProjectAssets => _order.Any(e => e.ProjectPath != null);

        /// <summary>Assets no screen uses after <see cref="Apply"/> (file names under the shared folder).</summary>
        public IReadOnlyList<string> StaleAssets { get; private set; } = new string[0];

        public string Add(IrAsset asset)
        {
            if (asset == null) throw new ArgumentNullException(nameof(asset));
            if (string.IsNullOrEmpty(asset.File)) throw new IrFormatException("an asset has no file");
            var source = Path.Combine(_exportDir, asset.File);
            if (!File.Exists(source)) throw new IrFormatException("asset file '" + asset.File + "' is missing in the export folder");
            DesignAssetImporter.Settings(asset, _profile); // kind and extension
            var name = Path.GetFileName(asset.File);
            var target = _folder + "/" + name;
            var projectPath = ScreenCompiler.ProjectPath(target);
            var shown = projectPath ?? "../" + DesignAssetImporter.SharedFolderName + "/" + name;

            if (_entries.TryGetValue(target, out var known))
            {
                if (known.Asset.Kind != asset.Kind) throw new IrFormatException("asset '" + name + "' is used as both " + known.Asset.Kind + " and " + asset.Kind);
                if (!string.IsNullOrEmpty(asset.Sha256) && !string.Equals(asset.Sha256, known.Asset.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new IrFormatException("two different assets are both named '" + name + "'");
                return shown;
            }
            var bytes = File.ReadAllBytes(source);
            if (!string.IsNullOrEmpty(asset.Sha256) && !string.Equals(Sha256Hex(bytes), asset.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new IrFormatException("asset file '" + asset.File + "' does not match its recorded sha256 (a corrupt or hand-edited export)");
            var entry = new Entry { Asset = asset, Bytes = bytes, Target = target, ProjectPath = projectPath, Name = name };
            _entries[target] = entry;
            _order.Add(entry);
            return shown;
        }

        /// <summary>Copies and imports the planned assets that changed, then records them for <paramref name="screen"/> (null: no manifest).</summary>
        public void Apply(string screen)
        {
            foreach (var e in _order) Apply(e);
            if (screen != null) UpdateManifest(screen);
        }

        void Apply(Entry e)
        {
            var configure = DesignAssetImporter.Settings(e.Asset, _profile);
            var changed = !File.Exists(e.Target) || !File.ReadAllBytes(e.Target).SequenceEqual(e.Bytes);
            if (changed)
            {
                var created = !Directory.Exists(_folder);
                Directory.CreateDirectory(_folder);
                File.WriteAllBytes(e.Target, e.Bytes);
                if (created && e.ProjectPath != null) { DesignAssetImporter.ImportCount++; AssetDatabase.ImportAsset(_folder); }
            }
            if (e.ProjectPath == null) return;

            var importer = changed ? null : AssetImporter.GetAtPath(e.ProjectPath);
            if (importer == null)
            {
                // a new, changed or not yet imported file: the postprocessor applies the settings during its import
                DesignAssetImporter.QueueFirstImport(e.ProjectPath, configure);
            }
            else if (!DesignAssetImporter.Matches(importer, e.Asset, _profile))
            {
                configure(importer);
                DesignAssetImporter.ImportCount++;
                importer.SaveAndReimport();
            }
        }

        sealed class UsageManifest
        {
            [JsonProperty("assets")] public SortedDictionary<string, string[]> Assets = new SortedDictionary<string, string[]>(StringComparer.Ordinal);
        }

        void UpdateManifest(string screen)
        {
            var path = _folder + "/" + DesignAssetImporter.ManifestFileName;
            var manifest = new UsageManifest();
            if (File.Exists(path))
            {
                try { manifest = JsonConvert.DeserializeObject<UsageManifest>(File.ReadAllText(path)) ?? manifest; }
                catch (JsonException) { manifest = new UsageManifest(); } // unreadable: rebuilt from the screens compiled from now on
                manifest.Assets = new SortedDictionary<string, string[]>(manifest.Assets ?? new SortedDictionary<string, string[]>(), StringComparer.Ordinal);
            }
            var used = new HashSet<string>(_order.Select(e => e.Name), StringComparer.Ordinal);
            foreach (var name in manifest.Assets.Keys.ToList())
                manifest.Assets[name] = (manifest.Assets[name] ?? new string[0]).Where(x => x != screen || used.Contains(name)).ToArray();
            foreach (var name in used)
            {
                var screens = new SortedSet<string>(manifest.Assets.TryGetValue(name, out var existing) ? existing ?? new string[0] : new string[0], StringComparer.Ordinal) { screen };
                manifest.Assets[name] = screens.ToArray();
            }
            StaleAssets = manifest.Assets.Where(kv => kv.Value.Length == 0).Select(kv => kv.Key).ToArray();
            var text = JsonConvert.SerializeObject(manifest, Formatting.Indented).Replace("\r\n", "\n") + "\n";
            if (File.Exists(path) && File.ReadAllText(path).Replace("\r\n", "\n") == text) return;
            Directory.CreateDirectory(_folder);
            File.WriteAllText(path, text, new UTF8Encoding(false)); // a dot file is not an asset: Unity does not import it
        }

        static string Sha256Hex(byte[] bytes)
        {
            using (var sha = SHA256.Create())
                return string.Concat(sha.ComputeHash(bytes).Select(b => b.ToString("x2")));
        }
    }

    /// <summary>Applies the settings <see cref="DesignAssetImporter"/> queued for a file that is imported for the first time.</summary>
    sealed class DesignAssetPostprocessor : AssetPostprocessor
    {
        void OnPreprocessAsset() => DesignAssetImporter.TryApplyPending(assetPath, assetImporter);
    }
}
