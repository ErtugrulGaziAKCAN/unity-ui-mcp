using UnityEngine;

namespace DesignUi
{
    /// <summary>The time base of a <see cref="DesignUiAnimationPlayer"/>, in milliseconds (any origin, never decreasing).</summary>
    public interface IDesignAnimationClock
    {
        double Milliseconds { get; }
    }

    /// <summary>
    /// Real time (<see cref="Time.realtimeSinceStartupAsDouble"/>): it runs in the Editor and while the game is paused by a
    /// time scale of 0, as menu animations should. The player's default clock.
    /// </summary>
    public sealed class DesignRealtimeClock : IDesignAnimationClock
    {
        public static readonly DesignRealtimeClock Instance = new DesignRealtimeClock();

        public double Milliseconds => Time.realtimeSinceStartupAsDouble * 1000.0;
    }

    /// <summary>A clock that moves only when told: tests and the verifier step it to each sample time.</summary>
    public sealed class DesignManualClock : IDesignAnimationClock
    {
        public double Milliseconds { get; set; }
    }
}
