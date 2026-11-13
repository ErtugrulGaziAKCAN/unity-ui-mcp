using System.Text;

namespace DesignUi.Editor
{
    /// <summary>C# names generated from design ids.</summary>
    public static class Naming
    {
        /// <summary>
        /// PascalCase of an ASCII id: <c>inbox.message-list</c> to <c>InboxMessageList</c>, <c>card__shadowhost</c> to
        /// <c>CardShadowhost</c>. Invariant culture; anything outside ASCII letters, digits and <c>. - _</c> separators,
        /// or a name that would be empty or start with a digit, throws <see cref="IrFormatException"/>.
        /// </summary>
        public static string Pascal(string id) => Pascal(id, "id");

        internal static string Pascal(string id, string what)
        {
            if (string.IsNullOrEmpty(id)) throw new IrFormatException("missing " + what);
            var sb = new StringBuilder();
            foreach (var part in id.Split('.', '-', '_'))
            {
                if (part.Length == 0) continue;
                foreach (var c in part)
                    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')))
                        throw new IrFormatException(what + " '" + id + "' has characters outside ASCII letters, digits and . - _");
                sb.Append(char.ToUpperInvariant(part[0])).Append(part, 1, part.Length - 1);
            }
            if (sb.Length == 0 || char.IsDigit(sb[0])) throw new IrFormatException(what + " '" + id + "' does not give a valid name");
            return sb.ToString();
        }
    }
}
