import { randomUUID } from "node:crypto"
import type { NativeHostFileEdit } from "./platform-capabilities-types"

interface NativeFileScope {
  workspace: string
  threadId: string
  incarnation: string
  assertCurrent(): void
}
interface Sink {
  capture(workspace: string, threadId: string): NativeFileScope | undefined
  publish(edit: NativeHostFileEdit): void
}
let current: Sink | undefined

/** Main-only registration. This is never reachable through the guest SDK or raw renderer IPC. */
export function registerPlatformFileEditSink(sink: Sink): () => void {
  if (current) throw Error("PLATFORM_FILE_EDIT_SINK_ALREADY_REGISTERED")
  current = sink
  return () => {
    if (current === sink) current = undefined
  }
}

/** Capture the sandbox's original native incarnation once, rather than adopting a recreated chat. */
export function capturePlatformFileEdits(
  workspace: string,
  threadId: string
):
  | {
      prepare(operation: "write_file" | "edit_file", path: string): () => void
    }
  | undefined {
  const sink = current
  if (!sink) return undefined
  let scope: NativeFileScope | undefined
  try {
    scope = sink.capture(workspace, threadId)
  } catch {
    return undefined
  }
  if (!scope) return undefined
  const captured = scope
  return {
    prepare: (operation, path) => {
      const requestId = randomUUID()
      let completed = false
      return () => {
        if (completed) return
        completed = true
        try {
          if (current !== sink) return
          captured.assertCurrent()
          sink.publish({
            workspace: captured.workspace,
            threadId: captured.threadId,
            incarnation: captured.incarnation,
            path,
            operation,
            requestId
          })
        } catch {
          /* Observation failure cannot rewrite an already committed file result. */
        }
      }
    }
  }
}
