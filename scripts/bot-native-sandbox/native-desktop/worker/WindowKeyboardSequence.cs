// Limited HWND chord sequencing follows pinned Microsoft WinAppCli KeyboardInput.cs
// (3fd590017806562f088e6b275302610b9937674b, MIT). This has no input-state or OS injection path.
using System.Runtime.ExceptionServices;

namespace CmbNativeDesktop;

internal sealed record WindowKeyboardStroke(uint VirtualKey, bool Extended, uint Scan, bool SystemKey);

/** One original target's bounded sequence. A successful down is never repeated;
 * all accepted downs get a reverse-order release attempt, even when a prior
 * release failed. Production callers supply original-identity-only cleanup. */
internal static class WindowKeyboardSequence
{
    internal static void Deliver(IReadOnlyList<WindowKeyboardStroke> strokes,
        Action<WindowKeyboardStroke> down, Action<WindowKeyboardStroke> release)
    {
        if (strokes.Count is < 1 or > 4) throw new ArgumentException("One key plus at most three modifiers required", nameof(strokes));
        var accepted = new List<WindowKeyboardStroke>(strokes.Count);
        Exception? failure = null;
        Exception? releaseFailure = null;
        try
        {
            foreach (var stroke in strokes)
            {
                down(stroke);
                accepted.Add(stroke);
            }
        }
        catch (Exception error) { failure = error; }
        finally
        {
            for (var index = accepted.Count - 1; index >= 0; index--)
            {
                try { release(accepted[index]); }
                catch (Exception error) { releaseFailure ??= error; }
            }
        }
        if (failure is not null)
        {
            if (releaseFailure is not null) failure.Data["native_keyboard_release_failure"] = releaseFailure.GetType().Name;
            ExceptionDispatchInfo.Capture(failure).Throw();
        }
        if (releaseFailure is not null) ExceptionDispatchInfo.Capture(releaseFailure).Throw();
    }
    internal static uint BuildKeyLParam(bool keyUp, bool extended, uint scan, bool systemKey = false)
    {
        if (scan is 0 or > 255) throw new ArgumentOutOfRangeException(nameof(scan));
        uint value = 1U | scan << 16 | (extended ? 1U << 24 : 0U) | (systemKey ? 1U << 29 : 0U);
        return keyUp ? value | 1U << 30 | 1U << 31 : value;
    }
    internal static bool ValidText(string text)
    {
        if (text.Length is < 1 or > 4096 || text.Contains('\0')) return false;
        for (var index = 0; index < text.Length; index++)
        {
            var value = text[index];
            if (char.IsHighSurrogate(value))
            {
                if (++index >= text.Length || !char.IsLowSurrogate(text[index])) return false;
            }
            else if (char.IsLowSurrogate(value)) return false;
        }
        return true;
    }
}
