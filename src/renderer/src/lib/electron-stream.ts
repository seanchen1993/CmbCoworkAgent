import type { Message } from "@langchain/langgraph-sdk"
import type { UseStreamCustom, UseStreamTransport } from "@langchain/langgraph-sdk/react"
import {
  MessageTupleManager,
  StreamManager,
  toMessageDict,
  type EventStreamEvent
} from "@langchain/langgraph-sdk/ui"

type StreamValues = Record<string, unknown>
type SubmitOptions = Parameters<UseStreamCustom<StreamValues>["submit"]>[1]
type AssistantSnapshot = Extract<Message, { type: "ai" }> & { id: string }

export interface ElectronStreamOptions {
  transport: UseStreamTransport
  threadId: string
  onCustomEvent?: (data: unknown) => void
  onError?: (error: unknown) => void
}

const EMPTY_MESSAGES: Message[] = []

function sanitizeSnapshotMessages(messages: unknown[]): Message[] {
  const isMessage = (message: unknown): message is Message =>
    message !== null &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    "id" in message &&
    typeof message.id === "string" &&
    message.id.length > 0
  // findIndex visits holes; filter alone would hide whether the wire was malformed.
  if (messages.findIndex((message) => !isMessage(message)) < 0) return messages as Message[]
  const valid = messages.filter(isMessage)
  console.warn("[ElectronStream] Ignored invalid snapshot entries", messages.length - valid.length)
  return valid
}

/** SDK 1.8 keeps tuple indexes across values snapshots. Validate against the
 * current frame, with a lazy ID index for snapshot replacements. Token updates
 * read only the affected slot and retain all stable prefix object references.
 * Keep chunk buffers across ordinary snapshots: our transport emits deltas and
 * values can be partial/lagging. Only an explicit retry or new run resets them.
 */
class SnapshotMessageTupleManager extends MessageTupleManager {
  private frame: Message[] = EMPTY_MESSAGES
  private indexes: Map<string, number> | null = null
  private writtenId: string | null = null
  private authoritativeContentIds = new Set<string>()

  readFrame(frame: Message[]): Message[] {
    if (frame !== this.frame) {
      this.frame = frame
      this.indexes = null
    }
    return frame
  }

  commitFrame(frame: Message[]): void {
    if (this.writtenId && this.authoritativeContentIds.has(this.writtenId)) {
      const index = super.get(this.writtenId)?.index
      if (index !== undefined && frame[index]?.id === this.writtenId) {
        // Keep subsequent chunks at the same authority as the replacement;
        // otherwise the live merger would permanently prefer the old snapshot.
        const prioritized = { ...frame[index], content_priority: 1 }
        frame[index] = prioritized
      }
    }
    if (frame.length < this.frame.length) {
      this.indexes = null
    } else if (this.writtenId && this.indexes) {
      const index = super.get(this.writtenId)?.index
      if (index !== undefined) this.indexes.set(this.writtenId, index)
    }
    this.frame = frame
    this.writtenId = null
  }

  replaceAssistantContent(frame: Message[], snapshot: AssistantSnapshot): Message[] {
    const index = frame.findIndex((message) => message.id === snapshot.id && message.type === "ai")
    const tuple = super.get(snapshot.id)
    const merged = {
      ...(index >= 0 ? frame[index] : undefined),
      // An ordinary values frame may have omitted this message. Its buffered
      // tool arguments still belong to the run and must survive a text rewrite.
      ...(tuple?.chunk ? toMessageDict(tuple.chunk) : undefined),
      ...snapshot
    }
    // Use the public SDK converter through a fresh manager, then replace only
    // this tuple's seed. Clearing all tuples would lose interleaved tool streams.
    const seed = new MessageTupleManager()
    if (Object.hasOwn(snapshot, "tool_calls"))
      delete (merged as { tool_call_chunks?: unknown }).tool_call_chunks
    seed.add(merged, undefined)
    if (tuple) tuple.chunk = seed.get(snapshot.id)?.chunk
    else super.add(merged, undefined)
    this.authoritativeContentIds.add(snapshot.id)
    const messages = frame.slice()
    const replacement = { ...merged, content_priority: 1 }
    if (index >= 0) messages[index] = replacement
    else messages.push(replacement)
    return messages
  }

  override get(id: string | null | undefined, defaultIndex?: number) {
    const tuple = super.get(id)
    if (!tuple || id == null || defaultIndex == null) return tuple
    if (tuple.index === undefined || this.frame[tuple.index]?.id !== id) {
      if (!this.indexes) {
        this.indexes = new Map()
        this.frame.forEach((message, index) => {
          if (message?.id) this.indexes!.set(message.id, index)
        })
      }
      tuple.index = this.indexes.get(id) ?? this.frame.length
    }
    this.writtenId = id
    return tuple
  }

  override clear(): void {
    super.clear()
    this.frame = EMPTY_MESSAGES
    this.indexes = null
    this.writtenId = null
    this.authoritativeContentIds.clear()
  }
}

/** The app uses a fixed thread and custom IPC transport, not the SDK's HTTP
 * history/branch hook. Keep its streaming engine and callbacks, while owning
 * the snapshot boundary through public SDK APIs (no node_modules patch).
 */
export function createElectronStream(options: ElectronStreamOptions) {
  let callbacks: Pick<ElectronStreamOptions, "onCustomEvent" | "onError"> = options
  const tuples = new SnapshotMessageTupleManager()
  const manager = new StreamManager<StreamValues>(tuples, { throttle: false })
  const readMessages = (values: StreamValues | null): Message[] =>
    Array.isArray(values?.messages) ? values.messages : EMPTY_MESSAGES

  const submit = async (input: StreamValues | null | undefined, submitOptions?: SubmitOptions) => {
    await manager.start(
      async (signal) => {
        tuples.clear()
        const optimistic = submitOptions?.optimisticValues
        manager.setStreamValues(
          typeof optimistic === "function" ? optimistic({}) : (optimistic ?? {})
        )
        const events = await options.transport.stream({
          input,
          context: submitOptions?.context,
          command: submitOptions?.command,
          signal,
          config: {
            ...submitOptions?.config,
            configurable: { thread_id: options.threadId, ...submitOptions?.config?.configurable }
          }
        })
        return (async function* () {
          for await (const transportEvent of events) {
            // ElectronIPCTransport owns the wire conversion. As with the SDK's
            // custom hook, bridge its open event name to StreamManager's union here.
            const event = transportEvent as EventStreamEvent<
              StreamValues,
              Partial<StreamValues>,
              unknown
            >
            if (event.event === "values" && event.data && typeof event.data === "object") {
              // IPC also emits todos/workspace-only values; absence of messages
              // means no message update, whereas messages: [] is an explicit reset.
              const data = { ...manager.values, ...event.data }
              if (Array.isArray(event.data.messages)) {
                data.messages = sanitizeSnapshotMessages(event.data.messages)
              }
              yield { ...event, data }
            } else {
              if (
                event.event === "custom" &&
                event.data &&
                typeof event.data === "object" &&
                "type" in event.data &&
                event.data.type === "stream_retry_reset"
              ) {
                tuples.clear()
              }
              if (
                event.event === "custom" &&
                event.data &&
                typeof event.data === "object" &&
                "type" in event.data &&
                event.data.type === "coordinator_ai_snapshot_message" &&
                "assistantMessage" in event.data
              ) {
                const snapshot = event.data.assistantMessage as Partial<Message> | undefined
                if (
                  snapshot?.type === "ai" &&
                  typeof snapshot.id === "string" &&
                  snapshot.id &&
                  (typeof snapshot.content === "string" || Array.isArray(snapshot.content))
                ) {
                  manager.setStreamValues({
                    ...manager.values,
                    messages: tuples.replaceAssistantContent(
                      readMessages(manager.values),
                      snapshot as AssistantSnapshot
                    )
                  })
                }
              }
              yield event
            }
          }
        })()
      },
      {
        initialValues: {},
        getMessages: (values) => tuples.readFrame(readMessages(values)),
        setMessages: (values, messages) => {
          tuples.commitFrame(messages)
          return { ...values, messages }
        },
        callbacks: { onCustomEvent: (data) => callbacks.onCustomEvent?.(data) },
        onSuccess: () => undefined,
        onError: (error) => callbacks.onError?.(error)
      }
    )
  }

  return {
    subscribe: manager.subscribe,
    setCallbacks(next: Pick<ElectronStreamOptions, "onCustomEvent" | "onError">) {
      callbacks = next
    },
    getSnapshot: manager.getSnapshot,
    get messages() {
      return readMessages(manager.values)
    },
    get values() {
      return manager.values ?? {}
    },
    get isLoading() {
      return manager.isLoading
    },
    get error() {
      return manager.error
    },
    submit,
    stop: () => manager.stop({}, {}),
    clear: manager.clear
  }
}
