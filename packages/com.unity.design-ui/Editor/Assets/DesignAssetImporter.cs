using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Unity.VectorGraphics.Editor;
using UnityEditor;
using UnityEngine;

namespace DesignUi.Editor
{
    /// <summary>
    /// Imports the exported design assets (PNG images, 9-slice shadow PNGs, SVG icons and gradients) with import settings
    /// that suit UI Toolkit backgrounds (spec 14, R22).
    /// Asset files are content-addressed (<c>assets/&lt;sha256&gt;.&lt;ext&gt;</c>), so every screen shares one folder,
    /// <c>&lt;outputFolder&gt;/_assets/</c>: the same image used by two screens is one file and one import. A file that already
    /// holds the same bytes and the wanted settings is neither copied nor imported again.
    /// New files take their settings in <see cref="DesignAssetPostprocessor"/> during their first import, so the import can be
    /// queued inside an asset-editing batch (an importer does not exist yet for a file that has not been imported).
    /// </summary>
    public static class DesignAssetImporter
    {
        /// <summary>Folder under the output folder that holds every imported asset.</summary>
        public const string SharedFolderName = "_assets";

        /// <summary>The <c>gradientResolution</c> measured in M0 (R8): the importer bakes gradients into a 64-step ramp.</summary>
        public const int GradientResolution = 64;

        /// <summary>Largest texture size, so the importer never downscales a design image (the default is 2048).</summary>
        const int MaxTextureSize = 8192;

        /// <summary>Settings to apply at the first import of a path, by project path.</summary>
        static readonly Dictionary<string, Action<AssetImporter>> Pending = new Dictionary<string, Action<AssetImporter>>(StringComparer.Ordinal);

        /// <summary>Imports and settings changes queued by this class since the editor started (tests count them).</summary>
        internal static int ImportCount { get; private set; }

        /// <summary>
        /// Copies the asset's file from <paramref name="exportDir"/> into <c>&lt;outFolder&gt;/_assets/</c> and imports it with
        /// the UI settings, returning the project path for <c>url()</c>. An outFolder outside the project only receives the
        /// copy and the result is the path relative to a screen folder (<c>../_assets/&lt;file&gt;</c>). Writes and imports only
        /// what changed; call it inside <c>AssetDatabase.StartAssetEditing</c> to batch the imports.
        /// </summary>
        public static string Import(IrAsset asset, string exportDir, string outFolder, DesignUiProfile profile)
        {
            if (asset == null) throw new ArgumentNullException(nameof(asset));
            if (string.IsNullOrEmpty(asset.File)) throw new IrFormatException("an asset has no file");
            if (string.IsNullOrEmpty(outFolder)) throw new ArgumentException("no output folder", nameof(outFolder));
            var source = Path.Combine(exportDir ?? "", asset.File);
            if (!File.Exists(source)) throw new IrFormatException("asset file '" + asset.File + "' is missing in the export folder");
            var configure = Settings(asset, profile);

            var folder = outFolder.Replace('\\', '/').TrimEnd('/') + "/" + SharedFolderName;
            var name = Path.GetFileName(asset.File);
            var target = folder + "/" + name;
            var projectPath = ScreenCompiler.ProjectPath(target);
            var bytes = File.ReadAllBytes(source);

            var isNew = !File.Exists(target);
            var changed = isNew || !File.ReadAllBytes(target).SequenceEqual(bytes);
            if (changed)
            {
                var created = !Directory.Exists(folder);
                Directory.CreateDirectory(folder);
                File.WriteAllBytes(target, bytes);
                if (created && projectPath != null) { ImportCount++; AssetDatabase.ImportAsset(folder); }
            }
            if (projectPath == null) return "../" + SharedFolderName + "/" + name;

            var importer = changed ? null : AssetImporter.GetAtPath(projectPath);
            if (importer == null)
            {
                // a new, changed or not yet imported file: the settings are applied by the postprocessor during its import
                Pending[projectPath] = configure;
                ImportCount++;
                AssetDatabase.ImportAsset(projectPath, ImportAssetOptions.ForceUpdate);
            }
            else if (!Matches(importer, asset, profile))
            {
                configure(importer);
                ImportCount++;
                importer.SaveAndReimport();
            }
            return projectPath;
        }

        /// <summary>Applies and forgets the settings queued for a path; false when none are queued. Called during an import.</summary>
        internal static bool TryApplyPending(string path, AssetImporter importer)
        {
            if (!Pending.TryGetValue(path, out var configure)) return false;
            Pending.Remove(path);
            configure(importer);
            return true;
        }

        static Action<AssetImporter> Settings(IrAsset asset, DesignUiProfile profile)
        {
            var compression = profile != null ? profile.textureCompression : TextureImporterCompression.Uncompressed;
            switch (asset.Kind)
            {
                case "image":
                case "shadow9":
                    return i => ConfigureTexture((TextureImporter)i, compression);
                case "svg":
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
        /// SVG as a UI Toolkit VectorImage (M0 R8): gradients are baked into a 64-step ramp, edges antialiased by the shader.
        /// A currentColor icon is exported white, so <c>-unity-background-image-tint-color</c> multiplies it to the node's colour.
        /// </summary>
        static void ConfigureSvg(SVGImporter s)
        {
            s.SvgType = SVGType.VectorImage;
            s.GradientResolution = GradientResolution;
            s.TessellationMode = TessellationMode.AntialiasedArcEncodings;
            s.PreserveViewport = false;
        }

        static bool Matches(AssetImporter importer, IrAsset asset, DesignUiProfile profile)
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

    /// <summary>Applies the settings <see cref="DesignAssetImporter"/> queued for a file that is imported for the first time.</summary>
    sealed class DesignAssetPostprocessor : AssetPostprocessor
    {
        void OnPreprocessAsset() => DesignAssetImporter.TryApplyPending(assetPath, assetImporter);
    }
}
