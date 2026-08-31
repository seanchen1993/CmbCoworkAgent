using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

internal static class WindowsBackgroundJobController
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const string PowerShellBootstrapFileName =
        "background-job-controller-powershell-bootstrap.ps1";
    private const int CmdMaximumArgumentsLength = 8191;
    private const int CmdMaximumInputBytes = CmdMaximumArgumentsLength * 4 + 2;
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

    private static bool InitializeKillOnCloseJob(out string error)
    {
        jobHandle = CreateJobObject(IntPtr.Zero, null);
        if (jobHandle == IntPtr.Zero)
        {
            error = "CreateJobObject failed: " + Marshal.GetLastWin32Error();
            return false;
        }

        ExtendedLimitInformation limits = new ExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        int limitsSize = Marshal.SizeOf(typeof(ExtendedLimitInformation));
        IntPtr limitsPointer = Marshal.AllocHGlobal(limitsSize);
        try
        {
            Marshal.StructureToPtr(limits, limitsPointer, false);
            if (!SetInformationJobObject(jobHandle, 9, limitsPointer, (uint)limitsSize))
            {
                error = "SetInformationJobObject failed: " + Marshal.GetLastWin32Error();
                return false;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(limitsPointer);
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
