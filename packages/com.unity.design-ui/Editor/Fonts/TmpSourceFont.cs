using System;
using TMPro;
using UnityEditor;
using UnityEngine;

namespace DesignUi.Editor
{
    /// <summary>The TTF/OTF a TMP font asset was made from (spec 6): the kit and the UI Toolkit twin use the same file.</summary>
    public static class TmpSourceFont
    {
        /// <summary>
        /// Project path of the source font file, from the asset's serialized <c>m_SourceFontFileGUID</c> (TMP keeps it for
        /// static and dynamic assets alike). Throws <see cref="FontSetupException"/> when it is empty or names no font.
        /// </summary>
        public static string GetSourceFontPath(TMP_FontAsset tmp)
        {
            if (tmp == null) throw new ArgumentNullException(nameof(tmp));
            string guid;
            using (var so = new SerializedObject(tmp)) guid = so.FindProperty("m_SourceFontFileGUID")?.stringValue;
            var path = string.IsNullOrEmpty(guid) ? null : AssetDatabase.GUIDToAssetPath(guid);
            if (string.IsNullOrEmpty(path) || AssetDatabase.GetMainAssetTypeAtPath(path) != typeof(Font))
                throw new FontSetupException(
                    "TMP font asset '" + tmp.name + "' (" + AssetDatabase.GetAssetPath(tmp) + ") has no source font file in the project (" +
                    (string.IsNullOrEmpty(guid) ? "its source font GUID is empty" : "its source font GUID " + guid + " names no font asset") +
                    "). Recreate it from its TTF/OTF with the Font Asset Creator, or map the locale to a font asset that has one.");
            return path;
        }

        internal static Font GetSourceFont(TMP_FontAsset tmp) => AssetDatabase.LoadAssetAtPath<Font>(GetSourceFontPath(tmp));
    }
}
