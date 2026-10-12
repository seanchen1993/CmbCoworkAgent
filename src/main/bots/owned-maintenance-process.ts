import { resolveWindowsBackgroundJobControllerPath } from "../agent/windows-background-job-controller-path"

/** Existing Windows controller owns a KILL_ON_JOB_CLOSE Job. Launch a fixed
 * Node bootstrap through its established stdin executable mode, then the
 * maintenance process and Git descendants inherit that Job. No shell/eval of
 * request contents, new binary, WSL, Python, or model-facing process API. */
export function windowsOwnedMaintenanceLaunch(input: {
  executable: string
  args: readonly string[]
  request: unknown
  controller?: string
}) {
  const request = Buffer.from(JSON.stringify(input.request))
  if (
    request.length > 4096 ||
    input.args.length > 16 ||
    input.args.some((argument) => argument.length > 4096 || argument.includes("\0")) ||
    input.executable.length > 4096 ||
    input.executable.includes("\0")
  )
    throw new Error("电脑维护启动参数超出范围")
  const bootstrap = `"use strict";
const { spawn } = require("node:child_process");
const child = spawn(${JSON.stringify(input.executable)}, ${JSON.stringify(["--max-old-space-size=256", ...input.args])}, {
  stdio: ["pipe", "pipe", "inherit"], windowsHide: true, env: process.env
});
child.once("spawn", () => {
  process.stdout.write(JSON.stringify({type:"owner",pid:child.pid}) + "\\n", () => {
    child.stdout.pipe(process.stdout);
    child.stdin.end(Buffer.from(${JSON.stringify(request.toString("base64"))}, "base64"));
  });
});
child.stdin.on("error", () => {});
child.once("error", () => process.exit(126));
child.once("close", code => process.exit(code === 0 ? 0 : 1));
`
  return {
    executable: input.controller ?? resolveWindowsBackgroundJobControllerPath(),
    args: [input.executable, "stdin"],
    stdin: Buffer.from(bootstrap),
    detached: false as const
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { Writable } from "node:stream"
import { botShellEnvironment } from "./shell-contract"

export interface OwnedMaintenanceProcess {
  child: ChildProcessWithoutNullStreams
  terminate(): void
  /** Windows sends the actual Node PID as a first owner frame. The returned
   * child PID belongs to the Job controller; POSIX uses child.pid directly. */
  maintenancePid?: number
}
export function spawnOwnedMaintenanceProcess(
  entryPath: string,
  directory: string
): OwnedMaintenanceProcess {
  const args = [entryPath, "--data-dir", directory],
    windows = process.platform === "win32",
    executable = windows ? resolveWindowsBackgroundJobControllerPath() : process.execPath,
    child = spawn(
      executable,
      windows ? [process.execPath, "stdin"] : ["--max-old-space-size=256", ...args],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: !windows,
        env: { ...botShellEnvironment(process.env), ELECTRON_RUN_AS_NODE: "1" }
      }
    )
  const terminate = () => {
    if (!child.pid) return
    if (windows) {
      child.kill("SIGKILL")
      return
    }
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  if (windows) {
    // Keep one Root input contract. Only this private bounded Writable converts
    // the request bytes into the immutable Node bootstrap expected by the
    // already-shipped controller's stdin executable transport.
    const underlying = child.stdin,
      chunks: Buffer[] = []
    let size = 0
    const input = new Writable({
      write(chunk: Buffer, encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
        size += bytes.length
        if (size > 4096) {
          callback(new Error("电脑维护请求超过 4 KiB"))
          return
        }
        chunks.push(bytes)
        callback()
      },
      final(callback) {
        try {
          const request = JSON.parse(Buffer.concat(chunks).toString()) as unknown
          const launch = windowsOwnedMaintenanceLaunch({
            executable: process.execPath,
            args,
            request,
            controller: executable
          })
          underlying.end(launch.stdin, callback)
        } catch (error) {
          callback(error instanceof Error ? error : new Error("电脑维护请求无效"))
        }
      }
    })
    input.on("error", () => {
      try {
        terminate()
      } catch {
        underlying.destroy()
      }
    })
    underlying.on("error", (error) => input.destroy(error))
    child.stdin = input
  }
  return { child, terminate, maintenancePid: windows ? undefined : child.pid }
}
