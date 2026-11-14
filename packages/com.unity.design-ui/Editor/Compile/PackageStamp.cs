using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor.PackageManager;

namespace DesignUi.Editor
{
    /// <summary>
    /// The identity of the installed design-ui package, the compiler that generates screens: <c>git:&lt;commit&gt;</c> for a
    /// git package, <c>registry:&lt;version&gt;</c> for a registry package, <c>sha256:&lt;hash&gt;</c> of the files of a local
    /// or embedded package (<see cref="ContentStamp"/>), the same stamp the MCP server records for an import
    /// (tools/design-ui-mcp/src/package-stamp.ts; contract: contracts/package-stamp.json).
    /// </summary>
    public static class PackageStamp
    {
        /// <summary>This package's stamp, or null when Unity reports no package for this assembly.</summary>
        public static string Current
        {
            get
            {
                var info = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(PackageStamp).Assembly);
                if (info == null) return null;
                switch (info.source)
                {
                    case PackageSource.Git:
                        return !string.IsNullOrEmpty(info.git?.hash) ? "git:" + info.git.hash : null;
                    case PackageSource.Registry:
                        return "registry:" + info.version;
                    default:
                        return Directory.Exists(info.resolvedPath) ? ContentStamp(info.resolvedPath) : null;
                }
            }
        }

        /// <summary>
        /// <c>sha256:</c> + the SHA-256 of the package's files: per file, sorted by its path relative to <paramref name="dir"/>
        /// (with <c>/</c>, ordinal), the line <c>&lt;path&gt;\n&lt;sha256 of its bytes&gt;\n</c>. Left out: names starting with
        /// <c>.</c>, folders Unity ignores (ending with <c>~</c>) and the top-level <c>Tests</c> folder.
        /// </summary>
        public static string ContentStamp(string dir)
        {
            var root = dir.Replace('\\', '/').TrimEnd('/');
            var files = new List<string>();
            void Walk(string abs, string rel)
            {
                foreach (var entry in Directory.EnumerateFileSystemEntries(abs))
                {
                    var name = Path.GetFileName(entry);
                    if (name.StartsWith(".", StringComparison.Ordinal) || name.EndsWith("~", StringComparison.Ordinal)) continue;
                    var isDir = Directory.Exists(entry);
                    if (rel.Length == 0 && isDir && name == "Tests") continue;
                    var r = rel.Length == 0 ? name : rel + "/" + name;
                    if (isDir) Walk(entry, r);
                    else files.Add(r);
                }
            }
            Walk(root, "");
            files.Sort(StringComparer.Ordinal);
            var text = new StringBuilder();
            foreach (var f in files) text.Append(f).Append('\n').Append(GeneratedManifest.Sha256Hex(File.ReadAllBytes(root + "/" + f))).Append('\n');
            return "sha256:" + GeneratedManifest.Sha256Hex(new UTF8Encoding(false).GetBytes(text.ToString()));
        }
    }
}
