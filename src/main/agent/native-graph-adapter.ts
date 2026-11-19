import { createAgent } from "langchain"
import type { SqlJsSaver } from "../checkpointer/sqljs-saver"
import type { FunctionConversationStore } from "../db/function-conversation-store"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import type { FunctionConversationGraphBinding } from "./mods-conversation"
import type { FunctionConversationNativeHost } from "./function-conversation-native-host"
import { wrapFunctionConversationInvocation } from "./mods-conversation-invocation"
import type { FunctionConversationCompactionReconciler } from "./mods-conversation-invocation"
import { wrapFunctionConversationNativeInvocation } from "./function-conversation-native-invocation"
import { createFunctionConversationNativeAgent } from "./native-agent-factory"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { isCompletionRevisionInput, type CompletionRevisionInput } from "./skill-lifecycle/completion-hooks"

const nativeRevisionGraphs = new WeakSet<object>()
const nativeGraphHas = WeakSet.prototype.has, nativeGraphAdd = WeakSet.prototype.add
const apply = Reflect.apply

export function isRuntimeNativeCompletionGraph(graph: object | null | undefined): boolean {
  return apply(nativeGraphHas, nativeRevisionGraphs, [graph]) as boolean
}

/** Only a graph with the installed native input consumer may use the one-shot receipt. */
export function selectRuntimeCompletionRevisionInput(graph: object,
  prepared: CompletionRevisionInput | undefined,
  ordinary: () => CompletionRevisionInput): CompletionRevisionInput {
  if (!isRuntimeNativeCompletionGraph(graph)) return ordinary()
  if (!isCompletionRevisionInput(prepared))
    throw new ModFunctionError("MODS_COMPLETION_REVISION_INPUT_INVALID")
  return prepared
}

interface ConversationBinding {
  readonly store: FunctionConversationStore
  readonly binding: FunctionConversationGraphBinding
}

/** Ordinary graphs never acquire conversation or native installation obligations. */
export type RuntimeConversationGraphPlan =
  | { readonly kind: "ordinary" }
  | { readonly kind: "conversation"; readonly conversation: ConversationBinding }
  | {
      readonly kind: "native"
      readonly host: FunctionConversationNativeHost
      readonly runtime: FunctionNativeConversationRuntime
      readonly conversation?: ConversationBinding
      readonly historySaver?: SqlJsSaver
      readonly reconcileCompaction?: FunctionConversationCompactionReconciler
    }

/**
 * Own the SDK-dependent assembly order in one place. The private native factory,
 * host installation and invocation wrappers retain their original proof checks.
 * No partially installed agent is returned when binding or installation fails.
 */
export function createRuntimeConversationGraph(
  options: Parameters<typeof createAgent>[0],
  plan: RuntimeConversationGraphPlan,
  onCreated?: () => void
): ReturnType<typeof createAgent> {
  const native = plan.kind === "native" ? plan : undefined
  const agent = native ? createFunctionConversationNativeAgent(options) : createAgent(options)
  onCreated?.()
  native?.host.install(agent.graph)
  const conversation = plan.kind === "ordinary" ? undefined : plan.conversation
  const admitted = conversation
    ? wrapFunctionConversationInvocation(agent, {
        store: conversation.store,
        binding: conversation.binding,
        ...(native?.historySaver
          ? {
              history: {
                saver: native.historySaver,
                assertCurrent: native.runtime.assertCurrent.bind(native.runtime),
                register: native.host.registerHistorical,
                registerAsync: native.host.registerHistoricalAsync,
                reconcileCompaction: native.reconcileCompaction
              },
              onIntakeNotes: native.host.registerIntake
            }
          : {})
      })
    : agent
  if (!native) return admitted
  const wrapped = wrapFunctionConversationNativeInvocation(admitted, native.host, native.runtime)
  apply(nativeGraphAdd, nativeRevisionGraphs, [wrapped])
  return wrapped
}
