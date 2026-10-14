import { spawn } from "node:child_process"
import { dirname, isAbsolute, resolve } from "node:path"
import { createInterface } from "node:readline"

// Fixed host code only. All paths/content digests travel as JSON over private stdin,
// never through PowerShell interpolation. The child owns handles until its process exits.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PublicationHandles {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetFileInformationByHandle(IntPtr handle, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetFileInformationByHandle(IntPtr handle, int kind, IntPtr info, uint bytes);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetFinalPathNameByHandleW(IntPtr handle, System.Text.StringBuilder path, uint length, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  public static IntPtr Open(string path, bool directory, bool movable) {
    uint access = directory ? 0x80u : (0x80000000u | (movable ? 0x10000u : 0u));
    // Directories cannot be renamed/replaced. Files deny writers and other renamers.
    IntPtr h = CreateFileW(path, access, directory ? 3u : 1u, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (h == new IntPtr(-1)) throw new IOException("LOCK_UNAVAILABLE", Marshal.GetLastWin32Error());
    Info info;
    if (!GetFileInformationByHandle(h, out info) || (info.Attributes & 0x400) != 0 ||
        (((info.Attributes & 0x10) != 0) != directory) || (!directory && info.Links != 1)) {
      CloseHandle(h); throw new IOException("LOCK_IDENTITY");
    }
    return h;
  }
  public static string Hash(IntPtr handle) {
    using (var borrowed = new SafeFileHandle(handle, false))
    using (var stream = new FileStream(borrowed, FileAccess.Read)) {
      if (stream.Length > 4 * 1024 * 1024) throw new IOException("FILE_LIMIT");
      using (var sha = System.Security.Cryptography.SHA256.Create())
        return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
  }
  public static void Move(IntPtr handle, string destination) {
    // FILE_RENAME_INFO, native pointer alignment. ReplaceIfExists is explicitly false.
    byte[] name = System.Text.Encoding.Unicode.GetBytes(destination);
    int rootOffset = IntPtr.Size == 8 ? 8 : 4;
    int lengthOffset = rootOffset + IntPtr.Size;
    int nameOffset = lengthOffset + 4;
    // The Win32 DOS-path conversion also requires a trailing UTF-16 NUL. Allocate
    // and zero it even though FileNameLength counts only the meaningful name bytes.
    int bufferLength = nameOffset + name.Length + 2;
    IntPtr buffer = Marshal.AllocHGlobal(bufferLength);
    try {
      for (int i = 0; i < bufferLength; i++) Marshal.WriteByte(buffer, i, 0);
      Marshal.WriteIntPtr(buffer, rootOffset, IntPtr.Zero);
      Marshal.WriteInt32(buffer, lengthOffset, name.Length);
      Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
      if (!SetFileInformationByHandle(handle, 3, buffer, (uint)bufferLength))
        throw new IOException("MOVE_FAILED", Marshal.GetLastWin32Error());
      var path = new System.Text.StringBuilder(32768);
      uint length = GetFinalPathNameByHandleW(handle, path, 32768, 0);
      if (length == 0 || length >= 32768) throw new IOException("MOVE_UNCONFIRMED");
      string actual = path.ToString();
      if (actual.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) actual = @"\\" + actual.Substring(8);
      else if (actual.StartsWith(@"\\?\", StringComparison.Ordinal)) actual = actual.Substring(4);
      if (!String.Equals(actual, destination, StringComparison.OrdinalIgnoreCase)) throw new IOException("MOVE_UNCONFIRMED");
    } finally { Marshal.FreeHGlobal(buffer); }
  }
}
'@
$handles = New-Object 'System.Collections.Generic.List[IntPtr]'
$files = New-Object 'System.Collections.Generic.List[IntPtr]'
try {
  $request = [Console]::ReadLine() | ConvertFrom-Json
  foreach ($directory in $request.directories) {
    $handle = [PublicationHandles]::Open([string]$directory, $true, $false)
    $handles.Add($handle)
  }
  foreach ($file in $request.files) {
    $handle = [PublicationHandles]::Open([string]$file.path, $false, [bool]$file.backup)
    $handles.Add($handle); $files.Add($handle)
    if ([PublicationHandles]::Hash($handle) -ne [string]$file.digest) { throw 'SOURCE_CONFLICT' }
  }
  [Console]::WriteLine('{"ready":true}')
  while ($null -ne ($line = [Console]::ReadLine())) {
    $command = $line | ConvertFrom-Json
    if ($command.op -eq 'close') { break }
    $index = [int]$command.index
    if ($command.op -eq 'directory') {
      if ($index -lt 0 -or $index -ge $request.createdDirectories.Count) { throw 'COMMAND_INVALID' }
      $handle = [PublicationHandles]::Open([string]$request.createdDirectories[$index], $true, $false)
      $handles.Add($handle)
      [Console]::WriteLine('{"locked":true}')
      continue
    }
    if ($command.op -eq 'published') {
      if ($index -lt 0 -or $index -ge $request.publishedFiles.Count) { throw 'COMMAND_INVALID' }
      $file = $request.publishedFiles[$index]
      $handle = [PublicationHandles]::Open([string]$file.path, $false, $false)
      $handles.Add($handle)
      if ([PublicationHandles]::Hash($handle) -ne [string]$file.digest) { throw 'PUBLISHED_CHANGED' }
      [Console]::WriteLine('{"locked":true}')
      continue
    }
    if ($command.op -ne 'backup' -or $index -lt 0 -or $index -ge $files.Count -or !$request.files[$index].backup) { throw 'COMMAND_INVALID' }
    [PublicationHandles]::Move($files[$index], [string]$request.files[$index].backup)
    [Console]::WriteLine('{"moved":true}')
  }
} catch {
  [Console]::WriteLine('{"error":"VIRTUAL_PUBLICATION_LOCK_FAILED"}')
  exit 1
} finally {
  foreach ($handle in $handles) { [void][PublicationHandles]::CloseHandle($handle) }
}
`

/** Windows handle sharing enforces local directory identity and excludes file writers.
 * This is NOT a global directory-entry transaction: new names can still appear and
 * exclusive destination creation plus final bounded observation must detect them.
 */
export async function acquireWindowsPublicationLease(input: {
  directories: readonly string[]
  files: readonly { path: string; digest: string; backup?: string }[]
  createdDirectories?: readonly string[]
  publishedFiles?: readonly { path: string; digest: string }[]
  signal: AbortSignal
  assertCurrent(): void
}) {
  if (process.platform !== "win32") throw Error("VIRTUAL_PUBLICATION_PLATFORM_UNSUPPORTED")
  const { signal, assertCurrent } = input
  const directories = [...input.directories].map((path) => resolve(path))
  const files = input.files.map((file) => ({ ...file }))
  const createdDirectories = [...(input.createdDirectories ?? [])].map((path) => resolve(path))
  const publishedFiles = (input.publishedFiles ?? []).map((file) => ({ ...file }))
  if (
    directories.length > 4096 ||
    createdDirectories.length > 2048 ||
    files.length > 2048 ||
    publishedFiles.length > 2048 ||
    publishedFiles.some((file) => !isAbsolute(file.path) || !/^[0-9a-f]{64}$/.test(file.digest)) ||
    files.some(
      (file) =>
        !isAbsolute(file.path) ||
        !/^[0-9a-f]{64}$/.test(file.digest) ||
        (file.backup && !isAbsolute(file.backup))
    )
  )
    throw Error("VIRTUAL_PUBLICATION_LOCK_INPUT")
  const guard = () => {
    signal.throwIfAborted()
    assertCurrent()
    signal.throwIfAborted()
  }
  guard()
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(SCRIPT, "utf16le").toString("base64")
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
  )
  let rejectPending: ((error: unknown) => void) | undefined
  let resolvePending: ((value: unknown) => void) | undefined
  let closing = false
  let dead = false
  let failure: unknown
  let stderrBytes = 0
  const closed = new Promise<void>((done) => {
    child.once("error", (error) => {
      failure = error
      rejectPending?.(error)
    })
    child.once("close", (code) => {
      dead = true
      if (code !== 0 || !closing) failure ??= Error("VIRTUAL_PUBLICATION_LOCK_FAILED")
      rejectPending?.(failure ?? Error("VIRTUAL_PUBLICATION_LOCK_CLOSED"))
      done()
    })
  })
  const reader = createInterface({ input: child.stdout })
  reader.on("line", (line) => {
    if (line.length > 1024) {
      failure = Error("VIRTUAL_PUBLICATION_LOCK_PROTOCOL")
      child.kill()
      return
    }
    try {
      const value = JSON.parse(line)
      if (value.error) throw Error("VIRTUAL_PUBLICATION_LOCK_FAILED")
      if (!resolvePending) throw Error("VIRTUAL_PUBLICATION_LOCK_PROTOCOL")
      const done = resolvePending
      resolvePending = undefined
      rejectPending = undefined
      done(value)
    } catch (error) {
      failure = error
      rejectPending?.(error)
      child.kill()
    }
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength
    if (stderrBytes > 8192) {
      failure = Error("VIRTUAL_PUBLICATION_LOCK_PROTOCOL")
      child.kill()
    }
  })
  const onAbort = () => {
    failure = signal.reason ?? Error("VIRTUAL_PUBLICATION_CANCELLED")
    child.kill()
  }
  signal.addEventListener("abort", onAbort, { once: true })
  let closePromise: Promise<void> | undefined
  const assertAlive = () => {
    if (
      failure ||
      dead ||
      closing ||
      child.killed ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      throw failure ?? Error("VIRTUAL_PUBLICATION_LOCK_CLOSED")
  }
  const close = () =>
    (closePromise ??= (async () => {
      if (dead || child.killed || child.exitCode !== null || child.signalCode !== null)
        failure ??= Error("VIRTUAL_PUBLICATION_LOCK_CLOSED")
      closing = true
      // EOF requests normal release. A wedged helper is terminated after a bounded grace,
      // but ownership is retained until its actual close event confirms handles are gone.
      const timer = setTimeout(() => {
        failure ??= Error("VIRTUAL_PUBLICATION_LOCK_CLOSE_TIMEOUT")
        child.kill()
      }, 1000)
      child.stdin.end()
      try {
        await closed
      } finally {
        clearTimeout(timer)
        reader.close()
        signal.removeEventListener("abort", onAbort)
      }
      if (failure) throw failure
    })())
  const request = (value: unknown) => {
    if (failure || closing || dead || child.killed || resolvePending)
      return Promise.reject(failure ?? Error("VIRTUAL_PUBLICATION_LOCK_STATE"))
    const response = new Promise<unknown>((done, fail) => {
      resolvePending = done
      rejectPending = fail
    })
    child.stdin.write(JSON.stringify(value) + "\n", (error) => {
      if (error) {
        failure = error
        rejectPending?.(error)
        child.kill()
      }
    })
    return response
  }
  try {
    if (signal.aborted) onAbort()
    const ready = (await request({ directories, files, createdDirectories, publishedFiles })) as {
      ready?: boolean
    }
    guard()
    if (!ready.ready) throw Error("VIRTUAL_PUBLICATION_LOCK_PROTOCOL")
    assertAlive()
    return Object.freeze({
      assertAlive,
      async backup(index: number) {
        guard()
        assertAlive()
        if (!Number.isSafeInteger(index) || !files[index]?.backup)
          throw Error("VIRTUAL_PUBLICATION_LOCK_INPUT")
        const value = (await request({ op: "backup", index })) as { moved?: boolean }
        guard()
        assertAlive()
        if (!value.moved) throw Error("VIRTUAL_PUBLICATION_LOCK_PROTOCOL")
      },
      async lockCreatedDirectory(index: number) {
        guard()
        assertAlive()
        if (!Number.isSafeInteger(index) || !createdDirectories[index])
          throw Error("VIRTUAL_PUBLICATION_LOCK_INPUT")
        const value = (await request({ op: "directory", index })) as { locked?: boolean }
        guard()
        assertAlive()
        if (!value.locked) throw Error("VIRTUAL_PUBLICATION_LOCK_PROTOCOL")
      },
      async lockPublishedFile(index: number) {
        guard()
        assertAlive()
        if (!Number.isSafeInteger(index) || !publishedFiles[index])
          throw Error("VIRTUAL_PUBLICATION_LOCK_INPUT")
        const value = (await request({ op: "published", index })) as { locked?: boolean }
        guard()
        assertAlive()
        if (!value.locked) throw Error("VIRTUAL_PUBLICATION_LOCK_PROTOCOL")
      },
      close
    })
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}

export function publicationDirectoryAncestors(paths: readonly string[]): string[] {
  const result = new Set<string>()
  for (const path of paths) {
    let current = resolve(path)
    while (!result.has(current)) {
      result.add(current)
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return [...result].sort((a, b) => a.length - b.length || a.localeCompare(b))
}
