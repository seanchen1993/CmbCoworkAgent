import {
  STAGE_CHECK_RECEIPT_PREFIX,
  parseStageCheckReceipt,
  type StageCheckReceipt
} from "../../shared/project-runtime/stage-check-receipt"
import {
  assertCurrentRuntimePluginSourceContent,
  currentRuntimePluginSource,
  type RuntimePluginSourceBinding
} from "../plugins/runtime-source-scope"
import type { HookConfig, HookResult } from "./types"
import type { HookContext } from "./runner"
import type { PluginHookMetadata } from "../types"
import { isSameWorkspacePath } from "../../shared/workspace-path"

export interface StageCheckInvocation {
  binding: Readonly<RuntimePluginSourceBinding>
  hookId: string
  hook: Pick<HookConfig, "id" | "event" | "type" | "command" | "shell">
  receipts: StageCheckReceipt[]
  signal?: AbortSignal
}
type Sink = (invocation: StageCheckInvocation) => Promise<void>
let sink: Sink | undefined
export function registerStageCheckReceiptSink(next: Sink): () => void {
  if (sink) throw Error("STAGE_CHECK_SINK_ALREADY_REGISTERED")
  sink = next
  return () => {
    if (sink === next) sink = undefined
  }
}
/** Only called by the real synchronous command Hook runner, never model/tool output. */
export function prepareStageCheckReceipts(
  hook: HookConfig,
  context: HookContext,
  result: HookResult
): (() => Promise<void>) | undefined {
  if (!result.stdout.split(/\r?\n/).some((line) => line.startsWith(STAGE_CHECK_RECEIPT_PREFIX)))
    return undefined
  const binding = currentRuntimePluginSource()
  if (!binding?.projectId.startsWith("composition-legacy:") || !sink) return undefined
  const actual = hook as PluginHookMetadata
  if (
    (hook.type ?? "command") !== "command" ||
    hook.async ||
    actual.pluginId !== binding.plugin.id ||
    !hook.hookSourceRoot ||
    !isSameWorkspacePath(hook.hookSourceRoot, binding.plugin.path)
  )
    throw Error("STAGE_CHECK_SOURCE_INVALID")
  const receipts: StageCheckReceipt[] = []
  const remainder: string[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith(STAGE_CHECK_RECEIPT_PREFIX)) {
      remainder.push(line)
      continue
    }
    const encoded = line.slice(STAGE_CHECK_RECEIPT_PREFIX.length)
    if (encoded.length > 90_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw Error("STAGE_CHECK_RECEIPT_LIMIT")
    const bytes = Buffer.from(encoded, "base64")
    if (bytes.length > 65536 || bytes.toString("base64") !== encoded || receipts.length >= 32)
      throw Error("STAGE_CHECK_RECEIPT_LIMIT")
    receipts.push(
      parseStageCheckReceipt(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
    )
  }
  result.stdout = remainder.join("\n")
  const commit = sink
  return async () => {
    context.signal?.throwIfAborted()
    assertCurrentRuntimePluginSourceContent()
    await commit({
      binding,
      hookId: hook.id,
      hook: {
        id: hook.id,
        event: hook.event,
        type: hook.type,
        command: hook.command,
        shell: hook.shell
      },
      receipts,
      signal: context.signal
    })
    context.signal?.throwIfAborted()
    assertCurrentRuntimePluginSourceContent()
  }
}
