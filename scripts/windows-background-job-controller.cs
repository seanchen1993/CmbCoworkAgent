using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

internal static class WindowsBackgroundJobController
{
    private const uint JobObjectLimitBreakawayOk = 0x00000800;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const string PowerShellBootstrapFileName =
        "background-job-controller-powershell-bootstrap.ps1";
    private const int CmdMaximumArgumentsLength = 8191;
    private const int CmdMaximumInputBytes = CmdMaximumArgumentsLength * 4 + 2;
    private const uint StartWithStandardHandles = 0x00000100;
    private const uint CreateNoWindow = 0x08000000;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const int JobListAttribute = 0x0002000D;
    private const uint HandleFlagInherit = 1;
    private const uint WaitTimeout = 258;
    private const uint Infinite = 0xffffffff;
    private static IntPtr jobHandle = IntPtr.Zero;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedCount;
        public IntPtr ReservedPointer, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedStartupInfo
    {
        public StartupInfo StartupInfo;
        public IntPtr Attributes;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        IntPtr job, int informationClass, IntPtr information, uint informationLength,
        out uint returnLength);


    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job, int informationClass, IntPtr information, uint length, IntPtr returnedLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributes, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributes, uint flags, IntPtr attribute, ref IntPtr value, IntPtr size,
        IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributes);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment,
        string currentDirectory, ref ExtendedStartupInfo startupInfo, out ProcessInformation processInfo);

    [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr _get_osfhandle(int fd);

    private static bool StopRemainingJobChildren()
    {
        // The controller itself owns the kill-on-close Job. Keep it alive to drain output, but
        // reap descendants holding inherited pipe writers after the direct executable exits.
        const int capacity = 65536;
        int size = 8 + capacity * IntPtr.Size;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            int self = Process.GetCurrentProcess().Id;
            for (int attempt = 0; attempt < 32; attempt++)
            {
                uint returned;
                if (!QueryInformationJobObject(jobHandle, 3, buffer, (uint)size, out returned))
                    return false;
                int count = Marshal.ReadInt32(buffer, 4);
                if (count < 0 || count > capacity) return false;
                bool found = false;
                for (int index = 0; index < count; index++)
                {
                    long raw = Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64();
                    if (raw == self || raw <= 0 || raw > int.MaxValue) continue;
                    found = true;
                    try
                    {
                        using (Process descendant = Process.GetProcessById((int)raw))
                        {
                            bool belongs;
                            // A process id can be reused after the Job enumeration.
                            if (IsProcessInJob(descendant.Handle, jobHandle, out belongs) && belongs)
                                descendant.Kill();
                        }
                    }
                    catch (ArgumentException) { }
                    catch (InvalidOperationException) { }
                    catch (System.ComponentModel.Win32Exception) { }
                }
                if (!found) return true;
                System.Threading.Thread.Sleep(10);
            }
            return false;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static bool SetJobLimits(IntPtr job, uint flags)
    {
        ExtendedLimitInformation limits = new ExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = flags;
        int size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, pointer, false);
            return SetInformationJobObject(job, 9, pointer, (uint)size);
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    private static bool InitializeKillOnCloseJob(out string error)
    {
        jobHandle = CreateJobObject(IntPtr.Zero, null);
        if (jobHandle == IntPtr.Zero)
        {
            error = "CreateJobObject failed: " + Marshal.GetLastWin32Error();
            return false;
        }

        if (!SetJobLimits(jobHandle, JobObjectLimitKillOnJobClose))
        {
            error = "SetInformationJobObject failed: " + Marshal.GetLastWin32Error();
            return false;
        }

        using (Process current = Process.GetCurrentProcess())
        {
            if (!AssignProcessToJobObject(jobHandle, current.Handle))
            {
                error = "AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error();
                return false;
            }
        }
        error = null;
        return true;
    }

    private static List<IntPtr> OpenJobProcessHandles(IntPtr job)
    {
        // JobObjectBasicProcessIdList has two DWORDs, followed by a pointer-sized PID array.
        // Open handles before termination so cleanup can wait on the actual process objects,
        // even after their PIDs leave the Job list.
        int capacity = 16;
        while (true)
        {
            int size = 8 + capacity * IntPtr.Size;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                if (QueryInformationJobObject(job, 3, buffer, (uint)size, IntPtr.Zero))
                {
                    List<IntPtr> handles = new List<IntPtr>();
                    int count = Marshal.ReadInt32(buffer, 4);
                    for (int index = 0; index < count; index++)
                    {
                        uint pid = (uint)Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64();
                        // Query membership as well as opening SYNCHRONIZE. A rapid
                        // exit and PID reuse must not make us wait on an unrelated process.
                        IntPtr process = OpenProcess(0x00101000, false, pid);
                        if (process == IntPtr.Zero) continue;
                        bool belongsToJob;
                        if (IsProcessInJob(process, job, out belongsToJob) && belongsToJob)
                            handles.Add(process);
                        else CloseHandle(process);
                    }
                    return handles;
                }
                if (Marshal.GetLastWin32Error() != 234)
                    throw new IOException("Could not read Windows Job process list");
                capacity = Math.Max(capacity * 2, Marshal.ReadInt32(buffer));
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }

    private static void TerminateAndWait(IntPtr job)
    {
        List<IntPtr> handles = OpenJobProcessHandles(job);
        try
        {
            if (!TerminateJobObject(job, 130))
                throw new IOException("Could not terminate Windows Job");
            // Capture any remaining members created during the first list read.
            // TerminateJobObject also covers members whose handles cannot be opened.
            handles.AddRange(OpenJobProcessHandles(job));
            foreach (IntPtr process in handles) WaitForSingleObject(process, Infinite);
        }
        finally
        {
            foreach (IntPtr process in handles) CloseHandle(process);
        }
    }

    private static ProcessInformation StartContainedProcess(
        IntPtr job, string executable, string commandLine, bool hidden)
    {
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr attributes = Marshal.AllocHGlobal(size);
        bool initialized = false;
        try
        {
            initialized = InitializeProcThreadAttributeList(attributes, 1, 0, ref size);
            // Assign the job during CreateProcess. The controller can be stopped at
            // any point during startup without leaving an unassigned child behind.
            if (!initialized || !UpdateProcThreadAttribute(attributes, 0,
                new IntPtr(JobListAttribute), ref job, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw new IOException("Could not prepare Windows Job process attributes");
            ExtendedStartupInfo startup = new ExtendedStartupInfo
            {
                StartupInfo = new StartupInfo
                {
                    Size = Marshal.SizeOf(typeof(ExtendedStartupInfo)),
                    Flags = StartWithStandardHandles,
                    Input = GetStdHandle(-10),
                    Output = GetStdHandle(-11),
                    Error = GetStdHandle(-12)
                },
                Attributes = attributes
            };
            ProcessInformation child;
            if (!CreateProcess(Path.IsPathRooted(executable) ? executable : null,
                new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
                ExtendedStartupInfoPresent | (hidden ? CreateNoWindow : 0), IntPtr.Zero, null,
                ref startup, out child))
                throw new IOException("Could not start Windows command (" + Marshal.GetLastWin32Error() + ")");
            return child;
        }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes);
        }
    }

    private static int ExecuteWithHandoff(string executable, bool hidden, string initialMode)
    {
        IntPtr requestHandle = _get_osfhandle(3);
        IntPtr statusHandle = _get_osfhandle(4);
        // Use separate synchronous pipes so a blocked read cannot delay an exit
        // notification. Neither pipe is inherited by the command.
        if (requestHandle == new IntPtr(-1) || statusHandle == new IntPtr(-1) ||
            !SetHandleInformation(requestHandle, HandleFlagInherit, 0) ||
            !SetHandleInformation(statusHandle, HandleFlagInherit, 0))
            throw new IOException("Windows Job control pipe is unavailable");
        var input = new FileStream(new SafeFileHandle(requestHandle, false), FileAccess.Read, 1);
        var output = new FileStream(new SafeFileHandle(statusHandle, false), FileAccess.Write, 1);
        var reader = new BinaryReader(input);
        int byteCount = reader.ReadInt32();
        if (byteCount < 0 || byteCount > 2 * 32767 || byteCount % 2 != 0)
            throw new InvalidDataException("Windows command line exceeds its transport limit");
        byte[] arguments = reader.ReadBytes(byteCount);
        if (arguments.Length != byteCount) throw new EndOfStreamException();
        string commandLine = "\"" + executable + "\" " + Encoding.Unicode.GetString(arguments);
        if (commandLine.Length >= 32767 || commandLine.IndexOf('\0') >= 0)
            throw new InvalidDataException("Invalid Windows command line");

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new IOException("Could not create Windows Job");
        ProcessInformation child = new ProcessInformation();
        try
        {
            // Only a direct foreground shell retains Windows' explicit child breakaway.
            // Ordinary descendants join the job at creation, even before promotion.
            uint foregroundLimits = initialMode == "foreground-breakaway" ? JobObjectLimitBreakawayOk : 0;
            if (!SetJobLimits(job, JobObjectLimitKillOnJobClose | foregroundLimits))
                throw new IOException("Could not configure Windows Job");
            child = StartContainedProcess(job, executable, commandLine, hidden);

            object gate = new object();
            bool promoted = initialMode == "already-promoted";
            bool finished = false;
            bool cancelled = false;
            bool cleanupDone = false;
            Action<byte> send = value => { output.WriteByte(value); output.Flush(); };
            send((byte)'S');
            var control = new Thread(() =>
            {
                try
                {
                    for (;;)
                    {
                        int key = input.ReadByte();
                        lock (gate)
                        {
                            if (finished) return;
                            if (key == (byte)'C' || key < 0)
                            {
                                cancelled = true;
                                TerminateAndWait(job);
                                cleanupDone = true;
                                return;
                            }
                            if (key == (byte)'P' && !promoted &&
                                WaitForSingleObject(child.Process, 0) == WaitTimeout)
                            {
                                if (foregroundLimits != 0 &&
                                    !SetJobLimits(job, JobObjectLimitKillOnJobClose))
                                    throw new IOException("Could not restrict promoted Windows Job");
                                promoted = true;
                                send((byte)'P');
                            }
                        }
                    }
                }
                catch (IOException)
                {
                    lock (gate)
                    {
                        if (finished) return;
                        cancelled = true;
                        TerminateJobObject(job, 130);
                    }
                }
            });
            control.IsBackground = true;
            control.Start();

            WaitForSingleObject(child.Process, Infinite);
            lock (gate)
            {
                // A promotion is accepted only while the actual command runs.
                // The Node timer cannot promote a process that already exited
                // while its controller and stdout/stderr pipes are still draining.
                finished = true;
                send((byte)'E');
                if (promoted || cancelled)
                {
                    if (!cleanupDone) TerminateAndWait(job);
                }
                else if (!SetJobLimits(job, foregroundLimits))
                    throw new IOException("Could not release short command's Windows Job");
            }
            uint exitCode;
            if (!GetExitCodeProcess(child.Process, out exitCode))
                throw new IOException("Could not read Windows command exit code");
            return unchecked((int)exitCode);
        }
        finally
        {
            if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
            if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
            CloseHandle(job);
        }
    }

    private static string ShellArguments(string shellKind, string cmdCommand)
    {
        if (string.Equals(shellKind, "powershell", StringComparison.OrdinalIgnoreCase))
        {
            string bootstrapPath = Path.Combine(
                AppDomain.CurrentDomain.BaseDirectory,
                PowerShellBootstrapFileName);
            return "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" +
                bootstrapPath + "\"";
        }
        if (string.Equals(shellKind, "cmd", StringComparison.OrdinalIgnoreCase))
        {
            // Match Node's established spawn(command, { shell: cmd.exe })
            // contract. In particular, this preserves command-line `%A`, `%0`,
            // and percent-expansion semantics that a temporary batch file cannot.
            return "/D /S /C \"" + cmdCommand + "\"";
        }
        return string.Empty;
    }

    private static bool IsCmdShell(string shellKind)
    {
        return string.Equals(shellKind, "cmd", StringComparison.OrdinalIgnoreCase);
    }

    private static int WindowsCommandLineLength(string executable, string arguments)
    {
        bool quoteExecutable = executable.IndexOfAny(new[] { ' ', '\t' }) >= 0;
        int executableLength = executable.Length + (quoteExecutable ? 2 : 0);
        return executableLength + 1 + arguments.Length;
    }

    private static string RequiredBootstrapPath(string shellKind)
    {
        if (string.Equals(shellKind, "powershell", StringComparison.OrdinalIgnoreCase))
        {
            return Path.Combine(
                AppDomain.CurrentDomain.BaseDirectory,
                PowerShellBootstrapFileName);
        }
        return null;
    }

    private static string ReadCmdCommand(Stream input)
    {
        using (MemoryStream commandBytes = new MemoryStream())
        {
            byte[] buffer = new byte[4096];
            int bytesRead;
            while ((bytesRead = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (commandBytes.Length + bytesRead > CmdMaximumInputBytes)
                {
                    throw new InvalidDataException(
                        "cmd command exceeds the bounded transport limit");
                }
                commandBytes.Write(buffer, 0, bytesRead);
            }
            UTF8Encoding strictUtf8 = new UTF8Encoding(false, true);
            string command = strictUtf8.GetString(commandBytes.ToArray());

            // LocalSandbox adds one newline as the controller transport
            // delimiter. Remove exactly that delimiter and preserve any newline
            // that was part of the original command.
            if (command.EndsWith("\n", StringComparison.Ordinal))
            {
                command = command.Substring(0, command.Length - 1);
                if (command.EndsWith("\r", StringComparison.Ordinal))
                {
                    command = command.Substring(0, command.Length - 1);
                }
            }
            if (command.IndexOf('\0') >= 0)
            {
                throw new InvalidDataException("cmd command contains a NUL character");
            }
            return command;
        }
    }

    private static int Main(string[] args)
    {
        bool isRecovery = args.Length >= 2 &&
            (args[1] == "recovery-argv-file" || args[1] == "recovery-cmd-file");
        bool isArgvCmd = args.Length >= 2 &&
            (args[1] == "argv-cmd" || args[1] == "recovery-cmd-file");
        bool isHook = !isRecovery && args.Length >= 2 && (args[1] == "hook-argv" || isArgvCmd);
        bool isArgv = args.Length >= 2 && (args[1] == "argv" || isHook || isRecovery);
        bool handoff = args.Length >= 2 && (args[1] == "handoff-hidden" || args[1] == "handoff-visible");
        string initialMode = handoff && args.Length == 3 ? args[2] : null;
        bool validInitialMode = initialMode == "foreground-breakaway" || initialMode == "already-promoted";
        bool validArguments = handoff
            ? args.Length == 2 || (args.Length == 3 && validInitialMode)
            : isArgv ? args.Length >= 3 : args.Length == 2;
        if (!validArguments || string.IsNullOrWhiteSpace(args[0]))
        {
            Console.Error.WriteLine("[LocalSandbox] Background shell path is missing");
            return 126;
        }
        if (isArgvCmd && args.Length != 4) return 126;
        byte[] recoveryInput = null;
        if (isRecovery)
        {
            // The outer native controller already owns this sandbox's lifetime and Job.
            // Codex's sandbox command does not forward stdin; restore only the host-frozen
            // bounded byte payload, without interpolating JSON into a command line.
            try
            {
                if (!Path.IsPathRooted(args[2])) return 126;
                using (FileStream input = new FileStream(args[2], FileMode.Open, FileAccess.Read,
                    FileShare.Read))
                {
                    if (input.Length > 1000000) return 126;
                    recoveryInput = new byte[(int)input.Length];
                    int offset = 0;
                    while (offset < recoveryInput.Length)
                    {
                        int count = input.Read(recoveryInput, offset, recoveryInput.Length - offset);
                        if (count == 0) return 126;
                        offset += count;
                    }
                }
            }
            catch { return 126; }
        }

        if (handoff)
        {
            try { return ExecuteWithHandoff(args[0], args[1] == "handoff-hidden", initialMode); }
            catch (Exception error)
            {
                Console.Error.WriteLine("[LocalSandbox] Windows Job command failed: " + error.Message);
                return 125;
            }
        }

        string jobError;
        if (!InitializeKillOnCloseJob(out jobError))
        {
            Console.Error.WriteLine(
                "[LocalSandbox] Windows Job Object unavailable; background command was not " +
                "started: " + jobError);
            return 125;
        }

        if (isArgv && !isRecovery && !WatchHostLifetime(args[2])) return 125;

        bool isCmdShell = IsCmdShell(args[1]);

        string requiredBootstrapPath = RequiredBootstrapPath(args[1]);
        if (requiredBootstrapPath != null && !File.Exists(requiredBootstrapPath))
        {
            Console.Error.WriteLine(
                "[LocalSandbox] Background shell bootstrap is missing: " +
                requiredBootstrapPath);
            return 126;
        }

        string cmdCommand = null;
        if (isCmdShell)
        {
            try
            {
                cmdCommand = ReadCmdCommand(Console.OpenStandardInput());
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(
                    "[LocalSandbox] Background cmd command could not be prepared: " +
                    error.Message);
                return 126;
            }
        }

        // Hook commands preserve Node's raw cmd quoting while their JSON stdin remains input.
        // The ordinary argv protocol continues to use CRT argument quoting unchanged.
        string shellArguments = isArgvCmd ? ShellArguments("cmd", args[3]) :
            isArgv ? DirectArguments(args) : ShellArguments(args[1], cmdCommand);
        if ((isCmdShell || isArgvCmd) &&
            WindowsCommandLineLength(args[0], shellArguments) > CmdMaximumArgumentsLength)
        {
            Console.Error.WriteLine(
                "[LocalSandbox] Background cmd command exceeds the 8191-character limit");
            return 126;
        }

        if (!isCmdShell)
        {
            try
            {
                // .NET Framework does not expose ProcessStartInfo's newer
                // StandardInputEncoding property. Process.StandardInput uses
                // Console.InputEncoding when it constructs its StreamWriter,
                // so fix that encoding before Start/StandardInput access and
                // ensure its automatic first flush has no UTF-8 preamble.
                Console.InputEncoding = new UTF8Encoding(false);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(
                    "[LocalSandbox] Background stdin encoding could not be prepared: " +
                    error.Message);
                return 126;
            }
        }

        ProcessStartInfo startInfo = new ProcessStartInfo
        {
            FileName = args[0],
            Arguments = shellArguments,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = !isCmdShell,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        if (isRecovery)
        {
            string recoveryCwd = Environment.GetEnvironmentVariable("CMB_STAGE_RECOVERY_COMMAND_CWD");
            if (string.IsNullOrWhiteSpace(recoveryCwd) || !Path.IsPathRooted(recoveryCwd) ||
                !Directory.Exists(recoveryCwd)) return 126;
            // The native producer validates this path against the branch and pinned source.
            // The command still runs inside the same restricted token and owned Job.
            startInfo.WorkingDirectory = recoveryCwd;
        }

        using (Process child = new Process { StartInfo = startInfo })
        {
            try
            {
                if (!child.Start())
                {
                    Console.Error.WriteLine(
                        "[LocalSandbox] Background shell failed to start");
                    return 126;
                }
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(
                    "[LocalSandbox] Background shell failed to start: " + error.Message);
                return 126;
            }

            string hookNonce = null;
            if (isArgv && !isRecovery)
            {
                // Private protocol prefix: distinguish executable startup failure from exit 126.
                // Write before pumping either child stream; the Mods host removes this prefix.
                // This nonce is controller-private: never put it in child argv/environment.
                // A Hook cannot manufacture a valid native cleanup trailer in its own stdout.
                hookNonce = isHook ? Guid.NewGuid().ToString("N") : null;
                byte[] ready = Encoding.ASCII.GetBytes(isHook
                    ? "MODS_HOOK_STARTED_V1:" + hookNonce + "\n"
                    : "MODS_PROCESS_STARTED_V1\n");
                Stream output = Console.OpenStandardOutput();
                output.Write(ready, 0, ready.Length);
                output.Flush();
            }
            Task outputPump = child.StandardOutput.BaseStream.CopyToAsync(
                Console.OpenStandardOutput());
            Task errorPump = child.StandardError.BaseStream.CopyToAsync(
                Console.OpenStandardError());
            Stream childInput = isCmdShell ? null : child.StandardInput.BaseStream;
            Task inputPump = isCmdShell
                ? Task.FromResult(0)
                : (isRecovery ? (Stream)new MemoryStream(recoveryInput, false) :
                    Console.OpenStandardInput()).CopyToAsync(childInput).ContinueWith(
                    delegate
                    {
                        try { childInput.Close(); } catch { }
                    });

            child.WaitForExit();
            int exitCode = child.ExitCode;
            if (isArgv)
            {
                // A paused consumer can take arbitrarily long to drain. Do not apply the legacy
                // shell drain deadline to the argv stream; cancellation closes this Job instead.
                if (!StopRemainingJobChildren()) return 125;
                try { Task.WaitAll(new[] { outputPump, errorPump }); } catch { return 125; }
                if (isHook)
                {
                    byte[] settled = Encoding.ASCII.GetBytes(
                        "MODS_HOOK_SETTLED_V1:" + hookNonce + ":0\n");
                    Stream output = Console.OpenStandardOutput();
                    output.Write(settled, 0, settled.Length);
                    output.Flush();
                }
                return exitCode;
            }
            // A daemon may inherit the shell's stdout/stderr writers. Waiting
            // for EOF without a bound would keep this controller (and therefore
            // its Job handle) alive forever. Preserve a short normal drain, then
            // return so JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE reaps that daemon.
            try { Task.WaitAll(new[] { outputPump, errorPump }, 500); } catch { }
            try { inputPump.Wait(100); } catch { }
            return exitCode;
        }
    }

    private static string DirectArguments(string[] args)
    {
        StringBuilder result = new StringBuilder();
        for (int index = 3; index < args.Length; index++)
        {
            if (index > 3) result.Append(' ');
            // Windows CRT argv quoting, never a shell command. Backslashes only need doubling
            // before a quote and before the closing quote; empty arguments stay explicit.
            result.Append('"');
            int slashes = 0;
            foreach (char character in args[index])
            {
                if (character == '\\') { slashes++; continue; }
                if (character == '"')
                {
                    result.Append('\\', slashes * 2 + 1);
                    result.Append('"');
                }
                else
                {
                    result.Append('\\', slashes);
                    result.Append(character);
                }
                slashes = 0;
            }
            result.Append('\\', slashes * 2);
            result.Append('"');
        }
        return result.ToString();
    }

    private static bool WatchHostLifetime(string value)
    {
        int parentId;
        if (!int.TryParse(value, out parentId) || parentId <= 0 ||
            parentId == Process.GetCurrentProcess().Id) return false;
        Process owner;
        try
        {
            owner = Process.GetProcessById(parentId);
            // Acquire and retain the actual kernel process handle now, never reopen by PID later.
            if (owner.Handle == IntPtr.Zero || owner.HasExited) { owner.Dispose(); return false; }
        }
        catch { return false; }
        Task.Run(delegate
        {
            using (owner)
            {
                try { owner.WaitForExit(); }
                finally { Environment.Exit(125); }
            }
        });
        return true;
    }
}
