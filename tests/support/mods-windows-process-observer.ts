import { execFile, type ExecFileException } from "node:child_process"
import { join } from "node:path"

export interface ProcessIdentity {
  pid: number
  parent: number
  born: string
}

export interface WindowsProcessQueryDiagnostics {
  pids: number[]
  timeoutMs: number
  code: string | number | null
  signal: string | null
  killed: boolean
  stderr: string
  stdout: string
}

export class WindowsProcessQueryError extends Error {
  constructor(readonly diagnostics: WindowsProcessQueryDiagnostics) {
    super(`MODS_WINDOWS_PROCESS_QUERY_FAILED: ${JSON.stringify(diagnostics)}`)
    this.name = "WindowsProcessQueryError"
  }
}

/** Independent, read-only host observation; never changes or terminates a reported process. */
export async function readWindowsProcessIdentities(pids: number[]): Promise<ProcessIdentity[]> {
  if (
    !pids.length ||
    pids.length > 64 ||
    new Set(pids).size !== pids.length ||
    pids.some((pid) => !Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff)
  ) {
    throw Error("MODS_WINDOWS_PROCESS_QUERY_PIDS_INVALID")
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:/Windows"
  const powershellHome = join(systemRoot, "System32/WindowsPowerShell/v1.0")
  const env = { ...process.env }
  // pwsh 7 module paths must not leak into the Windows PowerShell 5 observer.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key]
  env.PSModulePath = join(powershellHome, "Modules")
  const query =
    "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; " +
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); " +
    "Import-Module (Join-Path $PSHOME 'Modules/CimCmdlets/CimCmdlets.psd1') -ErrorAction Stop; " +
    `Get-CimInstance Win32_Process -Filter '${pids.map((pid) => `ProcessId = ${pid}`).join(" OR ")}' ` +
    "-ErrorAction Stop | Select-Object " +
    "@{Name='pid';Expression={$_.ProcessId}},@{Name='parent';Expression={$_.ParentProcessId}}," +
    "@{Name='born';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} " +
    "| ConvertTo-Json -Compress"
  // This bounds a cold OS observer, not a product action or the overall acceptance deadline.
  const timeoutMs = 30_000
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(
      join(powershellHome, "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(query, "utf16le").toString("base64")
      ],
      { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024, env },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error || stderr.trim()) {
          reject(
            new WindowsProcessQueryError({
              pids: [...pids],
              timeoutMs,
              code: error?.code ?? null,
              signal: error?.signal ?? null,
              killed: error?.killed ?? false,
              stderr: stderr.slice(0, 4096),
              stdout: stdout.slice(0, 4096)
            })
          )
        } else resolve(stdout)
      }
    )
  })
  if (!raw.trim()) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw Error("MODS_WINDOWS_PROCESS_QUERY_OUTPUT_INVALID")
  }
  const rows: unknown[] = Array.isArray(value) ? value : [value]
  const seen = new Set<number>()
  for (const row of rows) {
    if (!row || typeof row !== "object") throw Error("MODS_WINDOWS_PROCESS_QUERY_OUTPUT_INVALID")
    const identity = row as ProcessIdentity
    if (
      !pids.includes(identity.pid) ||
      seen.has(identity.pid) ||
      !Number.isInteger(identity.parent) ||
      identity.parent < 0 ||
      identity.parent > 0xffffffff ||
      typeof identity.born !== "string" ||
      !Number.isFinite(Date.parse(identity.born))
    ) {
      throw Error("MODS_WINDOWS_PROCESS_QUERY_OUTPUT_INVALID")
    }
    seen.add(identity.pid)
  }
  return rows as ProcessIdentity[]
}
