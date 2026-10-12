// Desktop identity checks are adapted from the CMB G2B exact acceptance worker.
// Private HDESK lifecycle/ACLs remain owned by the fixed-source Codex launcher.
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace CmbNativeDesktop;

internal static class Native
{
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)] private static extern nint GetThreadDesktop(uint tid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint OpenDesktopW(string name, uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseDesktop(nint desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserObjectInformationW(nint handle, int kind, [Out, MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.U2)] char[] data, uint bytes, out uint needed);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindow(nint window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(nint window, [Out, MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.U2)] char[] data, int chars);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLengthW(nint window);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EnumDesktopWindows(nint desktop, EnumWindow callback, nint parameter);
    private delegate bool EnumWindow(nint window, nint parameter);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(nint context);

    internal static void SetDpi() => SetProcessDpiAwarenessContext((nint)(-4));
    private static string Desktop(nint handle)
    {
        if (handle == 0) throw new DesktopException("desktop_handle_unavailable");
        var text = new char[256];
        if (!GetUserObjectInformationW(handle, 2, text, 512, out var size) || size > 512)
            throw new DesktopException("desktop_name_unavailable");
        var end = Array.IndexOf(text, '\0');
        if (end < 0) throw new DesktopException("desktop_name_not_terminated");
        return new string(text, 0, end);
    }
    internal static string CurrentDesktop() => Desktop(GetThreadDesktop(GetCurrentThreadId()));
    internal static void AssertPrivate(string expected)
    {
        const string prefix = "CodexSandboxDesktop-";
        if (!expected.StartsWith(prefix, StringComparison.Ordinal) || expected.Length <= prefix.Length || expected.Length > prefix.Length + 32 ||
            expected[prefix.Length..].Any(c => !Uri.IsHexDigit(c)) || CurrentDesktop() != expected)
            throw new DesktopException("private_desktop_required");
        foreach (var permission in new uint[] { 0x100, 0x8, 0x10, 0x20 })
        {
            var handle = OpenDesktopW(expected, 0, false, permission);
            var error = Marshal.GetLastWin32Error();
            if (handle != 0) { CloseDesktop(handle); throw new DesktopException("desktop_participant_rights_too_wide"); }
            if (error != 5) throw new DesktopException("desktop_rights_denial_unproven");
        }
    }
    internal static WorkerIdentity Worker()
    {
        using var process = Process.GetCurrentProcess();
        return new(process.Id, Wire.CanonicalLong(process.StartTime.ToUniversalTime().Ticks), process.SessionId, CurrentDesktop());
    }
    internal static WindowIdentity Identity(nint hwnd)
    {
        if (!IsWindow(hwnd)) throw new DesktopException("window_gone");
        var thread = GetWindowThreadProcessId(hwnd, out var pid);
        if (thread == 0 || pid == 0 || pid > int.MaxValue) throw new DesktopException("invalid_window_owner");
        using var process = Process.GetProcessById((int)pid);
        if (process.HasExited) throw new DesktopException("window_process_gone");
        return new(Wire.CanonicalLong(hwnd.ToInt64()), (int)pid,
            Wire.CanonicalLong(process.StartTime.ToUniversalTime().Ticks), process.SessionId, Desktop(GetThreadDesktop(thread)));
    }
    internal static bool WindowIdentityRetired(WindowIdentity expected)
    {
        var hwnd = (nint)Wire.Hwnd(expected.Hwnd);
        if (!IsWindow(hwnd)) return true;
        var thread = GetWindowThreadProcessId(hwnd, out var pid);
        if (thread == 0 || pid == 0) return !IsWindow(hwnd);
        if (pid != expected.Pid) return true;
        try
        {
            using var process = Process.GetProcessById((int)pid);
            if (process.HasExited || Wire.CanonicalLong(process.StartTime.ToUniversalTime().Ticks) != expected.StartTicks ||
                process.SessionId != expected.SessionId) return true;
            return Desktop(GetThreadDesktop(thread)) != expected.Desktop;
        }
        catch (ArgumentException) { return true; } // The exact PID has ceased to exist.
        catch (Exception error) when (error is Win32Exception or InvalidOperationException or DesktopException)
        {
            // Failure to query is not proof of a new identity. Keep the bounded entry
            // unless Win32 separately proves this HWND has disappeared.
            return !IsWindow(hwnd);
        }
    }
    internal static void AssertWindow(WindowIdentity requested, WorkerIdentity worker)
    {
        var hwnd = (nint)Wire.Hwnd(requested.Hwnd);
        var ticks = Wire.PositiveDecimal(requested.StartTicks);
        if (ticks > DateTime.MaxValue.Ticks || requested.Pid <= 0 || requested.SessionId != worker.SessionId ||
            requested.Desktop != worker.Desktop || Identity(hwnd) != requested) throw new DesktopException("stale_window");
    }
    internal static string Title(WindowIdentity window)
    {
        var hwnd = (nint)Wire.Hwnd(window.Hwnd);
        var length = GetWindowTextLengthW(hwnd);
        if (length < 0 || length > 4096) throw new DesktopException("window_title_too_large");
        var text = new char[4097];
        var copied = GetWindowTextW(hwnd, text, text.Length);
        if (copied < 0 || copied >= text.Length || GetWindowTextLengthW(hwnd) > 4096)
            throw new DesktopException("window_title_not_bounded");
        return new string(text, 0, copied);
    }
    internal static (WindowIdentity Window, string Title)[] Windows(WorkerIdentity worker, CancellationToken cancellation, out bool truncated)
    {
        var result = new List<(WindowIdentity, string)>(128);
        var stopped = false;
        Exception? failure = null;
        EnumWindow callback = (hwnd, _) =>
        {
            try
            {
                cancellation.ThrowIfCancellationRequested();
                if (!IsWindowVisible(hwnd)) return true;
                WindowIdentity identity;
                try { identity = Identity(hwnd); }
                catch (Exception error) when (error is ArgumentException or InvalidOperationException or Win32Exception or DesktopException) { return true; }
                if (identity.Desktop != worker.Desktop || identity.SessionId != worker.SessionId) return true;
                if (result.Count == 128) { stopped = true; return false; }
                result.Add((identity, Title(identity)));
                return true;
            }
            catch (Exception error) { failure = error; return false; }
        };
        var ok = EnumDesktopWindows(GetThreadDesktop(GetCurrentThreadId()), callback, 0);
        GC.KeepAlive(callback);
        if (failure is not null) throw failure;
        if (!ok && !stopped) throw new DesktopException("window_enumeration_failed");
        truncated = stopped;
        return result.ToArray();
    }
}
