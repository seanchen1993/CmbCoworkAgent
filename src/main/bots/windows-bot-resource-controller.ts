import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import {
  windowsBotJobScope,
  windowsBotOwnerFrame,
  windowsDesktopOwnerFrame,
  WindowsBotOwnerDecoder,
  WINDOWS_DESKTOP_OWNER_MAX_CONTROLS,
  type WindowsBotJobScope
} from "./windows-native-contract"
import {
  encodeWindowsBotResourceRequest,
  encodeWindowsBotResourceControl,
  encodeWindowsDesktopResourceRequest,
  encodeWindowsDesktopResourceControl,
  type WindowsBotResourceRequest
} from "./windows-bot-resource-wire"

export interface WindowsBotResourceExit {
  code: number | null
  signal: NodeJS.Signals | null
}
export interface WindowsBotResourceController {
  child: ChildProcessWithoutNullStreams
  ready: Promise<number>
  exited: Promise<WindowsBotResourceExit>
  verifyMember(pid: number): Promise<void>
  stop(): void
}
/** Shared physical Job control, outside the contained processes. It publishes
 * neither a business result nor closure authority. Only the native producer's
 * pinned durable kernel-empty proof authorizes resource cleanup. No Job handle
 * is inherited by the bootstrap, desktop worker or an application. */
export function startWindowsBotResourceController(input: {
  mode: "shell" | "desktop"
  artifact: { entry: string; sha256: string }
  scope: WindowsBotJobScope
  request: WindowsBotResourceRequest
  environment: NodeJS.ProcessEnv
  failure(error: unknown): void
}): WindowsBotResourceController {
  const scope = windowsBotJobScope.parse(input.scope),
    mode = input.mode
  if (
    scope.providerSha256 !== input.artifact.sha256 ||
    input.request.jobName !== scope.jobName ||
    input.request.bootId !== scope.bootId ||
    input.request.sessionId !== scope.sessionId ||
    input.request.limits.pids !== scope.limits.pids ||
    input.request.limits.memoryBytes !== scope.limits.memoryBytes
  )
    throw new Error("Native resource request differs from owned scope")
  const frameSchema = mode === "desktop" ? windowsDesktopOwnerFrame : windowsBotOwnerFrame
  const maximumControls = mode === "desktop" ? WINDOWS_DESKTOP_OWNER_MAX_CONTROLS : 64
  const encodeControl =
    mode === "desktop" ? encodeWindowsDesktopResourceControl : encodeWindowsBotResourceControl
  const request = (
    mode === "desktop" ? encodeWindowsDesktopResourceRequest : encodeWindowsBotResourceRequest
  )(input.request)
  const child = spawn(
    input.artifact.entry,
    [mode === "desktop" ? "--owned-desktop-v1" : "--owned-bot-v2"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: input.environment
    }
  )
  child.stderr.resume()
  let resolveExited!: (result: WindowsBotResourceExit) => void
  const exited = new Promise<WindowsBotResourceExit>((resolve) => {
    resolveExited = resolve
  })
  let stopRequested = false
  let sequence = 0,
    finished = false,
    isReady = false,
    pending:
      | {
          sequence: number
          pid: number
          resolve(): void
          reject(error: unknown): void
          timer: ReturnType<typeof setTimeout>
        }
      | undefined
  let resolveReady!: (pid: number) => void, rejectReady!: (error: unknown) => void
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  void ready.catch(() => {})
  const fail = (error: unknown) => {
    rejectReady(error)
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      pending = undefined
    }
    if (!finished) {
      finished = true
      child.stdin.destroy()
      input.failure(error)
    }
  }
  const decoder = new WindowsBotOwnerDecoder((raw) => {
    const frame = frameSchema.parse(raw)
    if (frame.nonce !== scope.nonce) throw new Error("Native owner nonce differs")
    if (frame.type === "ready") {
      if (
        isReady ||
        frame.bootId !== scope.bootId ||
        frame.sessionId !== scope.sessionId ||
        frame.pids !== scope.limits.pids ||
        frame.memoryBytes !== scope.limits.memoryBytes
      )
        throw new Error("Native owner scope differs")
      isReady = true
      resolveReady(frame.helperPid)
    } else if (frame.type === "member") {
      if (!isReady || !pending || frame.sequence !== pending.sequence || frame.pid !== pending.pid)
        throw new Error("Native membership order differs")
      const current = pending
      pending = undefined
      clearTimeout(current.timer)
      if (!frame.member) {
        current.reject(new Error("Fixed sandbox probe is outside the owned Job"))
        throw new Error("Native Job membership failed")
      }
      current.resolve()
    } else throw new Error("Native owner control failed")
  }, maximumControls + 1)
  child.stdout.on("data", (bytes) => {
    try {
      decoder.feed(bytes)
    } catch (error) {
      fail(error)
    }
  })
  child.stdout.once("end", () => {
    try {
      decoder.end()
    } catch (error) {
      fail(error)
    }
  })
  child.once("error", fail)
  child.stdin.on("error", fail)
  child.once("close", (code, signal) => {
    resolveExited({ code, signal })
    finished = true
    rejectReady(new Error("Native owner closed before ready"))
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error("Native owner closed before membership proof"))
      pending = undefined
    }
  })
  child.stdin.write(request, (error) => {
    if (error) fail(error)
  })
  return {
    child,
    ready,
    exited,
    verifyMember: async (pid) => {
      await ready
      if (finished || stopRequested || pending || sequence >= maximumControls - 1)
        throw new Error("Native membership verifier is unavailable")
      return new Promise<void>((resolve, reject) => {
        const current = ++sequence
        pending = {
          sequence: current,
          pid,
          resolve,
          reject,
          timer: setTimeout(() => fail(new Error("Native Job membership probe timed out")), 2500)
        }
        child.stdin.write(
          encodeControl({ operation: "member", sequence: current, pid }),
          (error) => {
            if (error) fail(error)
          }
        )
      })
    },
    stop: () => {
      if (finished || stopRequested) return
      stopRequested = true
      child.stdin.end(encodeControl({ operation: "stop", sequence: ++sequence }))
    }
  }
}
