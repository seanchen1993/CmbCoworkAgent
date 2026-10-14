import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import type { RunnableConfig } from "@langchain/core/runnables"
import ts from "typescript"
import {
  checkpointHasInterrupt,
  deriveCheckpointTranscriptIndex
} from "../../shared/checkpoint-transcript"
import type { SqlJsSaver, SqlJsSaverOptions } from "./sqljs-saver"

function sourceFile(relativePath: string) {
  const path = new URL(relativePath, import.meta.url)
  return ts.createSourceFile(path.pathname, readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function sourceFunction(source: ts.SourceFile, name: string) {
  const matches = source.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name)
  if (matches.length !== 1 || !matches[0].body)
    throw new TypeError(`Expected one actual ${name} implementation`)
  return matches[0]
}

/** Read the actual main-thread constructor options; do not silently guess changed defaults. */
export function productionMainCheckpointOptions(): SqlJsSaverOptions {
  const source = sourceFile("../agent/runtime.ts")
  const names = ["MAIN_THREAD_MAX_ROOT_CHECKPOINTS",
    "MAIN_THREAD_MAX_FORK_BOUNDARY_CHECKPOINTS", "MAIN_THREAD_MAX_FORK_BOUNDARY_BYTES"]
  const constants = names.map(name => {
    const matches = source.statements.filter((node): node is ts.VariableStatement =>
      ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
        ts.isIdentifier(declaration.name) && declaration.name.text === name))
    if (matches.length !== 1) throw new TypeError(`Missing actual retention constant ${name}`)
    return matches[0].getText(source)
  })
  const calls: ts.NewExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "SqlJsSaver") calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFunction(source, "getCheckpointerInternal"))
  const options = calls.length === 1 ? calls[0].arguments?.[2] : undefined
  if (!options || !ts.isObjectLiteralExpression(options))
    throw new TypeError("Expected the actual native saver options object")
  const code = ts.transpileModule(`(() => {
    ${constants.join("\n")}
    const isSubThreadCheckpoint = false
    const recoverMainCheckpointMessages = undefined
    return ${options.getText(source)}
  })()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const actual: unknown = runInNewContext(code)
  if (!actual || typeof actual !== "object" || Array.isArray(actual))
    throw new TypeError("Invalid actual retention options")
  const data = actual as Record<string, unknown>
  const allowed = ["maxRootCheckpoints", "maxRootForkBoundaryCheckpoints",
    "maxRootForkBoundaryBytes", "maxNonRootCheckpoints", "recoverMissingCheckpointMessages",
    "recoverFunctionConversationMessages"]
  if (Object.keys(data).some(key => !allowed.includes(key)) ||
    data.maxRootCheckpoints !== 3 || data.maxRootForkBoundaryCheckpoints !== 30 ||
    data.maxRootForkBoundaryBytes !== 48 * 1024 * 1024 || data.maxNonRootCheckpoints !== 1 ||
    data.recoverMissingCheckpointMessages !== undefined ||
    typeof data.recoverFunctionConversationMessages !== "function")
    throw new TypeError("Actual main retention contract changed; review the fixture")
  return { maxRootCheckpoints: data.maxRootCheckpoints,
    maxRootForkBoundaryCheckpoints: data.maxRootForkBoundaryCheckpoints,
    maxRootForkBoundaryBytes: data.maxRootForkBoundaryBytes,
    maxNonRootCheckpoints: data.maxNonRootCheckpoints }
}

/**
 * Execute the existing completion-marker producer after an actual graph turn.
 * This is a thin native lease seam, not the application's full Electron IPC permission test.
 */
export async function markActualCompletedConversationBoundary(input: {
  saver: SqlJsSaver
  config: RunnableConfig
  controller: AbortController
  assertCurrent(): void
}): Promise<void> {
  const facts = input.config.configurable
  if (typeof facts?.thread_id !== "string" || !facts.thread_id ||
    (facts.checkpoint_ns ?? "") !== "" || typeof facts.checkpoint_id !== "string" ||
    !facts.checkpoint_id) throw new TypeError("Exact actual completed root config required")
  const assertCurrent = () => {
    input.controller.signal.throwIfAborted()
    input.assertCurrent()
  }
  assertCurrent()
  const before = await input.saver.getTuple(input.config)
  assertCurrent()
  if (before?.checkpoint.id !== facts.checkpoint_id || (before.pendingWrites?.length ?? 0) > 0)
    throw new TypeError("A completed checkpoint without pending writes is required")
  const threadId = facts.thread_id
  const runToken = `actual-completed:${facts.checkpoint_id}`
  const activeRuns = new Map([[threadId, input.controller]])
  const warnings: unknown[][] = []
  const source = sourceFile("../ipc/agent.ts")
  const producer = sourceFunction(source, "markLatestForkBoundary")
  const code = ts.transpileModule(`(${producer.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const mark: (args: {
    threadId: string
    source: "agent_run_complete"
    runToken: string
    controller: AbortController
  }) => Promise<void> = runInNewContext(code, {
    activeRuns,
    isCurrentRunMessageQueueOwner: (id: string, token: string) => {
      assertCurrent()
      return id === threadId && token === runToken
    },
    hasPendingApprovalForThread: (id: string) => {
      assertCurrent()
      if (id !== threadId) throw new TypeError("Foreign completion target")
      return false
    },
    withCheckpointer: async (id: string, run: (saver: SqlJsSaver) => Promise<void>) => {
      assertCurrent()
      if (id !== threadId) throw new TypeError("Foreign native saver request")
      const latest = await input.saver.getTuple({ configurable: {
        thread_id: threadId, checkpoint_ns: ""
      } })
      assertCurrent()
      if (latest?.checkpoint.id !== facts.checkpoint_id)
        throw new TypeError("The actual completed turn must still own the current checkpoint")
      await run(input.saver)
      assertCurrent()
    },
    checkpointHasInterrupt,
    deriveCheckpointTranscriptIndex,
    console: { warn: (...args: unknown[]) => { warnings.push(args) } }
  })
  try {
    await mark({ threadId, source: "agent_run_complete", runToken,
      controller: input.controller })
  } finally {
    activeRuns.delete(threadId)
  }
  assertCurrent()
  if (warnings.length) throw new TypeError("Actual completion-marker producer failed")
  const after = await input.saver.getTuple(input.config)
  assertCurrent()
  const metadata = after?.metadata as Record<string, unknown> | undefined
  const marker = metadata?.cmb_fork_boundary
  if (!after || after.checkpoint.id !== facts.checkpoint_id || !marker ||
    typeof marker !== "object" || Array.isArray(marker) ||
    (marker as Record<string, unknown>).checkpointId !== facts.checkpoint_id ||
    (marker as Record<string, unknown>).kind !== "turn_complete" ||
    (marker as Record<string, unknown>).outcome !== "completed" ||
    (after.pendingWrites?.length ?? 0) > 0)
    throw new TypeError("The exact completed checkpoint must have its actual native marker")
}
