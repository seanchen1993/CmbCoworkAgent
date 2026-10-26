import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { createHash } from "node:crypto"
import { observeFunctionProcess } from "./host-call"
import { assertWorkflowResourceAdmission, prepareWorkflowDeadlineProcess,
  workflowResourceDeadlineSignal } from "../../agent/workflow/resource-deadline"
import { resolveWindowsBackgroundJobControllerPath } from "../../agent/windows-background-job-controller-path"
import { ModFunctionError, isModObject } from "../../../shared/mods/v2/contracts"
import {
  activeWorkflowVerificationAccessScope,
  verifyWorkflowVerificationCurrent
} from "../../agent/workflow/worktree-action-scope"
import type { ModObject } from "../../../shared/mods/types"

const OUTPUT_LIMIT = 256 * 1024
const QUEUE_LIMIT = 1024 * 1024
const READY = Buffer.from("MODS_PROCESS_STARTED_V1\n")
const BASE_ENV = new Set([
  "path",
  "systemroot",
  "windir",
  "comspec",
  "pathext",
  "temp",
  "tmp",
  "tmpdir",
  "home",
  "userprofile",
  "homedrive",
  "homepath",
  "lang",
  "lc_all",
  "lc_ctype"
])

function failure(code: string): ModFunctionError {
  return new ModFunctionError(code)
}

export interface FunctionProcessRequest {
  argv: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  input?: string
  timeoutMs?: number
}

export interface FunctionProcessContext {
  cwd: string
  signal: AbortSignal
  assertLive(): void
  authorize(request: Readonly<FunctionProcessRequest>, signal: AbortSignal): Promise<void>
  publish(value: ModObject, signal: AbortSignal): Promise<ModObject>
}

export interface FunctionProcessStream {
  stream: AsyncGenerator<ModObject, ModObject>
  started: Promise<void>
  result: Promise<ModObject>
  close(): Promise<void>
}

/** Processes have explicit host-command authority, not the SDK file API's path confinement. */
export async function functionProcessRequest(
  input: ModObject,
  cwd: string,
  streaming: boolean
): Promise<Readonly<FunctionProcessRequest>> {
  const init = input.init === undefined ? {} : input.init
  if (
    Object.keys(input).some((key) => !["argv", "init"].includes(key)) ||
    !Array.isArray(input.argv) ||
    input.argv.length < 1 ||
    input.argv.length > 256 ||
    !input.argv.every((item) => typeof item === "string" && !item.includes("\0")) ||
    !input.argv[0] ||
    !isModObject(init)
  )
    throw failure("MODS_PROCESS_ARGUMENTS")
  const argv = input.argv as string[]
  if (argv.reduce((total, item) => total + Buffer.byteLength(item), 0) > 64 * 1024)
    throw failure("MODS_PROCESS_ARGUMENTS_LIMIT")
  const inputKey = streaming ? "input" : "stdin"
  if (
    Object.keys(init).some(
      (key) => !["cwd", "env", inputKey, ...(streaming ? [] : ["timeoutMs"])].includes(key)
    )
  )
    throw failure("MODS_PROCESS_ARGUMENTS")
  if (init.cwd !== undefined && (typeof init.cwd !== "string" || init.cwd.includes("\0")))
    throw failure("MODS_PROCESS_CWD")
  const directory = await realpath(path.resolve(cwd, (init.cwd as string | undefined) ?? "."))
  if (!(await stat(directory)).isDirectory()) throw failure("MODS_PROCESS_CWD")
  const stdin = init[inputKey]
  if (stdin !== undefined && (typeof stdin !== "string" || Buffer.byteLength(stdin) > 512 * 1024))
    throw failure("MODS_PROCESS_INPUT_LIMIT")
  if (init.env !== undefined && !isModObject(init.env)) throw failure("MODS_PROCESS_ENV")
  const env: Record<string, string> = Object.create(null)
  let envBytes = 0
  if (Object.keys(init.env ?? {}).length > 128) throw failure("MODS_PROCESS_ENV")
  for (const [key, value] of Object.entries(init.env ?? {})) {
    if (
      !key ||
      /[=\0]/.test(key) ||
      typeof value !== "string" ||
      value.includes("\0") ||
      (envBytes += Buffer.byteLength(key) + Buffer.byteLength(value)) > 32 * 1024
    )
      throw failure("MODS_PROCESS_ENV")
    if (
      process.platform === "win32" &&
      Object.keys(env).some((name) => name.toLowerCase() === key.toLowerCase())
    )
      throw failure("MODS_PROCESS_ENV")
    env[key] = value
  }
  const timeoutMs = streaming ? undefined : (init.timeoutMs ?? 30_000)
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 600_000)
  )
    throw failure("MODS_PROCESS_TIMEOUT_ARGUMENT")
  return Object.freeze({
    argv: Object.freeze([...argv]),
    cwd: directory,
    env: Object.freeze(env),
    ...(stdin === undefined ? {} : { input: stdin as string }),
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number })
  })
}

function environment(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null)
  for (const [key, value] of Object.entries(process.env))
    if (BASE_ENV.has(key.toLowerCase()) && value !== undefined) env[key] = value
  for (const [key, value] of Object.entries(overrides)) {
    if (process.platform === "win32")
      for (const name of Object.keys(env))
        if (name.toLowerCase() === key.toLowerCase()) delete env[name]
    env[key] = value
  }
  return env
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {})
    signal.throwIfAborted()
  }
  let cancel!: () => void
  const abort = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason ?? failure("MODS_CANCELLED"))
    signal.addEventListener("abort", cancel, { once: true })
  })
  try {
    return await Promise.race([promise, abort])
  } finally {
    signal.removeEventListener("abort", cancel)
  }
}

function active(context: FunctionProcessContext, signal: AbortSignal): void {
  signal.throwIfAborted()
  context.assertLive()
  assertWorkflowResourceAdmission()
}

function internalWaitMilliseconds(input: ModObject, request: FunctionProcessRequest): number | undefined {
  const init = input.init
  if (init !== undefined && (!isModObject(init) ||
    Object.keys(init).some(key => key !== "cwd" && key !== "timeoutMs"))) return undefined
  if (request.argv.length !== 2 || request.argv[0] !== "sleep" ||
    !/^\d+(?:\.\d+)?$/.test(request.argv[1])) return undefined
  const seconds = Number(request.argv[1])
  if (!Number.isFinite(seconds)) return undefined
  // A longer wait always meets the existing (at most 600s) operation timeout first.
  // Clamp before handing it to Node so large finite decimal inputs never overflow to 1ms.
  return Math.min(seconds * 1000, 2_147_483_647)
}

interface RunningProcess {
  started: Promise<void>
  next(): Promise<IteratorResult<ModObject, ModObject>>
  close(): Promise<void>
}

function launch(
  request: FunctionProcessRequest,
  context: FunctionProcessContext,
  signal: AbortSignal
): RunningProcess {
  active(context, signal)
  const windows = process.platform === "win32"
  const child: ChildProcessWithoutNullStreams = spawn(
    windows ? resolveWindowsBackgroundJobControllerPath() : request.argv[0],
    windows
      ? [request.argv[0], "argv", String(process.pid), ...request.argv.slice(1)]
      : request.argv.slice(1),
    {
      cwd: request.cwd,
      env: environment(request.env),
      shell: false,
      windowsHide: true,
      detached: !windows,
      stdio: "pipe"
    }
  )
  const queue: ModObject[] = []
  let queuedBytes = 0
  let ready = !windows
  let prefix = Buffer.alloc(0)
  let pendingStderr: Buffer | undefined
  let stderrEnded = false
  let error: unknown
  let ended: ModObject | undefined
  let wake: (() => void) | undefined
  let closed = false
  let closing: Promise<void> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let resolveStarted!: () => void
  let rejectStarted!: (error: unknown) => void
  const started = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve
    rejectStarted = reject
  })
  void started.catch(() => {})
  const notify = () => {
    wake?.()
    wake = undefined
  }
  const kill = () => {
    if (!child.pid) return
    if (windows) {
      child.kill()
      return
    } // Closing controller also closes its Job handle.
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {
      /* Already exited. */
    }
    killTimer ??= setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {
        /* Group already exited. */
      }
    }, 100)
  }
  const stop = (reason: unknown) => {
    error ??= reason
    rejectStarted(error)
    queue.length = 0
    queuedBytes = 0
    child.stdout.resume()
    child.stderr.resume()
    kill()
    notify()
  }
  const cancel = () => stop(signal.reason ?? failure("MODS_CANCELLED"))
  signal.addEventListener("abort", cancel, { once: true })
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }
  const pushText = (stream: "stdout" | "stderr", text: string) => {
    if (error) return
    // 8K UTF16 units is at most 32KiB UTF8. Preserve surrogate pairs across queue chunks.
    for (let offset = 0; offset < text.length; ) {
      let end = Math.min(offset + 8192, text.length)
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
      const chunk = text.slice(offset, end)
      queue.push({ stream, text: chunk })
      queuedBytes += Buffer.byteLength(chunk)
      if (queuedBytes > QUEUE_LIMIT + 128 * 1024) {
        stop(failure("MODS_PROCESS_BACKPRESSURE_LIMIT"))
        return
      }
      offset = end
    }
    if (queuedBytes >= QUEUE_LIMIT) {
      child.stdout.pause()
      child.stderr.pause()
    }
    notify()
  }
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream].on("data", (original: Buffer) => {
      if (error) return
      try {
        active(context, signal)
      } catch (reason) {
        stop(reason)
        return
      }
      let chunk = original
      if (windows && stream === "stderr" && !ready) {
        // A failed controller must reject the first pull, not yield startup diagnostics first.
        pendingStderr = chunk
        child.stderr.pause()
        return
      }
      if (windows && stream === "stdout" && !ready) {
        prefix = Buffer.concat([prefix, chunk])
        if (prefix.length < READY.length) return
        if (!prefix.subarray(0, READY.length).equals(READY)) {
          stop(failure("MODS_PROCESS_START"))
          return
        }
        ready = true
        resolveStarted()
        if (pendingStderr) {
          pushText("stderr", decoders.stderr.write(pendingStderr))
          pendingStderr = undefined
          if (stderrEnded) pushText("stderr", decoders.stderr.end())
        }
        child.stderr.resume()
        chunk = prefix.subarray(READY.length)
        prefix = Buffer.alloc(0)
      }
      pushText(stream, decoders[stream].write(chunk))
    })
    child[stream].once("end", () => {
      if (stream === "stderr") stderrEnded = true
      if (ready) pushText(stream, decoders[stream].end())
    })
    child[stream].once("error", () => stop(failure("MODS_PROCESS_IO")))
  }
  child.stdin.on("error", () => {
    /* A child may intentionally close stdin before consuming it. */
  })
  child.once("error", () => stop(failure("MODS_PROCESS_START")))
  child.once("spawn", () => {
    if (!windows) resolveStarted()
  })
  child.once("exit", () => {
    if (!windows) kill()
  })
  const completion = new Promise<void>((resolve) =>
    child.once("close", (code, exitSignal) => {
      closed = true
      if (!ready) {
        error ??= failure("MODS_PROCESS_START")
        rejectStarted(error)
      }
      ended = { code, signal: exitSignal }
      // Reap Unix descendants even if the direct child exited normally first.
      if (!windows) kill()
      signal.removeEventListener("abort", cancel)
      notify()
      resolve()
    })
  )
  child.stdin.end(request.input)
  if (signal.aborted) cancel()
  return {
    started,
    async next() {
      while (true) {
        active(context, signal)
        if (error) throw error
        const value = queue.shift()
        if (value) {
          queuedBytes -= Buffer.byteLength(value.text as string)
          if (queuedBytes < QUEUE_LIMIT / 2) {
            child.stdout.resume()
            child.stderr.resume()
          }
          return { done: false, value }
        }
        if (ended) return { done: true, value: ended }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    },
    close() {
      return (closing ??= (async () => {
        if (!closed) stop(failure("MODS_PROCESS_CLOSED"))
        await completion
        // Keep the short escalation alive until descendants are killed, including detached daemons.
        if (killTimer) await new Promise<void>((resolve) => setTimeout(resolve, 110))
      })())
    }
  }
}

export class FunctionProcessHost {
  spawn(input: ModObject, context: FunctionProcessContext): FunctionProcessStream {
    const controller = new AbortController()
    const signal = AbortSignal.any([context.signal, controller.signal,
      ...(workflowResourceDeadlineSignal() ? [workflowResourceDeadlineSignal()!] : [])])
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    let running: RunningProcess | undefined
    let resolveResult!: (value: ModObject) => void
    let rejectResult!: (reason: unknown) => void
    let settled = false
    let resolveStarted!: () => void
    let rejectStarted!: (reason: unknown) => void
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve
      rejectStarted = reject
    })
    void started.catch(() => {})
    const result = new Promise<ModObject>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    void result.catch(() => {})
    const settle = (value?: ModObject, error?: unknown) => {
      if (settled) return
      settled = true
      if (value) resolveResult(value)
      else {
        const reason = error ?? failure("MODS_PROCESS_CLOSED")
        rejectResult(reason)
        rejectStarted(reason)
      }
    }
    const iterator = (async function* (): AsyncGenerator<ModObject, ModObject> {
      try {
        active(context, signal)
        const request = await functionProcessRequest(input, context.cwd, true)
        active(context, signal)
        await abortable(context.authorize(request, signal), signal)
        if (activeWorkflowVerificationAccessScope() !== undefined)
          await abortable(verifyWorkflowVerificationCurrent(), signal)
        active(context, signal)
        const deadline = await prepareWorkflowDeadlineProcess(request.argv)
        active(context, signal)
        if (deadline) deadlineTimer = setTimeout(() => controller.abort(failure("MODS_PROCESS_TIMEOUT")), deadline.timeoutMs)
        running = launch(request, context, signal)
        const admitted = running.started.then(async () => {
          await deadline?.started()
          resolveStarted()
        })
        void admitted.catch(rejectStarted)
        while (true) {
          const next = await running.next()
          if (next.done) {
            await admitted
            await deadline?.finished((next.value.code as number | null) ?? 1)
          }
          active(context, signal)
          const value = await abortable(context.publish(next.value, signal), signal)
          active(context, signal)
          if (Buffer.byteLength(JSON.stringify(value)) > 900_000)
            throw failure("MODS_PROCESS_OUTPUT_LIMIT")
          if (next.done) {
            await running.close()
            active(context, signal)
            settle(value)
            return value
          }
          yield value
        }
      } catch (error) {
        settle(undefined, error)
        throw error
      } finally {
        clearTimeout(deadlineTimer)
        await running?.close()
        settle()
      }
    })()
    const originalReturn = iterator.return.bind(iterator)
    const originalThrow = iterator.throw.bind(iterator)
    iterator.return = async (value) => {
      controller.abort(failure("MODS_PROCESS_CLOSED"))
      settle()
      await running?.close()
      return originalReturn(value)
    }
    iterator.throw = async (error) => {
      controller.abort(error)
      settle(undefined, error)
      await running?.close()
      return originalThrow(error)
    }
    return {
      stream: iterator,
      started,
      result,
      close: async () => {
        await iterator.return({ code: null, signal: null })
      }
    }
  }

  async run(input: ModObject, context: FunctionProcessContext): Promise<ModObject> {
    observeFunctionProcess("preparing")
    if (workflowResourceDeadlineSignal()) context = { ...context,
      signal: AbortSignal.any([context.signal, workflowResourceDeadlineSignal()!]) }
    active(context, context.signal)
    const request = await functionProcessRequest(input, context.cwd, false)
    observeFunctionProcess(
      "prepared",
      createHash("sha256").update(JSON.stringify(request)).digest("hex")
    )
    active(context, context.signal)
    const waitMs = internalWaitMilliseconds(input, request)
    if (waitMs === undefined) {
      observeFunctionProcess("authorizing")
      await abortable(context.authorize(request, context.signal), context.signal)
      observeFunctionProcess("authorized")
    }
    if (waitMs === undefined && activeWorkflowVerificationAccessScope() !== undefined)
      await abortable(verifyWorkflowVerificationCurrent(), context.signal)
    active(context, context.signal)
    const deadline = waitMs === undefined ? await prepareWorkflowDeadlineProcess(request.argv) : undefined
    active(context, context.signal)
    const controller = new AbortController()
    const signal = AbortSignal.any([context.signal, controller.signal])
    const timer = setTimeout(
      () => controller.abort(failure("MODS_PROCESS_TIMEOUT")),
      Math.min(request.timeoutMs!, deadline?.timeoutMs ?? Infinity)
    )
    let running: RunningProcess | undefined
    let waitTimer: ReturnType<typeof setTimeout> | undefined
    let closeObserved = false
    try {
      if (waitMs !== undefined) {
        await abortable(new Promise<void>(resolve => {
          waitTimer = setTimeout(resolve, waitMs)
        }), signal)
        active(context, signal)
        const value = await abortable(context.publish({ exitCode: 0, stdout: "", stderr: "" }, signal), signal)
        active(context, signal)
        if (Buffer.byteLength(JSON.stringify(value)) > 900_000)
          throw failure("MODS_PROCESS_OUTPUT_LIMIT")
        return value
      }
      // Persist dispatch before spawn. Missing READY never proves that no child ran.
      observeFunctionProcess("spawn-dispatched")
      running = launch(request, context, signal)
      const admitted = running.started.then(() => {
        observeFunctionProcess("started")
        return deadline?.started()
      })
      void admitted.catch(() => {})
      const outputs = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
      while (true) {
        const next = await running.next()
        if (next.done) {
          await running.close()
          observeFunctionProcess("closed")
          closeObserved = true
          await admitted
          await deadline?.finished((next.value.code as number | null) ?? 1)
          active(context, signal)
          const value = {
            exitCode: next.value.code ?? 1,
            stdout: new StringDecoder("utf8").write(outputs.stdout),
            stderr: new StringDecoder("utf8").write(outputs.stderr)
          }
          if (Buffer.byteLength(JSON.stringify(value)) > 900_000)
            throw failure("MODS_PROCESS_OUTPUT_LIMIT")
          observeFunctionProcess("publishing")
          const published = await abortable(context.publish(value, signal), signal)
          observeFunctionProcess("published")
          active(context, signal)
          if (Buffer.byteLength(JSON.stringify(published)) > 900_000)
            throw failure("MODS_PROCESS_OUTPUT_LIMIT")
          return published
        }
        const stream = next.value.stream as "stdout" | "stderr"
        const bytes = Buffer.from(next.value.text as string)
        if (outputs[stream].length < OUTPUT_LIMIT)
          outputs[stream] = Buffer.concat([
            outputs[stream],
            bytes.subarray(0, OUTPUT_LIMIT - outputs[stream].length)
          ])
      }
    } finally {
      clearTimeout(timer)
      clearTimeout(waitTimer)
      await running?.close()
      if (running && !closeObserved) observeFunctionProcess("closed")
    }
  }
}
