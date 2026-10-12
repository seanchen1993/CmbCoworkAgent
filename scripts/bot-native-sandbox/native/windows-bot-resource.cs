// CMBDevClaw Bot-only lifetime owner. Existing LocalSandbox controller stays
// unchanged. Build: csc /nologo /optimize+ /target:exe /out:bot-resource-owner.exe
// WindowsBackgroundJobController's Job structs/kill-on-close pattern is reused
// from this repository (scripts/windows-background-job-controller.cs).
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

internal static class WindowsBotResource
{
    private const uint KillOnClose = 0x2000, Suspended = 0x4, NoWindow = 0x08000000;
    private const uint InheritHandles = 0x1, StdHandles = 0x100;
    private const uint OpenExisting = 3, BackupSemantics = 0x02000000;
    private const uint OpenReparsePoint = 0x00200000, ReparsePoint = 0x400;
    private const uint ReadAttributes = 0x80, ShareAll = 7;
    private const int MaximumInput = 65536, MaximumProof = 32768;
    private const string Magic = "CMBBOTJOB2";
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits {
        public long PerProcess, PerJob; public uint Flags;
        public UIntPtr Minimum, Maximum; public uint ActiveLimit;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters {
        public ulong A, B, C, D, E, F;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct StartupInfo {
        public uint Size; public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
        public ushort Show, ReservedBytes; public IntPtr ReservedPointer;
        public IntPtr Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation {
        public IntPtr Process, Thread; public uint Pid, Tid;
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr CreateJobObject(ref SecurityAttributes security, string name);
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public uint Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits limits, uint bytes);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, uint bytes, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(string app, [In, Out, MarshalAs(UnmanagedType.LPArray, ArraySubType=UnmanagedType.U2)] char[] command, IntPtr processSecurity, IntPtr threadSecurity,
        bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint sharing, IntPtr security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation info);
    private sealed class Request {
        public string Exe, Cwd, Directory, JobName, BootId, ControlProtocol; public string[] Arguments; public byte[] Proof; public uint TimeoutMs, Pids, Session, MaximumControls; public ulong Memory;
    }
    private static Win32Exception WinError(string operation) { return new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    private static uint ReadNumber(Stream input) {
        byte[] bytes = ReadExactly(input, 4); return (uint)((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]);
    }
    private static byte[] ReadExactly(Stream input, int count) {
        if(count < 0 || count > MaximumInput) throw new InvalidDataException("Invalid resource input length");
        byte[] bytes = new byte[count]; int offset = 0, read;
        while(offset < count && (read = input.Read(bytes, offset, count - offset)) > 0) offset += read;
        if(offset != count) throw new EndOfStreamException("Incomplete resource request"); return bytes;
    }
    private static string ReadString(Stream input, int maximum) {
        uint length = ReadNumber(input); if(length > maximum) throw new InvalidDataException("Resource field exceeds bound");
        string value = new UTF8Encoding(false, true).GetString(ReadExactly(input, (int)length));
        if(value.Contains("\0")) throw new InvalidDataException("Resource field contains NUL"); return value;
    }
    private static Request ReadRequest(bool desktop) {
        Stream source = Console.OpenStandardInput(); uint size = ReadNumber(source);
        if(size == 0 || size > MaximumInput) throw new InvalidDataException("Resource request exceeds bound");
        byte[] bytes = ReadExactly(source, (int)size);
        using(MemoryStream input = new MemoryStream(bytes, false)) {
            if(ReadString(input, 16) != Magic) throw new InvalidDataException("Invalid resource protocol");
            Request request = new Request { Exe = ReadString(input, 4096), Cwd = ReadString(input, 4096), Directory = ReadString(input, 4096), JobName = ReadString(input, 128) };
            Guid nonce;
            if(!request.JobName.StartsWith("Local\\CMBDevClaw-Bot-", StringComparison.Ordinal) || !Guid.TryParseExact(request.JobName.Substring(21), "D", out nonce)) throw new InvalidDataException("Invalid Bot Job identity");
            uint count = ReadNumber(input); if(count > 16) throw new InvalidDataException("Too many bootstrap arguments");
            request.Arguments = new string[(int)count]; for(int i = 0; i < count; i++) request.Arguments[i] = ReadString(input, 4096);
            request.Pids = ReadNumber(input); request.Memory = ReadNumber(input) * 4294967296UL + ReadNumber(input);
            if(request.Pids < 16 || request.Pids > 4096 || request.Memory < 268435456UL || request.Memory > 17179869184UL) throw new InvalidDataException("Resource limits exceed bounds");
            request.BootId = ReadString(input, 36); request.Session = ReadNumber(input);
            request.TimeoutMs = ReadNumber(input);
            if(request.TimeoutMs < 1000 || request.TimeoutMs > (desktop ? 86400000U : 7245000U)) throw new InvalidDataException("Invalid resource deadline");
            request.ControlProtocol = desktop ? DesktopProtocol : Protocol;
            request.MaximumControls = desktop ? 4096U : 64U;
            uint proofLength = ReadNumber(input); if(proofLength == 0 || proofLength > MaximumProof) throw new InvalidDataException("Invalid resource proof");
            request.Proof = ReadExactly(input, (int)proofLength);
            new UTF8Encoding(false, true).GetString(request.Proof);
            if(input.Position != input.Length) throw new InvalidDataException("Trailing resource input");
            if(!Path.IsPathRooted(request.Exe) || !Path.IsPathRooted(request.Cwd) || !Path.IsPathRooted(request.Directory)) throw new InvalidDataException("Resource paths must be absolute");
            return request;
        }
    }
    private static string Quote(string value) {
        bool needsQuotes = value.Length == 0;
        foreach(char character in value) if(character == ' ' || character == '\t' || character == '"') { needsQuotes = true; break; }
        if(!needsQuotes) return value;
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach(char character in value) {
            if(character == '\\') { slashes++; continue; }
            if(character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(character); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    private static SafeFileHandle PinDirectory(string path, out FileInformation info) {
        info = new FileInformation();
        SafeFileHandle handle = CreateFile(path, ReadAttributes, ShareAll, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
        if(handle.IsInvalid || !GetFileInformationByHandle(handle, out info)) { handle.Dispose(); throw WinError("Pin resource directory"); }
        if((info.Attributes & ReparsePoint) != 0 || (info.Attributes & 0x10) == 0) { handle.Dispose(); throw new IOException("Resource directory is a reparse point or not a directory"); }
        return handle;
    }
    private static bool SameDirectory(FileInformation left, FileInformation right) {
        return left.Volume == right.Volume && left.IndexHigh == right.IndexHigh && left.IndexLow == right.IndexLow;
    }
    private static void PublishProof(Request request, FileInformation expected) {
        FileInformation current;
        using(SafeFileHandle pin = PinDirectory(request.Directory, out current)) {
            if(!SameDirectory(current, expected)) throw new IOException("Resource directory changed");
            string target = Path.Combine(request.Directory, "closure.json"), pending = Path.Combine(request.Directory, "native-closure.pending");
            bool owned = false;
            try {
                using(FileStream file = new FileStream(pending, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) {
                    owned = true; file.Write(request.Proof, 0, request.Proof.Length); file.Flush(true);
                }
                FileInformation next;
                using(SafeFileHandle second = PinDirectory(request.Directory, out next)) {
                    if(!SameDirectory(next, expected)) throw new IOException("Resource directory changed before publication");
                    if(!MoveFileEx(pending, target, 8)) throw WinError("Publish durable Bot closure"); owned = false;
                }
            } finally { if(owned) { try { File.Delete(pending); } catch {} } }
        }
    }

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileEx(string source, string target, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(IntPtr job, int type, IntPtr buffer, uint size, out uint returned);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError=true)] private static extern void SetLastError(uint error);
    [DllImport("ntdll.dll")] private static extern int NtQuerySystemInformation(int type, IntPtr buffer, uint size, out uint returned);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint flags);
    private const string Protocol = "cmb-atomic-windows-job-v2";
    private const string DesktopProtocol = "cmb-native-desktop-owner-v1";
    private const uint ActiveProcessLimit = 8, JobMemoryLimit = 512;
    private static readonly object OutputLock = new object();
    private static void Frame(string value) { lock(OutputLock) { Console.Out.WriteLine(value); Console.Out.Flush(); } }
    private static void ABI() {
        if(IntPtr.Size != 8 || Marshal.SizeOf<StartupInfo>() != 104 || Marshal.SizeOf<ProcessInformation>() != 24 ||
            Marshal.SizeOf<ExtendedLimits>() != 144 || Marshal.SizeOf<Accounting>() != 48) throw new InvalidDataException("Unsupported native Job ABI");
    }
    private static string Boot(out uint session) {
        if(!ProcessIdToSessionId(GetCurrentProcessId(), out session)) throw WinError("Read Windows session");
        IntPtr memory = Marshal.AllocHGlobal(32);
        try {
            uint returned; if(NtQuerySystemInformation(90, memory, 32, out returned) != 0 || returned < 20 || returned > 32) throw new IOException("Windows boot identity unavailable");
            byte[] bytes = new byte[16]; Marshal.Copy(memory, bytes, 0, bytes.Length); Guid boot = new Guid(bytes);
            if(boot == Guid.Empty) throw new IOException("Windows boot identity is empty"); return boot.ToString("D");
        } finally { Marshal.FreeHGlobal(memory); }
    }
    private static IntPtr NewJob(string name, uint pids, ulong memory) {
        ABI(); IntPtr descriptor = IntPtr.Zero, job = IntPtr.Zero; uint descriptorSize;
        string sid = WindowsIdentity.GetCurrent().User.Value;
        if(!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;"+sid+")",1,out descriptor,out descriptorSize)) throw WinError("Create private Bot Job ACL");
        try {
            SecurityAttributes security = new SecurityAttributes {Length=(uint)Marshal.SizeOf<SecurityAttributes>(),Descriptor=descriptor,Inherit=false};
            // CreateJobObject succeeds for existing names; stale last-error must
            // never decide whether a new unique kernel object was allocated.
            SetLastError(0); job=CreateJobObject(ref security,name); int error=Marshal.GetLastWin32Error();
            if(job==IntPtr.Zero || error==183) throw new Win32Exception(error,"Create unique Bot Job");
            ExtendedLimits limits=new ExtendedLimits(); limits.Basic.Flags=KillOnClose|ActiveProcessLimit|JobMemoryLimit;
            limits.Basic.ActiveLimit=pids; limits.JobMemory=new UIntPtr(memory);
            if(!SetInformationJobObject(job,9,ref limits,144)) throw WinError("Configure bounded Bot Job");
            IntPtr check=Marshal.AllocHGlobal(144);
            try {
                uint returned; if(!QueryInformationJobObject(job,9,check,144,out returned) || returned!=144) throw WinError("Verify Bot Job limits");
                ExtendedLimits actual=Marshal.PtrToStructure<ExtendedLimits>(check);
                if(actual.Basic.Flags!=limits.Basic.Flags || actual.Basic.ActiveLimit!=pids || actual.JobMemory.ToUInt64()!=memory) throw new IOException("Bot Job limit verification failed");
            } finally {Marshal.FreeHGlobal(check);}
            return job;
        } catch {if(job!=IntPtr.Zero)CloseHandle(job);throw;}
        finally {if(descriptor!=IntPtr.Zero)LocalFree(descriptor);}
    }
    private static bool Member(IntPtr job,uint pid,uint pids) {
        // Query the actual owned Job's live process list; this is never an old
        // persisted PID termination permission. The fixed live probe has not
        // admitted any user command and is held alive for this handshake.
        int size=8+checked((int)pids)*IntPtr.Size; IntPtr buffer=Marshal.AllocHGlobal(size);
        try {
            uint returned; if(!QueryInformationJobObject(job,3,buffer,(uint)size,out returned) || returned<8 || returned>size) throw WinError("Read actual Bot Job members");
            uint assigned=(uint)Marshal.ReadInt32(buffer,0), count=(uint)Marshal.ReadInt32(buffer,4);
            if(count>pids || assigned<count || returned<8+count*IntPtr.Size) throw new IOException("Invalid bounded Bot Job membership");
            for(int i=0;i<count;i++) if((ulong)Marshal.ReadIntPtr(buffer,8+i*IntPtr.Size).ToInt64()==pid)return true;
            return false;
        } finally {Marshal.FreeHGlobal(buffer);}
    }
    private static void Monitor(Stream input,IntPtr job,Request request) {
        uint expected=0; string nonce=request.JobName.Substring(21);
        try {
            for(;;) {
                int first=input.ReadByte(); if(first<0)break;
                byte[] tail=ReadExactly(input,3); uint size=(uint)((first<<24)|(tail[0]<<16)|(tail[1]<<8)|tail[2]);
                if(size!=12)throw new InvalidDataException("Invalid bounded native control frame");
                byte[] bytes=ReadExactly(input,12); using(MemoryStream body=new MemoryStream(bytes,false)) {
                    uint operation=ReadNumber(body), sequence=ReadNumber(body), pid=ReadNumber(body);
                    if(sequence!=++expected || expected>request.MaximumControls)throw new InvalidDataException("Invalid native control order");
                    if(operation==2 && pid==0)break;
                    if(operation!=1 || pid==0)throw new InvalidDataException("Invalid native membership request");
                    bool member=Member(job,pid,request.Pids);
                    Frame("{\"protocol\":\""+request.ControlProtocol+"\",\"type\":\"member\",\"nonce\":\""+nonce+"\",\"sequence\":"+sequence+",\"pid\":"+pid+",\"member\":"+(member?"true":"false")+"}");
                }
            }
        } catch {try{Frame("{\"protocol\":\""+request.ControlProtocol+"\",\"type\":\"fault\",\"nonce\":\""+nonce+"\",\"reason\":\"invalid-control-input\"}");}catch{}}
        finally {TerminateJobObject(job,125);CloseHandle(job);}
    }
    private static int Main(string[] arguments) {
        IntPtr job=IntPtr.Zero; ProcessInformation child=new ProcessInformation(); bool assigned=false,resumed=false;
        try {
            ABI(); uint session; string boot=Boot(out session);
            if(arguments.Length==2 && (arguments[0]=="--capabilities-json-v2" || arguments[0]=="--desktop-capabilities-json-v1")) {
                Guid nonce; if(!Guid.TryParseExact(arguments[1],"D",out nonce))throw new InvalidDataException("Invalid ABI probe nonce");
                job=NewJob("Local\\CMBDevClaw-Bot-"+nonce.ToString("D"),512,2147483648UL);
                bool desktopProbe=arguments[0]=="--desktop-capabilities-json-v1";
                Frame("{\"protocol\":\""+(desktopProbe?DesktopProtocol:Protocol)+"\",\"type\":\"capabilities\",\"nonce\":\""+nonce+"\",\"bootId\":\""+boot+"\",\"sessionId\":"+session+",\"pointerSize\":8,\"startupBytes\":104,\"processInformationBytes\":24,\"extendedLimitBytes\":144,\"accountingBytes\":48,\"limitsVerified\":true,\"noBreakaway\":true,\"killOnClose\":true"+(desktopProbe?",\"maximumControls\":4096":"")+"}");
                return 0;
            }
            if(arguments.Length!=1 || (arguments[0]!="--owned-bot-v2" && arguments[0]!="--owned-desktop-v1"))throw new InvalidDataException("Invalid Bot resource entry");
            Request request=ReadRequest(arguments[0]=="--owned-desktop-v1"); if(request.BootId!=boot || request.Session!=session)throw new IOException("Bot resource boot/session changed"); FileInformation identity;
            using(SafeFileHandle directory=PinDirectory(request.Directory,out identity)) {
                job=NewJob(request.JobName,request.Pids,request.Memory);
                Environment.SetEnvironmentVariable("CMB_BOT_RESOURCE_JOB",request.JobName);
                StartupInfo startup=new StartupInfo(); startup.Size=104; startup.Flags=StdHandles;
                // Native stdout is an exclusive bounded protocol. Trusted Node
                // speaks over its existing authenticated control pipe, never here.
                using(SafeFileHandle nul=CreateFile("NUL",0xC0000000,ShareAll,IntPtr.Zero,OpenExisting,0,IntPtr.Zero)) {
                    if(nul.IsInvalid || !SetHandleInformation(nul.DangerousGetHandle(),InheritHandles,InheritHandles))throw WinError("Prepare private native stdio");
                    startup.Input=startup.Output=startup.Error=nul.DangerousGetHandle();
                    StringBuilder line=new StringBuilder(Quote(request.Exe)); foreach(string value in request.Arguments)line.Append(' ').Append(Quote(value));
                    if(line.Length>=32767)throw new InvalidDataException("Bot bootstrap exceeds CreateProcess bound");
                    // CreateProcessW may modify its command line. Supply a
                    // bounded writable UTF-16 buffer including its terminator.
                    char[] command=(line.ToString()+"\0").ToCharArray();
                    if(!CreateProcess(request.Exe,command,IntPtr.Zero,IntPtr.Zero,true,Suspended|NoWindow,IntPtr.Zero,request.Cwd,ref startup,out child))throw WinError("Create suspended Bot owner");
                }
                if(!AssignProcessToJobObject(job,child.Process))throw WinError("Atomically assign Bot owner");assigned=true;
                // Published before ResumeThread. Parent pauses the authenticated
                // Node socket until it consumes and validates this exact frame.
                Frame("{\"protocol\":\""+request.ControlProtocol+"\",\"type\":\"ready\",\"nonce\":\""+request.JobName.Substring(21)+"\",\"helperPid\":"+child.Pid+",\"bootId\":\""+boot+"\",\"sessionId\":"+session+",\"pids\":"+request.Pids+",\"memoryBytes\":"+request.Memory+"}");
                IntPtr readerJob; if(!DuplicateHandle(GetCurrentProcess(),job,GetCurrentProcess(),out readerJob,0,false,2))throw WinError("Pin independent Job control handle");
                try {Thread reader=new Thread(()=>Monitor(Console.OpenStandardInput(),readerJob,request));reader.IsBackground=true;reader.Start();}
                catch {CloseHandle(readerJob);throw;}
                if(ResumeThread(child.Thread)==uint.MaxValue)throw WinError("Resume owned Bot resource");resumed=true;
                uint wait=WaitForSingleObject(child.Process,request.TimeoutMs);
                if(wait!=0 && wait!=258)throw WinError("Wait Bot owner");
                if(!TerminateJobObject(job,125))throw WinError("Close Bot descendants");
                Stopwatch until=Stopwatch.StartNew();Accounting accounting;
                for(;;) {
                    if(!QueryInformationJobObject(job,1,out accounting,48,IntPtr.Zero))throw WinError("Read actual empty Job");
                    if(accounting.ActiveProcesses==0)break;
                    if(until.ElapsedMilliseconds>10000)throw new IOException("Bot Job did not drain");Thread.Sleep(20);
                }
                PublishProof(request,identity);
                uint code;if(!GetExitCodeProcess(child.Process,out code))throw WinError("Read Bot owner result");
                return code>int.MaxValue?125:(int)code;
            }
        } catch(Exception error) {Console.Error.WriteLine("[CMBDevClaw] Native Job failure: "+error.GetType().Name);return 125;}
        finally {
            if(job!=IntPtr.Zero){if(assigned)TerminateJobObject(job,125);CloseHandle(job);}
            if(child.Thread!=IntPtr.Zero)CloseHandle(child.Thread);
            if(child.Process!=IntPtr.Zero){if(!assigned&&!resumed)TerminateProcess(child.Process,125);CloseHandle(child.Process);}
        }
    }
}
