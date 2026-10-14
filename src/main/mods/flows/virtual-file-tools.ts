import { createHash } from "node:crypto"
import { types } from "node:util"
import {
  VirtualTreeStore,
  isVirtualTreeStore,
  readVirtualTreeFacts,
  type VirtualTreeBinding
} from "./virtual-tree"

type Name = "virtual_read" | "virtual_list" | "virtual_exists" | "virtual_write"
export interface FixedVirtualFileTool {
  readonly name: Name
  readonly invoke: (input: unknown) => Promise<string>
}
interface Invocation {
  name: Name
  inputDigest: string
  outputDigest: string
}
interface FileToolFacts {
  coverage: "fixed-virtual-file-tool-calls-only-v1"
  tree: NonNullable<ReturnType<typeof readVirtualTreeFacts>>
  calls: Invocation[]
}
const receipts = new WeakMap<object, FileToolFacts>()
const instances = new WeakMap<object, { invocation: object; tool: FixedVirtualFileTool }>()
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

export function readVirtualFileToolFacts(token: object): FileToolFacts | undefined {
  const facts = receipts.get(token)
  return facts ? structuredClone(facts) : undefined
}

/** A same-name/schema clone is not an admitted host capability. These objects
 * are not LangChain tools yet: the future graph adapter must retain this exact
 * capability identity and separately prove its own closed tool inventory.
 */
export function isFixedVirtualFileTool(tool: object, invocation: object): boolean {
  const record = instances.get(tool)
  return !!record && record.invocation === invocation && record.tool === tool
}

export function createVirtualFileTools(options: {
  store: VirtualTreeStore
  treeId: string
  root: string
  binding: VirtualTreeBinding
  invocation: object
  signal: AbortSignal
  deadline: number
  maxCalls: number
  assertCurrent(): void
}) {
  const { store, treeId, root, invocation, signal, deadline, maxCalls, assertCurrent } = options
  const binding = { ...options.binding }
  if (
    !isVirtualTreeStore(store) ||
    !invocation ||
    typeof invocation !== "object" ||
    types.isProxy(invocation) ||
    !Object.isFrozen(invocation) ||
    !Number.isSafeInteger(deadline) ||
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 128
  )
    throw Error("VIRTUAL_TOOLS_OPTIONS")
  let state: "open" | "closing" | "sealed" | "failed" = "open"
  let active = 0
  let calls = 0
  let sealPromise: Promise<object> | undefined
  let resolveDrain!: () => void
  const drain = new Promise<void>((resolve) => {
    resolveDrain = resolve
  })
  const ledger: Invocation[] = []
  const currentState = () => state
  const resources: {
    session?: ReturnType<VirtualTreeStore["open"]>
    timer?: ReturnType<typeof setTimeout>
  } = {}
  const cleanup = () => {
    if (resources.timer !== undefined) clearTimeout(resources.timer)
    signal.removeEventListener("abort", onAbort)
  }
  const fail = () => {
    if (state === "sealed" || state === "failed") return
    state = "failed"
    cleanup()
    try {
      resources.session?.abandon()
    } catch {
      /* Failure never creates a receipt. */
    }
    resolveDrain()
  }
  function onAbort() {
    fail()
  }
  const current = () => {
    if (state === "failed" || state === "sealed") throw Error("VIRTUAL_TOOLS_CLOSED")
    try {
      signal.throwIfAborted()
      if (Date.now() >= deadline) throw Error("VIRTUAL_TOOLS_DEADLINE")
      assertCurrent()
      signal.throwIfAborted()
      if (Date.now() >= deadline || currentState() === "failed") throw Error("VIRTUAL_TOOLS_CLOSED")
    } catch (error) {
      fail()
      throw error
    }
  }
  current()
  resources.session = store.open(treeId, root, current, binding)
  signal.addEventListener("abort", onAbort, { once: true })
  resources.timer = setTimeout(fail, Math.max(0, Math.min(deadline - Date.now(), 2_147_483_647)))

  const execute = (name: Name, input: unknown): string => {
    if (
      !input ||
      typeof input !== "object" ||
      types.isProxy(input) ||
      (Object.getPrototypeOf(input) !== null && Object.getPrototypeOf(input) !== Object.prototype)
    ) {
      throw Error("VIRTUAL_TOOLS_INPUT")
    }
    const keys = Reflect.ownKeys(input)
    if (keys.length > 2 || keys.some((key) => key !== "path" && key !== "content")) {
      throw Error("VIRTUAL_TOOLS_INPUT")
    }
    const props = Object.getOwnPropertyDescriptors(input)
    if (Object.values(props).some((item) => !("value" in item) || !item.enumerable)) {
      throw Error("VIRTUAL_TOOLS_INPUT")
    }
    const path = props.path?.value ?? (name === "virtual_list" ? "" : undefined)
    const content = props.content?.value
    if (
      typeof path !== "string" ||
      path.length > 1024 ||
      (name !== "virtual_write" && content !== undefined)
    )
      throw Error("VIRTUAL_TOOLS_INPUT")
    if (
      name === "virtual_write" &&
      (typeof content !== "string" ||
        content.length > 4 * 1024 * 1024 ||
        Buffer.byteLength(content) > 4 * 1024 * 1024 ||
        Buffer.from(content).toString() !== content)
    )
      throw Error("VIRTUAL_TOOLS_INPUT")
    const inputText = JSON.stringify({ path, ...(name === "virtual_write" ? { content } : {}) })
    let output: string
    if (name === "virtual_read") {
      const bytes = resources.session!.read(path)
      const text = bytes.toString("utf8")
      if (!Buffer.from(text).equals(bytes)) throw Error("VIRTUAL_TOOLS_BINARY_INPUT")
      output = JSON.stringify({ text })
    } else if (name === "virtual_list")
      output = JSON.stringify({ names: resources.session!.list(path) })
    else if (name === "virtual_exists")
      output = JSON.stringify({ exists: resources.session!.exists(path) })
    else {
      const operationId = resources.session!.beginWrite(path, Buffer.from(content))
      const nextRoot = resources.session!.settleWrite(operationId)
      output = JSON.stringify({ operationId, root: nextRoot })
    }
    ledger.push({ name, inputDigest: hash(inputText), outputDigest: hash(output) })
    return output
  }
  const tools = (["virtual_read", "virtual_list", "virtual_exists", "virtual_write"] as const).map(
    (name): FixedVirtualFileTool => {
      const tool = Object.freeze({
        name,
        invoke(input: unknown): Promise<string> {
          if (state !== "open") return Promise.reject(Error("VIRTUAL_TOOLS_CLOSED"))
          let admitted = false
          try {
            current()
            if (state !== "open") throw Error("VIRTUAL_TOOLS_CLOSED")
            if (++calls > maxCalls) throw Error("VIRTUAL_TOOLS_LIMIT")
            active++
            admitted = true
            // All SQLite effects are synchronous; only result delivery remains pending.
            const result = execute(name, input)
            return Promise.resolve()
              .then(() => {
                current()
                return result
              })
              .catch((error) => {
                fail()
                throw error
              })
              .finally(() => {
                if (--active === 0 && state === "closing") resolveDrain()
              })
          } catch (error) {
            if (admitted) active--
            fail()
            return Promise.reject(error)
          }
        }
      })
      instances.set(tool, { invocation, tool })
      return tool
    }
  )
  return Object.freeze({
    tools: Object.freeze(tools),
    seal(): Promise<object> {
      if (sealPromise) return sealPromise
      if (state !== "open") return Promise.reject(Error("VIRTUAL_TOOLS_CLOSED"))
      state = "closing"
      if (!active) resolveDrain()
      sealPromise = (async () => {
        try {
          await drain
          current()
          if (active || ledger.length !== calls) throw Error("VIRTUAL_TOOLS_UNSETTLED")
          const tree = readVirtualTreeFacts(resources.session!.seal())
          if (!tree) throw Error("VIRTUAL_TOOLS_TREE_IDENTITY")
          const token = Object.freeze({})
          receipts.set(token, {
            coverage: "fixed-virtual-file-tool-calls-only-v1",
            tree,
            calls: structuredClone(ledger)
          })
          state = "sealed"
          cleanup()
          return token
        } catch (error) {
          fail()
          throw error
        }
      })()
      return sealPromise
    },
    dispose(): void {
      fail()
      cleanup()
    }
  })
}
