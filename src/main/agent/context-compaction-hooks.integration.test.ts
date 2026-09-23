import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { AIMessage, HumanMessage, RemoveMessage } from "@langchain/core/messages"
import { FakeChatModel, FakeListChatModel } from "@langchain/core/utils/testing"
import { createAgent } from "langchain"
import { Command } from "@langchain/langgraph"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../mods/v2/session"
import { createCmbContextController } from "./context-summarization-middleware"
import { hasSameCompactionEvidence } from "./context-compaction-hooks"

const summary = [
  "Goal",
  "Constraints",
  "Completed",
  "Current State",
  "Blockers",
  "Key Decisions",
  "Next Step",
  "Critical Evidence"
]
  .map(
    (heading) =>
      `## ${heading}\n- Preserve compaction test evidence and exact source paths; continue the requested work.`
  )
  .join("\n")
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function fixture(
  options: { block?: boolean; disabled?: boolean; invalidSummary?: boolean; budget?: number } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), "cmb-compact-hooks-"))
  cleanups.push(async () => {
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !directory.includes("cmb-compact-hooks-")
    )
      throw Error("unsafe cleanup")
    await rm(directory, { recursive: true, force: true })
  })
  const archives = join(directory, "archives")
  await mkdir(archives)
  const saver = new SqlJsSaver(join(directory, "checkpoints.sqlite"))
  cleanups.push(() => saver.close())
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("classic.PreCompact", ($, e) => {
      if(e.trigger!=="auto"&&e.trigger!=="manual") throw Error("trigger missing");
      if(e.custom_instructions!==null&&typeof e.custom_instructions!=="string") throw Error("instructions missing");
      return ${options.block ? '{block:"Preserve the full conversation"}' : "{}"};
    });
    on("classic.PostCompact", ($, e) => {
      if(!e.compact_summary.includes("## Critical Evidence")) throw Error("summary missing");
      return {block:"Observational hook cannot undo a durable checkpoint"};
    });
  }}`)
  const session = new FunctionSession(
    [
      {
        guest,
        name: "compact-observer",
        root: directory,
        tier: "user",
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      threadId: "thread",
      workspace: directory,
      assertLive: () => {},
      publish: async (value) => value
    }
  )
  cleanups.push(() => session.close())
  const events: Array<{ name: string; input: Record<string, unknown>; checkpointId?: string }> = []
  const run = async (
    name: "PreCompact" | "PostCompact",
    input: Record<string, string | null>,
    signal?: AbortSignal
  ) => {
    const checkpoint = await saver.getTuple({ configurable: { thread_id: "thread" } })
    events.push({ name, input, checkpointId: checkpoint?.checkpoint.id })
    const result = await session.classicEvent(
      `classic.${name}`,
      {
        hook_event_name: name,
        session_id: "thread",
        cwd: directory,
        transcript_path: "",
        ...input
      },
      signal
    )
    if (name === "PreCompact" && typeof result?.block === "string") throw Error(result.block)
  }
  const model = new FakeListChatModel({ responses: [options.invalidSummary ? "" : summary] })
  const modelCall = vi.spyOn(model, "invoke")
  const controller = createCmbContextController({
    model,
    backend: {
      write: async (path: string, content: string) => {
        await writeFile(join(archives, path.split("/").at(-1)!), content)
        return { path }
      },
      writeInternalArtifact: async (path: string, content: string) => {
        await writeFile(join(archives, path.split("/").at(-1)!), content)
        return {}
      },
      removeInternalArtifact: async (path: string) => {
        await rm(join(archives, path.split("/").at(-1)!), { force: true })
        return {}
      },
      downloadFiles: async () => []
    } as never,
    trigger: { type: "messages", value: 2 },
    keep: { type: "messages", value: 1 },
    maxInputTokens: 32000,
    ...(options.budget ? { postCompactionInputBudgetTokens: options.budget } : {}),
    compactionHooks: {
      isEnabled: () => !options.disabled,
      before: (
        event: { trigger: "manual" | "auto"; customInstructions: string | null },
        signal?: AbortSignal
      ) =>
        run(
          "PreCompact",
          { trigger: event.trigger, custom_instructions: event.customInstructions },
          signal
        ),
      after: (event: { trigger: "manual" | "auto"; summary: string }, signal?: AbortSignal) =>
        run("PostCompact", { trigger: event.trigger, compact_summary: event.summary }, signal)
    }
  })
  class Model extends FakeChatModel {
    bindTools() {
      return this
    }
    async _generate() {
      const message = new AIMessage("continued")
      return { generations: [{ message, text: "continued" }] }
    }
  }
  const agent = createAgent({
    model: new Model({}),
    tools: [],
    middleware: [controller.middleware],
    checkpointer: controller.wrapCheckpointer(saver)
  })
  const messages = [
    new HumanMessage("Original requirement"),
    new AIMessage("Earlier progress"),
    new HumanMessage("Latest request")
  ]
  return {
    agent,
    controller,
    saver,
    messages,
    events,
    modelCall,
    archives,
    config: { configurable: { thread_id: "thread" } }
  }
}

it("blocks real automatic summarization before any model or archive work", async () => {
  const f = await fixture({ block: true })
  await expect(f.agent.invoke({ messages: f.messages }, f.config)).rejects.toThrow(
    "Preserve the full conversation"
  )
  expect(f.modelCall).not.toHaveBeenCalled()
  expect(await readdir(f.archives)).toEqual([])
  expect(f.events.map((event) => event.name)).toEqual(["PreCompact"])
})

it("observes automatic compaction only after its real SQLite checkpoint is durable", async () => {
  const f = await fixture()
  await f.agent.invoke({ messages: f.messages }, f.config)
  expect(f.events.map((event) => event.name)).toEqual(["PreCompact", "PostCompact"])
  expect(f.events[0].input).toEqual({ trigger: "auto", custom_instructions: null })
  expect(f.events[1].input).toEqual({ trigger: "auto", compact_summary: summary })
  const committed = await f.saver.getTuple({
    configurable: { thread_id: "thread", checkpoint_id: f.events[1].checkpointId }
  })
  expect(committed?.checkpoint.channel_values._summarizationEvent).toBeTruthy()
  const files = await readdir(f.archives)
  expect(files.length).toBeGreaterThan(0)
  expect(await readFile(join(f.archives, files[0]), "utf8")).toContain("Original requirement")
  await f.agent.updateState(f.config, { messages: [new HumanMessage("next checkpoint")] })
  expect(f.events.filter((event) => event.name === "PostCompact")).toHaveLength(1)
})

it("keeps the same task usable with compact hooks disabled", async () => {
  const f = await fixture({ disabled: true, block: true })
  const flush = vi.spyOn(f.saver, "flushStrict")
  await f.agent.invoke({ messages: f.messages }, f.config)
  expect(f.events).toEqual([])
  expect(f.modelCall).toHaveBeenCalled()
  expect(flush).not.toHaveBeenCalled()
  expect(
    (await f.saver.getTuple(f.config))?.checkpoint.channel_values._summarizationEvent
  ).not.toHaveProperty("compactionId")
  expect(
    (await f.saver.getTuple(f.config))?.checkpoint.channel_values._summarizationEvent
  ).toBeTruthy()
})

it.each([{ invalidSummary: true }, { budget: 1 }])(
  "never reports PostCompact after an unsuccessful summary: %j",
  async (options) => {
    const f = await fixture(options)
    await expect(f.agent.invoke({ messages: f.messages }, f.config)).rejects.toThrow()
    expect(f.events.map((event) => event.name)).toEqual(["PreCompact"])
  }
)

it("prepares manual compaction without Post, then reports the committed summary once", async () => {
  const f = await fixture()
  const signal = new AbortController().signal
  const plan = await f.controller.prepare(
    { messages: f.messages, state: {} },
    "Keep exact paths",
    signal
  )
  if ("skip" in plan) throw Error(plan.skip)
  expect(f.events.map((event) => event.name)).toEqual(["PreCompact"])
  expect(f.events[0].input).toEqual({ trigger: "manual", custom_instructions: "Keep exact paths" })
  const archived = await plan.commitArchive!(signal)
  await f.agent.updateState(
    f.config,
    {
      ...archived.update,
      messages: [new RemoveMessage({ id: "__remove_all__" }), ...archived.messages]
    },
    "model_request"
  )
  await f.saver.flushStrict()
  const committedCheckpoint = await f.saver.getTuple(f.config)
  expect(
    hasSameCompactionEvidence(committedCheckpoint?.checkpoint.channel_values, archived.update)
  ).toBe(true)
  expect(
    hasSameCompactionEvidence(
      {
        ...committedCheckpoint?.checkpoint.channel_values,
        _cmbSummarizationOwner: "other runtime"
      },
      archived.update
    )
  ).toBe(false)
  expect(
    hasSameCompactionEvidence(
      {
        ...committedCheckpoint?.checkpoint.channel_values,
        _summarizationEvent: { ...archived.update._summarizationEvent, cutoffIndex: 9999 }
      },
      archived.update
    )
  ).toBe(false)
  await plan.afterCommit?.(signal)
  await plan.afterCommit?.(signal)
  expect(f.events.map((event) => event.name)).toEqual(["PreCompact", "PostCompact"])
  expect(f.events[1].input).toEqual({ trigger: "manual", compact_summary: summary })
})

it("blocks manual compaction before archive creation and honors cancellation after preparation", async () => {
  const blocked = await fixture({ block: true })
  await expect(
    blocked.controller.prepare(
      { messages: blocked.messages, state: {} },
      "",
      new AbortController().signal
    )
  ).rejects.toThrow("Preserve the full conversation")
  expect(blocked.modelCall).not.toHaveBeenCalled()
  expect(await readdir(blocked.archives)).toEqual([])
  const f = await fixture()
  const abort = new AbortController()
  const plan = await f.controller.prepare({ messages: f.messages, state: {} }, "", abort.signal)
  if ("skip" in plan) throw Error(plan.skip)
  abort.abort(Error("cancelled before commit"))
  await expect(plan.commitArchive!(abort.signal)).rejects.toThrow("cancelled before commit")
  await plan.afterCommit?.(abort.signal)
  expect(f.events.map((event) => event.name)).toEqual(["PreCompact"])
  expect(await readdir(f.archives)).toEqual([])
})

it.each(["put", "flush"] as const)(
  "never publishes Post after SQLite %s failure",
  async (stage) => {
    const f = await fixture()
    if (stage === "put") {
      const put = f.saver.put.bind(f.saver)
      vi.spyOn(f.saver, "put").mockImplementation(async (config, checkpoint, metadata) => {
        if (checkpoint.channel_values._summarizationEvent) throw Error("checkpoint write failed")
        return put(config, checkpoint, metadata)
      })
    } else vi.spyOn(f.saver, "flushStrict").mockRejectedValue(Error("checkpoint flush failed"))
    await expect(f.agent.invoke({ messages: f.messages }, f.config)).rejects.toThrow(
      /checkpoint (write|flush) failed/
    )
    expect(f.events.map((event) => event.name)).toEqual(["PreCompact"])
  }
)

it("suppresses Post when an external checkpoint wins the race after the summary write", async () => {
  const f = await fixture()
  const put = f.saver.put.bind(f.saver)
  let raced = false
  vi.spyOn(f.saver, "put").mockImplementation(async (config, checkpoint, metadata) => {
    const result = await put(config, checkpoint, metadata)
    if (checkpoint.channel_values._summarizationEvent && !raced) {
      raced = true
      await put(config, { ...checkpoint, id: "ffffffff-ffff-ffff-ffff-ffffffffffff" }, metadata)
    }
    return result
  })
  await f.agent.invoke({ messages: f.messages }, f.config)
  expect(raced).toBe(true)
  expect(f.events.map((event) => event.name)).toEqual(["PreCompact"])
  expect((await f.saver.getTuple(f.config))?.checkpoint.id).toBe(
    "ffffffff-ffff-ffff-ffff-ffffffffffff"
  )
})

it("rejects a same-ID checkpoint replacement with changed compaction evidence", async () => {
  const f = await fixture()
  const put = f.saver.put.bind(f.saver)
  let replaced = false
  vi.spyOn(f.saver, "put").mockImplementation(async (config, checkpoint, metadata) => {
    const result = await put(config, checkpoint, metadata)
    const event = checkpoint.channel_values._summarizationEvent
    if (event && !replaced) {
      replaced = true
      await put(
        config,
        {
          ...checkpoint,
          channel_values: {
            ...checkpoint.channel_values,
            _summarizationEvent: { ...(event as object), cutoffIndex: 9999 }
          }
        },
        metadata
      )
    }
    return result
  })
  await f.agent.invoke({ messages: f.messages }, f.config)
  expect(replaced).toBe(true)
  expect(f.events.map((event) => event.name)).toEqual(["PreCompact"])
})

it("does not retry an already durable mutation when its Post observation read fails", async () => {
  const f = await fixture()
  const put = f.saver.put.bind(f.saver)
  const getTuple = f.saver.getTuple.bind(f.saver)
  let failObservation = false
  let observationFailed = false
  vi.spyOn(f.saver, "put").mockImplementation(async (config, checkpoint, metadata) => {
    const result = await put(config, checkpoint, metadata)
    if (checkpoint.channel_values._summarizationEvent && !observationFailed) failObservation = true
    return result
  })
  vi.spyOn(f.saver, "getTuple").mockImplementation(async (config) => {
    if (failObservation) {
      failObservation = false
      observationFailed = true
      throw Error("observation read failed")
    }
    return getTuple(config)
  })
  await expect(f.agent.invoke({ messages: f.messages }, f.config)).resolves.toBeTruthy()
  expect(observationFailed).toBe(true)
  expect(f.events.map((event) => event.name)).toEqual(["PreCompact"])
  expect((await getTuple(f.config))?.checkpoint.channel_values._summarizationEvent).toBeTruthy()
})

it("suppresses Post when the original turn is cancelled during the durable write", async () => {
  const f = await fixture()
  const abort = new AbortController()
  const put = f.saver.put.bind(f.saver)
  vi.spyOn(f.saver, "put").mockImplementation(async (config, checkpoint, metadata) => {
    const result = await put(config, checkpoint, metadata)
    if (checkpoint.channel_values._summarizationEvent) abort.abort(Error("original turn cancelled"))
    return result
  })
  await expect(
    f.agent.invoke({ messages: f.messages }, { ...f.config, signal: abort.signal })
  ).rejects.toThrow()
  expect(f.events.map((event) => event.name)).toEqual(["PreCompact"])
})

it("does not mistake a no-progress event upgrade for another compaction", async () => {
  const f = await fixture()
  const middleware = f.controller.middleware as unknown as {
    wrapModelCall: (request: unknown, handler: () => Promise<AIMessage>) => Promise<unknown>
  }
  const previousSummary = new HumanMessage({
    content: summary,
    additional_kwargs: { lc_source: "summarization" }
  })
  const result = await middleware.wrapModelCall(
    {
      messages: f.messages.slice(0, 2),
      state: {
        messages: f.messages.slice(0, 2),
        _summarizationEvent: { cutoffIndex: 1, summaryMessage: previousSummary, filePath: null }
      },
      tools: []
    },
    async () => new AIMessage("continued without summary")
  )
  expect(result).toBeInstanceOf(Command)
  expect(f.events).toEqual([])
  expect(f.modelCall).not.toHaveBeenCalled()
})
