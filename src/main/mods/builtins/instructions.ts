import type {
  BuiltinInstructionsFinalObservation,
  BuiltinInstructionsReadResult,
  BuiltinInstructionsSnapshot
} from "../../../shared/mods/builtin-instructions"

export interface InstructionScope {
  threadId: string
  workspace: string
  /** Resolved by the host; never accept this as renderer authority. */
  incarnationKey: string
}

interface StoredInstructions {
  scope: InstructionScope
  runId: string
  sequence: number
  snapshot?: BuiltinInstructionsSnapshot
}

function pathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function sameScope(a: InstructionScope, b: InstructionScope): boolean {
  return (
    a.threadId === b.threadId &&
    a.incarnationKey === b.incarnationKey &&
    pathKey(a.workspace) === pathKey(b.workspace)
  )
}

/** Session-local observations. Eviction/restart intentionally returns unknown, never rediscovery. */
export class BuiltinInstructionsStore {
  private records = new Map<string, StoredInstructions>()
  private sequence = 0

  constructor(private readonly capacity = 128) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw Error("Invalid instructions capacity")
  }

  /** Call synchronously when the host admits a run, before asynchronous context loading. */
  begin(scope: InstructionScope, runId: string): number {
    const current = this.records.get(scope.threadId)
    if (current && sameScope(current.scope, scope) && current.runId === runId) {
      return current.sequence
    }
    const sequence = ++this.sequence
    this.records.delete(scope.threadId)
    this.records.set(scope.threadId, { scope: { ...scope }, runId, sequence })
    while (this.records.size > this.capacity) {
      this.records.delete(this.records.keys().next().value!)
    }
    return sequence
  }

  capture(
    scope: InstructionScope,
    sequence: number,
    snapshot: BuiltinInstructionsSnapshot
  ): boolean {
    const current = this.records.get(scope.threadId)
    if (
      !current ||
      current.snapshot ||
      !sameScope(current.scope, scope) ||
      current.sequence !== sequence ||
      current.runId !== snapshot.runId ||
      snapshot.threadId !== scope.threadId ||
      pathKey(snapshot.workspace) !== pathKey(scope.workspace)
    )
      return false
    // Only metadata is retained: no instruction bodies, credentials or prompt previews.
    current.snapshot = structuredClone({
      ...snapshot,
      entries: snapshot.entries.slice(0, 512),
      limitations: [
        ...snapshot.limitations,
        ...(snapshot.entries.length > 512 ? ["仅保留前 512 项规范来源。"] : [])
      ]
    })
    return true
  }

  read(scope: InstructionScope): BuiltinInstructionsReadResult {
    const current = this.records.get(scope.threadId)
    if (!current || !sameScope(current.scope, scope) || !current.snapshot) {
      return { status: "unknown", message: "当前聊天尚无可用的本次宿主加载记录；未重新扫描文件。" }
    }
    return {
      status: current.snapshot.status,
      snapshot: structuredClone(current.snapshot),
      message: "记录宿主装配时的规范来源，不代表模型已经执行或后续提示处理保持原文。"
    }
  }

  currentSequence(scope: InstructionScope): number | undefined {
    const current = this.records.get(scope.threadId)
    return current && sameScope(current.scope, scope) ? current.sequence : undefined
  }

  captureChild(
    scope: InstructionScope,
    sequence: number,
    snapshot: BuiltinInstructionsSnapshot
  ): boolean {
    const current = this.records.get(scope.threadId)
    if (
      !current?.snapshot ||
      !sameScope(current.scope, scope) ||
      current.sequence !== sequence ||
      !snapshot.agentId ||
      !snapshot.childSource
    )
      return false
    const children = current.snapshot.children ?? []
    if (children.some((child) => child.runId === snapshot.runId)) return false
    current.snapshot.children = [
      ...children,
      structuredClone({
        ...snapshot,
        entries: snapshot.entries.slice(0, 128),
        children: undefined,
        finalRequests: []
      })
    ].slice(-32)
    return true
  }

  observeChildFinal(
    scope: InstructionScope,
    sequence: number,
    runId: string,
    observation: BuiltinInstructionsFinalObservation
  ): boolean {
    const current = this.records.get(scope.threadId)
    if (!current?.snapshot || !sameScope(current.scope, scope) || current.sequence !== sequence)
      return false
    const child = current.snapshot.children?.find((item) => item.runId === runId)
    if (
      !child ||
      !observation.requestId ||
      child.finalRequests?.some((item) => item.requestId === observation.requestId)
    )
      return false
    child.finalRequests = [...(child.finalRequests ?? []), structuredClone(observation)].slice(-16)
    return true
  }

  /** A host-confirmed model request is separate from the immutable assembly observation. */
  observeFinal(
    scope: InstructionScope,
    sequence: number,
    runId: string,
    observation: BuiltinInstructionsFinalObservation
  ): boolean {
    const current = this.records.get(scope.threadId)
    if (
      !current?.snapshot ||
      !sameScope(current.scope, scope) ||
      current.sequence !== sequence ||
      current.runId !== runId ||
      !observation.requestId
    )
      return false
    const previous = current.snapshot.finalRequests ?? []
    if (previous.some((item) => item.requestId === observation.requestId)) return false
    current.snapshot.finalRequests = [...previous, structuredClone(observation)].slice(-32)
    return true
  }
}

export const builtinInstructionsStore = new BuiltinInstructionsStore()
