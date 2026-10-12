// Physical launch port only. The trusted Host broker calls it AFTER the existing
// Bot graph's approval/effect boundary has authorized this exact argv and policy.
// No system shell, ShellExecute, UAC elevation, global desktop or Job handle is used.
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace CmbNativeDesktop;

internal sealed record LaunchParameters(string Executable, string[] Arguments, string Cwd);
internal sealed record LaunchProcess(int Pid, string StartTicks, int SessionId, string Desktop);

internal static class Launch
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        internal uint Size;
        internal string? Reserved, Desktop, Title;
        internal uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
        internal ushort Show, ReservedBytes;
        internal nint ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { internal nint Process, Thread; internal uint Pid, Tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string executable, [In, Out, MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.U2)] char[] command, nint processSecurity, nint threadSecurity,
        bool inherit, uint flags, nint environment, string cwd, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint creation, uint flags, nint template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, [Out, MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.U2)] char[] path, uint length, uint flags);

    internal static string[] Roots(JsonElement parameters, string name)
    {
        if (!parameters.TryGetProperty(name, out var roots)) return [];
        if (roots.ValueKind != JsonValueKind.Array || roots.GetArrayLength() > 64) throw new DesktopException("invalid_launch_roots");
        return roots.EnumerateArray().Select(root => root.ValueKind == JsonValueKind.String && root.GetString() is { } text
            ? CanonicalPath(text, directory: true) : throw new DesktopException("invalid_launch_roots")).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }
    internal static LaunchParameters Parameters(JsonElement parameters, string[] readRoots, string[] writeRoots)
    {
        foreach (var property in parameters.EnumerateObject())
            if (property.Name is not ("executable" or "arguments" or "cwd" or "readRoots" or "writeRoots"))
                throw new DesktopException("unknown_launch_parameter");
        if (!parameters.TryGetProperty("executable", out var exeProperty) || exeProperty.GetString() is not { } exe ||
            !parameters.TryGetProperty("cwd", out var cwdProperty) || cwdProperty.GetString() is not { } cwd ||
            !parameters.TryGetProperty("arguments", out var arguments) || arguments.ValueKind != JsonValueKind.Array || arguments.GetArrayLength() > 128)
            throw new DesktopException("invalid_launch_parameters");
        var exactRead = Roots(parameters, "readRoots"); var exactWrite = Roots(parameters, "writeRoots");
        if (!SameRoots(exactRead, readRoots) || !SameRoots(exactWrite, writeRoots)) throw new DesktopException("launch_policy_changed");
        exe = CanonicalPath(exe, directory: false); cwd = CanonicalPath(cwd, directory: true);
        if (!exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !Under(exe, readRoots) || !Under(cwd, readRoots))
            throw new DesktopException("launch_outside_policy");
        var argv = arguments.EnumerateArray().Select(argument => argument.ValueKind == JsonValueKind.String && argument.GetString() is { } text &&
            text.Length <= 8192 && !text.Contains('\0') ? text : throw new DesktopException("invalid_launch_argument")).ToArray();
        if (argv.Sum(argument => (long)argument.Length) + exe.Length >= 30000) throw new DesktopException("launch_command_too_large");
        return new(exe, argv, cwd);
    }
    private static bool SameRoots(string[] first, string[] second) => first.Length == second.Length &&
        new HashSet<string>(first, StringComparer.OrdinalIgnoreCase).SetEquals(second);
    private static bool Under(string path, string[] roots) => roots.Any(root => path.Equals(root, StringComparison.OrdinalIgnoreCase) ||
        path.StartsWith(root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase));
    private static string CanonicalPath(string path, bool directory)
    {
        if (path.Length is < 3 or > 4096 || path.Contains('\0') || !Path.IsPathFullyQualified(path) || path.StartsWith("\\\\", StringComparison.Ordinal) ||
            path.Length < 3 || !char.IsAsciiLetter(path[0]) || path[1] != ':' || path[2] != '\\')
            throw new DesktopException("absolute_local_launch_path_required");
        var full = Path.GetFullPath(path);
        using var handle = CreateFileW(full, 0x80, 7, 0, 3, directory ? 0x02000000U : 0U, 0);
        if (handle.IsInvalid) throw new DesktopException("launch_path_unreadable");
        var output = new char[4096];
        var length = GetFinalPathNameByHandleW(handle, output, (uint)output.Length, 0);
        if (length is 0 or >= 4096) throw new DesktopException("launch_path_not_canonical");
        var result = new string(output, 0, checked((int)length));
        if (result.StartsWith("\\\\?\\", StringComparison.Ordinal)) result = result[4..];
        if (result.Length < 3 || !char.IsAsciiLetter(result[0]) || result[1] != ':' || result[2] != '\\')
            throw new DesktopException("launch_path_not_local");
        if (directory && !Directory.Exists(result) || !directory && !File.Exists(result)) throw new DesktopException("launch_path_type_mismatch");
        return result.Length > 3 ? result.TrimEnd('\\') : result;
    }
    private static string Quote(string argument)
    {
        if (!argument.Contains('"') && !argument.Any(char.IsWhiteSpace) && argument.Length > 0) return argument;
        var text = new StringBuilder("\""); var slashes = 0;
        foreach (var character in argument)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') text.Append('\\', slashes * 2 + 1).Append('"');
            else text.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        return text.Append('\\', slashes * 2).Append('"').ToString();
    }
    internal static PendingLaunch StartSuspended(LaunchParameters launch, WorkerIdentity worker)
    {
        Native.AssertPrivate(worker.Desktop);
        var command = new StringBuilder(Quote(launch.Executable));
        foreach (var argument in launch.Arguments) command.Append(' ').Append(Quote(argument));
        if (command.Length >= 32767) throw new DesktopException("launch_command_too_large");
        var startup = new StartupInfo { Size = (uint)Marshal.SizeOf<StartupInfo>(), Desktop = "Winsta0\\" + worker.Desktop,
            Flags = 0x100, Input = 0, Output = 0, Error = 0 };
        // Inherit no handles: in particular this child can never prolong the owner Job's last
        // handle, or write arbitrary bytes into the worker's framed stdout pipe.
        var commandBuffer = new char[command.Length + 1];
        command.CopyTo(0, commandBuffer, 0, command.Length);
        if (!CreateProcessW(launch.Executable, commandBuffer, 0, 0, false, 0x4 | 0x08000000, 0, launch.Cwd, ref startup, out var information))
            throw new DesktopException("native_launch_failed");
        try
        {
            using var process = Process.GetProcessById(checked((int)information.Pid));
            var identity = new LaunchProcess(process.Id, Wire.CanonicalLong(process.StartTime.ToUniversalTime().Ticks), process.SessionId, worker.Desktop);
            if (identity.SessionId != worker.SessionId) throw new DesktopException("launch_session_changed");
            return new PendingLaunch(information.Process, information.Thread, identity);
        }
        catch
        {
            PendingLaunch.CloseFailed(information.Process, information.Thread);
            throw;
        }
    }
}

internal sealed class PendingLaunch(nint processHandle, nint threadHandle, LaunchProcess identity) : IDisposable
{
    internal string Id { get; } = Guid.NewGuid().ToString("D");
    internal LaunchProcess Identity { get; } = identity;
    internal long CreatedAt { get; } = Environment.TickCount64;
    private bool resumed;
    private bool disposed;
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(nint thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(nint process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(nint handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(nint handle, uint timeout);
    internal void Resume()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        using var process = Process.GetProcessById(Identity.Pid);
        if (process.HasExited || Wire.CanonicalLong(process.StartTime.ToUniversalTime().Ticks) != Identity.StartTicks || process.SessionId != Identity.SessionId)
            throw new DesktopException("stale_launch_process");
        if (ResumeThread(threadHandle) != 1) throw new DesktopException("launch_resume_uncertain");
        resumed = true;
    }
    internal static void CloseFailed(nint process, nint thread)
    {
        try
        {
            var terminationIssued = TerminateProcess(process, 125);
            var exit = WaitForSingleObject(process, 2000);
            if (exit != 0) throw new DesktopException(terminationIssued ? "launch_stop_unproven" : "launch_terminate_unproven");
        }
        finally { CloseHandle(thread); CloseHandle(process); }
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true;
        if (!resumed) CloseFailed(processHandle, threadHandle);
        else { CloseHandle(threadHandle); CloseHandle(processHandle); }
        // No local exit/kill claim stands in for the external owner's ALL-members-empty receipt.
    }
}
