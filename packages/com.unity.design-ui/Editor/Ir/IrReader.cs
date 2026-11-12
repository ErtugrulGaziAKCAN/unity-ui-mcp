using System;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DesignUi.Editor
{
    public sealed class IrFormatException : Exception
    {
        public IrFormatException(string message) : base(message) { }
        public IrFormatException(string message, Exception inner) : base(message, inner) { }
    }

    public static class IrReader
    {
        public const int SupportedVersion = 1;

        public static IrScreen Read(string path)
        {
            string text;
            try { text = File.ReadAllText(path); }
            catch (Exception e) { throw new IrFormatException("cannot read IR file '" + path + "': " + e.Message, e); }

            JObject obj;
            try { obj = JObject.Parse(text); }
            catch (JsonException e) { throw new IrFormatException("IR file is not valid JSON: " + e.Message, e); }

            var version = obj["irVersion"];
            if (version == null || version.Type != JTokenType.Integer || version.Value<int>() != SupportedVersion)
                throw new IrFormatException("irVersion " + (version == null ? "missing" : version.ToString()) +
                                            " is not supported (expected " + SupportedVersion + ")");

            IrScreen screen;
            try { screen = obj.ToObject<IrScreen>(); }
            catch (JsonException e) { throw new IrFormatException("IR file does not match the IR schema: " + e.Message, e); }

            if (screen == null || screen.Root == null)
                throw new IrFormatException("IR file has no root node");
            return screen;
        }
    }
}
