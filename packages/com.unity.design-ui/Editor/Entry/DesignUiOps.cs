namespace DesignUi.Editor
{
    /// <summary>Result of an operation: 0 ok, 1 failed, 2 usage or unavailable.</summary>
    public readonly struct OpResult
    {
        public readonly int Code;
        public readonly string Log;

        public OpResult(int code, string log)
        {
            Code = code;
            Log = log;
        }
    }

    /// <summary>Entry points of the import pipeline. Both operations are filled in with the pipeline.</summary>
    public static class DesignUiOps
    {
        public static OpResult KitSync(string profilePath, string kitDir)
        {
            return new OpResult(2, "Not available yet: kit sync arrives with the import pipeline.");
        }

        public static OpResult Import(string profilePath, string exportDir, bool discardManualEdits)
        {
            return new OpResult(2, "Not available yet: import arrives with the import pipeline.");
        }
    }
}
