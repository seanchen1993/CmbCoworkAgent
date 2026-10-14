import { sealNativeFlowFileCapture } from "../mods/flows/native-file-capture"
import { afterEach, expect, it, vi } from "vitest"
import { FakeToolCallingModel } from "langchain"
import { HumanMessage } from "@langchain/core/messages"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { VirtualTreeStore, readVirtualTreeSnapshot } from "../mods/flows/virtual-tree"
import {
  createFlowFileRuntime,
  readFlowFileRuntimeProof,
  describeFlowFileRuntime
} from "./flow-file-runtime"
import {
  flowPromptDigest,
  flowPromptResultSchema,
  describeFlowPromptRuntime
} from "./flow-prompt-runtime-contract"
import { createPromptOnlyStructuredOutputTool } from "./workflow/subagent"

const fixture = vi.hoisted(() => ({
  config: {
    id: "fixture",
    ref: "custom:fixture",
    source: "custom",
    name: "fixture",
    model: "fixture",
    baseUrl: "http://fixture.invalid",
    apiKey: "test-only"
  },
  model: undefined as unknown,
  tools: [] as Array<{ name: string; func: unknown; schema: unknown }>,
  checkpointerGate: undefined as undefined | Promise<void>,
  failConstruction: false
}))
vi.mock("../models/registry", async (original) => ({
  ...(await original<typeof import("../models/registry")>()),
  getModelConfigByRef: () => fixture.config
}))
vi.mock("./runtime", async () => {
  const { MemorySaver } = await import("@langchain/langgraph")
  return {
    getModelInstance: () => fixture.model,
    getCheckpointer: async () => {
      await fixture.checkpointerGate
      return new MemorySaver()
    }
  }
})
vi.mock("langchain", async (original) => {
  const actual = await original<typeof import("langchain")>()
  return {
    ...actual,
    createAgent: (...args: Parameters<typeof actual.createAgent>) => {
      if (fixture.failConstruction) throw Error("graph-construction-failed")
      fixture.tools = args[0].tools as never
      return actual.createAgent(...args)
    }
  }
})
const cleanups: Array<() => void> = []
afterEach(() => {
  fixture.checkpointerGate = undefined
  fixture.failConstruction = false
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.useRealTimers()
})
async function setup(
  calls?: Array<Array<{ name: string; args: Record<string, unknown> }>>,
  current = () => {},
  observeOptions?: (options: Record<string, unknown>, controller: AbortController) => void
) {
  const directory = mkdtempSync(join(tmpdir(), "flow-file-graph-"))
  const store = new VirtualTreeStore(join(directory, "tree.sqlite"))
  cleanups.push(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const tree = store.create([{ path: "a.txt", content: Buffer.from("original") }])
  fixture.model = new FakeToolCallingModel({
    toolCalls: (
      calls ?? [
        [{ name: "virtual_read", args: { path: "a.txt" } }],
        [{ name: "virtual_write", args: { path: "a.txt", content: "changed" } }],
        [{ name: "structured_output", args: { passed: true, summary: "accepted virtual edit" } }]
      ]
    ).map((turn, i) => turn.map((call, j) => ({ ...call, id: `call-${i}-${j}` })))
  })
  const invocation = Object.freeze({})
  const descriptor = describeFlowPromptRuntime({
    model: fixture.config as never,
    rolePrompt: "role",
    mandatoryPolicyDigest: "f".repeat(64)
  })
  const controller = new AbortController()
  const options = {
    threadId: "fixture",
    modelId: fixture.config.ref,
    abortSignal: controller.signal,
    additionalTools: [createPromptOnlyStructuredOutputTool(flowPromptResultSchema(), invocation)]
  }
  observeOptions?.(options, controller)
  const runtime = await createFlowFileRuntime(options as never, {
    profile: "workspace-files-v1",
    invocation,
    store,
    ...tree,
    binding: { executionId: "file-step", parentIncarnation: "parent" },
    rolePrompt: "role",
    expectedModelRef: fixture.config.ref,
    expectedModelDigest: descriptor.modelConfigurationDigest,
    mandatoryPolicyDigest: descriptor.mandatoryPolicyDigest,
    deadline: Date.now() + 5000,
    assertCurrent: current
  })
  const reader = readFlowFileRuntimeProof(runtime, invocation)!
  cleanups.push(() => reader.dispose())
  return { runtime, reader, invocation, controller, store, tree }
}
const invoke = (runtime: Awaited<ReturnType<typeof setup>>["runtime"]) =>
  runtime.invoke(
    { messages: [new HumanMessage("edit the virtual file")] },
    { configurable: { thread_id: "fixture" }, recursionLimit: 16 }
  )

it("uses the real graph and fixed file adapters, then jointly seals model/output/file facts", async () => {
  const f = await setup()
  await invoke(f.runtime)
  const facts = await f.reader.seal()
  expect(facts.runtimeProtocol).toBe("flow-files-runtime-v1")
  expect(facts.modelCalls).toBe(3)
  expect(facts.files.calls.map((call) => call.name)).toEqual(["virtual_read", "virtual_write"])
  expect(facts.files.tree.effects).toHaveLength(1)
  expect(facts.files.tree.root).not.toBe(f.tree.root)
  expect(Object.isFrozen(facts.files.tree)).toBe(true)
  expect(Object.isFrozen(facts.files.calls)).toBe(true)
  expect(Object.isFrozen(facts.files.tree.effects)).toBe(true)
  expect(readFlowFileRuntimeProof({ ...f.runtime }, f.invocation)).toBeUndefined()
  expect(readFlowFileRuntimeProof(new Proxy(f.runtime, {}), f.invocation)).toBeUndefined()
  expect(readFlowFileRuntimeProof(f.runtime, {})).toBeUndefined()
})
it("rejects model-requested ambient filesystem and shell tools", async () => {
  for (const name of ["read_file", "execute", "mcp__outside__tool"]) {
    const f = await setup([[{ name, args: {} }]])
    await expect(invoke(f.runtime)).rejects.toThrow()
    await expect(f.reader.seal()).rejects.toThrow()
  }
})
it("does not accept a result requested in parallel with a file mutation", async () => {
  const f = await setup([
    [
      { name: "virtual_write", args: { path: "a.txt", content: "mutation" } },
      { name: "structured_output", args: { passed: true, summary: "premature" } }
    ]
  ])
  await expect(invoke(f.runtime)).rejects.toThrow()
  await expect(f.reader.seal()).rejects.toThrow()
})
it("a failed file query cannot become reusable even when graph returns a tool error", async () => {
  const f = await setup([
    [{ name: "virtual_read", args: { path: "absent" } }],
    [{ name: "structured_output", args: { passed: true, summary: "pretend success" } }]
  ])
  await expect(invoke(f.runtime)).rejects.toThrow()
  await expect(f.reader.seal()).rejects.toThrow()
})
it("schema rejection before the host capability runs cannot silently disappear from coverage", async () => {
  const f = await setup([
    [{ name: "virtual_read", args: { path: 42 } }],
    [{ name: "structured_output", args: { passed: true, summary: "ignored tool error" } }]
  ])
  await invoke(f.runtime).catch(() => undefined)
  await expect(f.reader.seal()).rejects.toThrow()
})
it("joint sealing waits for the real result tool callback lifecycle", async () => {
  const f = await setup([[{ name: "structured_output", args: { passed: true, summary: "done" } }]])
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const running = f.runtime.invoke(
    { messages: [new HumanMessage("business prompt")] },
    {
      configurable: { thread_id: "fixture" },
      recursionLimit: 12,
      callbacks: [
        {
          async handleToolEnd() {
            enter()
            await released
          }
        }
      ]
    }
  )
  await entered
  let settled = false
  const sealing = f.reader.seal().then((value) => {
    settled = true
    return value
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  release()
  await running
  expect((await sealing).structuredOutputDigest).toMatch(/^[a-f0-9]{64}$/)
})
it("rejects swapped adapter implementation and schema", async () => {
  for (const mutation of ["func", "schema", "prototype"]) {
    const f = await setup()
    const tool = fixture.tools.find((candidate) => candidate.name === "virtual_read")!
    if (mutation === "func") tool.func = async () => "foreign result"
    else if (mutation === "schema")
      (tool.schema as Record<string, unknown>).additionalProperties = true
    else Object.setPrototypeOf(tool, Object.create(Object.getPrototypeOf(tool)))
    await expect(invoke(f.runtime)).rejects.toThrow()
    await expect(f.reader.seal()).rejects.toThrow()
  }
})
it("revocation after the final graph callback prevents joint sealing", async () => {
  let live = true
  const f = await setup(undefined, () => {
    if (!live) throw Error("revoked")
  })
  await invoke(f.runtime)
  live = false
  await expect(f.reader.seal()).rejects.toThrow()
})
it("construction failure clears both admission timers", async () => {
  vi.useFakeTimers()
  fixture.failConstruction = true
  await expect(setup()).rejects.toThrow("graph-construction-failed")
  expect(vi.getTimerCount()).toBe(0)
})

it("keeps the original cancellation binding across async checkpointer acquisition", async () => {
  let release!: () => void
  fixture.checkpointerGate = new Promise<void>((resolve) => {
    release = resolve
  })
  let mutate!: () => void
  const pending = setup(
    undefined,
    () => {},
    (options, controller) => {
      mutate = () => {
        options.abortSignal = new AbortController().signal
        options.threadId = "replacement-thread"
        options.modelId = "replacement-model"
        controller.abort(Error("original-authority-cancelled"))
      }
    }
  )
  const rejected = expect(pending).rejects.toThrow("original-authority-cancelled")
  mutate()
  release()
  await rejected
})

it("seals a NativeHost capture only from actual graph identity and a verified durable effect chain", async () => {
  const f = await setup()
  const snapshot = readVirtualTreeSnapshot(
    f.store.captureSnapshot(f.tree.treeId, f.tree.root, () => {})
  )!
  const descriptor = describeFlowFileRuntime({
    model: fixture.config as never,
    rolePrompt: "role",
    mandatoryPolicyDigest: "f".repeat(64)
  })
  const dependencies = {
    schemaVersion: 1 as const,
    profile: "workspace-files-v1" as const,
    coverage: "prompt-prior-and-virtual-root" as const,
    runtimeProtocol: descriptor.runtimeProtocol,
    definitionDigest: "d".repeat(64),
    taskGoalDigest: "a".repeat(64),
    stepId: "write",
    modelRef: descriptor.modelRef,
    modelConfigurationDigest: descriptor.modelConfigurationDigest,
    mandatoryPolicyDigest: descriptor.mandatoryPolicyDigest,
    systemPromptDigest: descriptor.systemPromptDigest,
    rolePromptDigest: descriptor.rolePromptDigest,
    resultTool: descriptor.resultTool,
    stableInput: { version: 1 as const, digest: flowPromptDigest("edit the virtual file") },
    context: { version: 1 as const, digest: flowPromptDigest("[]") },
    priorProjection: "files-prior-v1" as const,
    virtualInput: { version: 1 as const, root: f.tree.root, originDigest: snapshot.originDigest }
  }
  const input = {
    runtime: f.runtime,
    invocation: f.invocation,
    store: f.store,
    dependencies,
    binding: {
      workspace: "owned",
      parentThreadId: "parent",
      parentThreadIncarnation: "parent",
      runId: "run",
      executionId: "file-step",
      childThreadId: "child",
      childThreadIncarnation: "child-inc",
      leaseGeneration: "lease"
    },
    structured: { passed: true, summary: "accepted virtual edit" },
    assertCurrent: () => {}
  }
  await expect(sealNativeFlowFileCapture({ ...input, runtime: { ...f.runtime } })).rejects.toThrow(
    "FLOW_FILE_RUNTIME_PROOF_REQUIRED"
  )
  await invoke(f.runtime)
  await expect(
    sealNativeFlowFileCapture({ ...input, binding: { ...input.binding, executionId: "other" } })
  ).rejects.toThrow("FLOW_FILE_RUNTIME_BINDING_CHANGED")
  const capture = await sealNativeFlowFileCapture(input)
  expect(capture.virtualTree.effectIds).toHaveLength(1)
  expect(capture.virtualTree.fileCalls).toBe(2)
  expect(capture.virtualTree.inputRoot).toBe(f.tree.root)
  expect(capture.virtualTree.finalRoot).not.toBe(f.tree.root)
  expect(capture.providerUsageEvidenceIds).toEqual([])
})
