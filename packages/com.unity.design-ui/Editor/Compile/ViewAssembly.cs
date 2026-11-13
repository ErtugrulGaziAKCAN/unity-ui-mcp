using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.Compilation;

namespace DesignUi.Editor
{
    /// <summary>
    /// The assembly a generated view compiles into must reference <c>DesignUi.Runtime</c> (the view uses its runtime
    /// types, such as PseudoStateMirror) and the Unity engine. Unity puts a script into the assembly of the nearest
    /// assembly definition (<c>.asmdef</c>) or reference (<c>.asmref</c>) in its folder or above; without one it goes
    /// into a predefined assembly (Assembly-CSharp), which references every auto-referenced package assembly. The compiler
    /// checks this before writing, so a missing reference is our clear error instead of a C# compile failure of the
    /// consumer's whole assembly.
    /// </summary>
    internal static class ViewAssembly
    {
        public const string RuntimeAssembly = "DesignUi.Runtime";

        /// <summary>Why the view at <paramref name="viewPath"/> would not compile in its assembly, or null when it would.</summary>
        public static string Check(string viewPath)
        {
            if (string.IsNullOrEmpty(viewPath)) return null;
            for (var dir = Path.GetDirectoryName(Path.GetFullPath(viewPath)); !string.IsNullOrEmpty(dir); dir = Path.GetDirectoryName(dir))
            {
                if (!Directory.Exists(dir)) continue;
                var asmdef = Directory.GetFiles(dir, "*.asmdef").OrderBy(f => f, StringComparer.Ordinal).FirstOrDefault();
                if (asmdef != null) return CheckAsmdef(viewPath, asmdef);
                var asmref = Directory.GetFiles(dir, "*.asmref").OrderBy(f => f, StringComparer.Ordinal).FirstOrDefault();
                if (asmref != null)
                {
                    var target = Resolve(asmref, out var error);
                    return target == null ? error : CheckAsmdef(viewPath, target);
                }
            }
            return null;
        }

        static JObject Read(string path, out string error)
        {
            error = null;
            try { return JObject.Parse(File.ReadAllText(path)); }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is JsonException)
            {
                error = "cannot read the assembly definition '" + path + "' the generated view would compile into: " + e.Message;
                return null;
            }
        }

        /// <summary>The asmdef an asmref points at (by name or GUID), or null with an error.</summary>
        static string Resolve(string asmref, out string error)
        {
            var json = Read(asmref, out error);
            if (json == null) return null;
            var reference = (string)json["reference"] ?? "";
            string path = null;
            if (reference.StartsWith("GUID:", StringComparison.OrdinalIgnoreCase)) path = AssetDatabase.GUIDToAssetPath(reference.Substring(5));
            else if (reference.Length > 0) path = CompilationPipeline.GetAssemblyDefinitionFilePathFromAssemblyName(reference);
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
            {
                error = "the generated view would compile into the assembly that '" + asmref + "' references ('" + reference + "'), which cannot be found";
                return null;
            }
            return path;
        }

        static string CheckAsmdef(string viewPath, string asmdef)
        {
            var json = Read(asmdef, out var error);
            if (json == null) return error;
            var name = (string)json["name"] ?? Path.GetFileNameWithoutExtension(asmdef);
            if (name == RuntimeAssembly) return null;
            var where = "the generated view '" + viewPath + "' compiles into assembly '" + name + "' (" + asmdef + ")";
            if ((bool?)json["noEngineReferences"] == true)
                return where + ", which sets noEngineReferences; the view needs UnityEngine. Set the profile's output folder outside that assembly";
            var guid = AssetDatabase.AssetPathToGUID(CompilationPipeline.GetAssemblyDefinitionFilePathFromAssemblyName(RuntimeAssembly) ?? "");
            var references = (json["references"] as JArray)?.Select(t => (string)t).Where(r => r != null).ToList();
            if (references != null && references.Any(r => r == RuntimeAssembly ||
                                                          !string.IsNullOrEmpty(guid) && string.Equals(r, "GUID:" + guid, StringComparison.OrdinalIgnoreCase)))
                return null;
            return where + ", which does not reference " + RuntimeAssembly + " (the view uses its runtime types). Add " + RuntimeAssembly +
                   " to that asmdef's Assembly Definition References, or set the profile's output folder outside it";
        }
    }
}
