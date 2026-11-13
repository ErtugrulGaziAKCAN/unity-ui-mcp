using System.Linq;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DesignUi.Editor
{
    internal enum McpClient { ClaudeCode, Cursor, Codex, ClaudeDesktop }

    /// <summary>
    /// The MCP client configuration for this project's design-ui server, in each client's own format (the same entries the
    /// repository's setup script writes): <c>node &lt;server.js&gt; --project &lt;project&gt;</c>. Without a known server
    /// path the snippets hold <see cref="ServerPlaceholder"/>, never a guessed path.
    /// </summary>
    internal static class McpClientSnippets
    {
        public const string ServerName = "design-ui";
        public const string ServerPlaceholder = "<unity-ui-mcp clone>/tools/design-ui-mcp/dist/server.js";

        public const string UnknownServer =
            "The MCP server's path is not in design-ui.config.json (\"mcpServer\"). It is tools/design-ui-mcp/dist/server.js in your " +
            "unity-ui-mcp clone; scripts/setup.sh there builds it and writes the path into the config.";

        public static readonly McpClient[] All = { McpClient.ClaudeCode, McpClient.Cursor, McpClient.Codex, McpClient.ClaudeDesktop };

        public static string Label(McpClient c) =>
            c == McpClient.ClaudeCode ? "Claude Code" : c == McpClient.Cursor ? "Cursor" : c == McpClient.Codex ? "Codex" : "Claude Desktop";

        public static string Id(McpClient c) =>
            c == McpClient.ClaudeCode ? "claude-code" : c == McpClient.Cursor ? "cursor" : c == McpClient.Codex ? "codex" : "claude-desktop";

        /// <summary>Where the snippet goes.</summary>
        public static string Where(McpClient c) =>
            c == McpClient.ClaudeCode ? "run it in the folder you start Claude Code from"
            : c == McpClient.Cursor ? "merge it into .cursor/mcp.json (project) or ~/.cursor/mcp.json"
            : c == McpClient.Codex ? "add it to ~/.codex/config.toml" + OneEntryPerProject
            : "merge it into claude_desktop_config.json (Settings > Developer > Edit Config)" + OneEntryPerProject;

        // Codex and Claude Desktop keep one config for every project (TOML refuses a second [mcp_servers.design-ui] table)
        const string OneEntryPerProject = "; if it already has a " + ServerName + " entry for another project, rename this one (e.g. " + ServerName + "-<project>)";

        /// <summary>The client's configuration for <paramref name="projectPath"/>; <paramref name="serverPath"/> may be null.</summary>
        public static string For(McpClient client, string projectPath, string serverPath)
        {
            var server = string.IsNullOrEmpty(serverPath) ? ServerPlaceholder : serverPath;
            var note = string.IsNullOrEmpty(serverPath) ? "# " + UnknownServer + "\n" : "";
            var args = new[] { server, "--project", projectPath };
            switch (client)
            {
                case McpClient.ClaudeCode:
                    return note + "claude mcp add --scope local " + ServerName + " -- node " + string.Join(" ", args.Select(Shell));
                case McpClient.Codex:
                    // TOML basic strings take the same escapes as JSON strings
                    return note + "[mcp_servers." + ServerName + "]\ncommand = \"node\"\nargs = [" +
                           string.Join(", ", args.Select(a => JsonConvert.ToString(a))) + "]";
                default:
                    var entry = new JObject { ["command"] = "node", ["args"] = new JArray(args.Cast<object>().ToArray()) };
                    return new JObject { ["mcpServers"] = new JObject { [ServerName] = entry } }.ToString(Formatting.Indented).Replace("\r\n", "\n");
            }
        }

        static readonly Regex Plain = new Regex(@"^[A-Za-z0-9_./:@%+=,-]+$", RegexOptions.Compiled);

        /// <summary>One shell word: as it is when it needs no quoting, else in single quotes.</summary>
        static string Shell(string s) => Plain.IsMatch(s) ? s : "'" + s.Replace("'", "'\\''") + "'";
    }
}
