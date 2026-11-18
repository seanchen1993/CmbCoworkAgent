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

    private static bool SetKillOnClose(IntPtr job, bool enabled)
    {
        ExtendedLimitInformation limits = new ExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = enabled ? JobObjectLimitKillOnJobClose : 0;
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

        if (!SetKillOnClose(jobHandle, true))
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

    private static int ExecuteWithHandoff(string executable, bool hidden)
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
            if (!SetKillOnClose(job, true)) throw new IOException("Could not configure Windows Job");
            child = StartContainedProcess(job, executable, commandLine, hidden);

            object gate = new object();
            bool promoted = false;
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
                else if (!SetKillOnClose(job, false))
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
        if (args.Length != 2 || string.IsNullOrWhiteSpace(args[0]))
        {
            Console.Error.WriteLine("[LocalSandbox] Background shell path is missing");
            return 126;
        }

        if (args[1] == "handoff-hidden" || args[1] == "handoff-visible")
        {
            try { return ExecuteWithHandoff(args[0], args[1] == "handoff-hidden"); }
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

        string shellArguments = ShellArguments(args[1], cmdCommand);
        if (isCmdShell &&
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

            Task outputPump = child.StandardOutput.BaseStream.CopyToAsync(
                Console.OpenStandardOutput());
            Task errorPump = child.StandardError.BaseStream.CopyToAsync(
                Console.OpenStandardError());
            Stream childInput = isCmdShell ? null : child.StandardInput.BaseStream;
            Task inputPump = isCmdShell
                ? Task.FromResult(0)
                : Console.OpenStandardInput().CopyToAsync(childInput).ContinueWith(
                    delegate
                    {
                        try { childInput.Close(); } catch { }
                    });

            child.WaitForExit();
            int exitCode = child.ExitCode;
            // A daemon may inherit the shell's stdout/stderr writers. Waiting
            // for EOF without a bound would keep this controller (and therefore
            // its Job handle) alive forever. Preserve a short normal drain, then
            // return so JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE reaps that daemon.
            try { Task.WaitAll(new[] { outputPump, errorPump }, 500); } catch { }
            try { inputPump.Wait(100); } catch { }
            return exitCode;
        }
    }
}
