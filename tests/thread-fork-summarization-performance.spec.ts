/**
 * Benchmark the actual fork handler and the first model request on both revisions.
 *
 * Run on the base checkout: npx tsx tests/thread-fork-summarization-performance.spec.ts baseline
 * Run on the fixed checkout: npx tsx tests/thread-fork-summarization-performance.spec.ts fixed
 * Set FORK_BENCHMARK_REPETITIONS to increase the sample count (default 3).
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { setTimeout as delay } from "node:timers/promises"
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"

const ROW_COUNT = 20_000
const BOUNDARY_COUNT = 6
const RETAINED_TAIL = 40
const APPEND_DATE = Date.UTC(2026, 0, 1)
const ORIGINAL_SUMMARY = "BENCHMARK_INHERITED_SUMMARY"
const FIRST_MESSAGE = "BENCHMARK_FIRST_RAW_MESSAGE"
const FAKE_SUMMARY = "BENCHMARK_NEW_SUMMARY"
const FOLLOWUP = "Continue with the next benchmark turn"
const BODY = "Review the synthetic project and preserve its result for the next turn. ".repeat(2)
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024

type Scenario = "compressed" | "uncompressed"
type Revision = "baseline" | "fixed"
type Timing = {
  elapsedMs: number
  eventLoopP95Ms: number
  eventLoopMaxMs: number
  rssDeltaMiB: number
}
type Request = { messages: BaseMessage[]; state: Record<string, unknown>; tools: unknown[] }
type Continuation = {
  summaryCalls: number
  summaryInputBytes: number
  mainInputBytes: number
  mainMessages: number
}
type Sample = {
  scenario: Scenario
  fork: Timing
  continuation: Timing & Continuation
  archiveBytes: number
}

function seedMessages(): BaseMessage[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => {
    const id = "bench-message-" + index
    const content = index === 0 ? FIRST_MESSAGE + " " + BODY : `Turn ${index}: ${BODY}`
    return index % 2 === 0
      ? new HumanMessage({ id, content })
      : new AIMessage({
          id,
          content,
          // This usage predates the fork and describes the original, expanded input.
          ...(index === ROW_COUNT - 1 && {
            usage_metadata: { input_tokens: 900_000, output_tokens: 50, total_tokens: 900_050 }
          })
        })
  })
}

function savedSummary(filePath: string, boundary: number): HumanMessage {
  // Match the generated persisted form on the base revision, where its builder is private.
  const transcriptNotice =
    `A text transcript of the earlier conversation has been saved to ${filePath} should you ` +
    "need to refer back to it for details. Structured media and binary payloads may be " +
    "represented by placeholders."
  return new HumanMessage({
    content:
      "You are in the middle of a conversation that has been summarized.\n\n" +
      transcriptNotice +
      "\n\n\nA condensed summary follows:\n\n<summary>\n" +
      `${ORIGINAL_SUMMARY} at boundary ${boundary}\n</summary>`,
    additional_kwargs: { lc_source: "summarization" }
  })
}

function checkpointConfig(threadId: string, parentId?: string) {
  return { configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: parentId } }
}

function percentile(samples: readonly number[], p: number): number {
  assert(samples.length > 0)
  const ordered = [...samples].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(ordered.length * p) - 1)
  return Number(ordered[index].toFixed(2))
}

async function measure<T>(work: () => Promise<T>): Promise<{ result: T; timing: Timing }> {
  const histogram = monitorEventLoopDelay({ resolution: 5 })
  histogram.enable()
  await delay(15)
  histogram.reset()
  const initialRss = process.memoryUsage.rss()
  let peakRss = initialRss
  const sampleRss = () => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss())
  }
  const timer = setInterval(sampleRss, 5)
  const start = performance.now()
  try {
    const result = await work()
    const elapsedMs = performance.now() - start
    sampleRss()
    // Let a timer delayed by synchronous work in the final batch report its delay.
    await delay(10)
    return {
      result,
      timing: {
        elapsedMs,
        eventLoopP95Ms: histogram.percentile(95) / 1e6,
        eventLoopMaxMs: histogram.max / 1e6,
        rssDeltaMiB: (peakRss - initialRss) / (1024 * 1024)
      }
    }
  } finally {
    clearInterval(timer)
    histogram.disable()
  }
}

function contentBytes(messages: BaseMessage[]): number {
  return messages.reduce((total, message) => {
    const text =
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    return total + Buffer.byteLength(text)
  }, 0)
}

async function benchmark(revision: Revision, repetitions: number, fixtureRoot: string) {
  // Import the stores after pointing them at the disposable data root.
  const db = await import("../src/main/db/index")
  const storage = await import("../src/main/storage")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver")
  const { closeCheckpointer, closeRuntime } = await import("../src/main/agent/runtime")
  const { forkThread } = await import("../src/main/ipc/threads")
  const { createCmbSummarizationMiddleware } =
    await import("../src/main/agent/context-summarization-middleware")
  const { deleteProjectThreadDataDirectory, getConversationHistoryDirectory } =
    await import("../src/main/agent/context-history-path")
  const { setLegacySubagentMigrationParserForTests } =
    await import("../src/main/legacy-subagent-migration/coordinator")
  const restoreMigrationParser = setLegacySubagentMigrationParserForTests({
    async parse() {
      return {
        finalization: "absent",
        inputBytes: 0,
        batchCount: 0,
        rowCount: 0,
        maxBatchBytes: 0,
        maxResponseBytes: 0
      }
    }
  })
  const workspacePath = join(fixtureRoot, "workspace")
  const threadIds: Record<Scenario, string> = {
    compressed: "benchmark-compressed",
    uncompressed: "benchmark-uncompressed"
  }

  async function seed(scenario: Scenario, messages: BaseMessage[]): Promise<number> {
    const threadId = threadIds[scenario]
    db.createThread(threadId, { title: scenario, workspacePath, agentMode: "normal" })
    for (let start = 0; start < messages.length; start += 128) {
      const page = messages.slice(start, start + 128).map((message, offset) => ({
        id: message.id!,
        role: AIMessage.isInstance(message) ? ("assistant" as const) : ("user" as const),
        content: String(message.content),
        created_at: new Date(APPEND_DATE + start + offset)
      }))
      db.upsertThreadMessages(threadId, page, { preserveExistingOrder: true })
    }

    const archiveDir = await getConversationHistoryDirectory(workspacePath, threadId)
    const sessionId = "benchmark_source_session"
    const filePath = join(archiveDir, sessionId + ".md")
    if (scenario === "compressed") {
      await mkdir(archiveDir, { recursive: true })
      await writeFile(filePath, "The source archive must not be copied.\n")
    }
    const saver = new SqlJsSaver(storage.getThreadCheckpointPath(threadId), undefined, {
      maxRootCheckpoints: 3,
      maxRootForkBoundaryCheckpoints: 30
    })
    try {
      let parentId: string | undefined
      for (let index = 0; index < BOUNDARY_COUNT; index += 1) {
        const id = "bench-checkpoint-" + index
        const count = ROW_COUNT - (BOUNDARY_COUNT - index - 1) * 600
        const summaryState =
          scenario === "compressed"
            ? {
                _summarizationSessionId: sessionId,
                _summarizationEvent: {
                  cutoffIndex: count - RETAINED_TAIL,
                  filePath,
                  summaryMessage: savedSummary(filePath, index)
                }
              }
            : {}
        const checkpoint = {
          v: 1,
          id,
          ts: new Date(APPEND_DATE + count).toISOString(),
          channel_values: { messages: messages.slice(0, count), ...summaryState },
          channel_versions: { messages: index + 1 },
          versions_seen: {},
          pending_sends: []
        } as Checkpoint
        const metadata = {
          source: "loop",
          step: index,
          writes: {},
          parents: {},
          cmb_fork_boundary: {
            kind: "turn_complete",
            outcome: "completed",
            checkpointId: id,
            lastVisibleMessageId: messages[count - 1].id
          }
        } as CheckpointMetadata
        await saver.put(checkpointConfig(threadId, parentId), checkpoint, metadata)
        parentId = id
      }
      await saver.flushStrict()
      const retainedIds: string[] = []
      for await (const tuple of saver.list(checkpointConfig(threadId))) {
        retainedIds.push(tuple.checkpoint.id)
      }
      assert.equal(retainedIds[0], parentId, "the latest seeded checkpoint must be retained")
      return retainedIds.length
    } finally {
      await saver.close()
    }
  }

  async function countArchiveBytes(threadId: string, inheritsSummary: boolean): Promise<number> {
    const directory = await getConversationHistoryDirectory(workspacePath, threadId)
    const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    assert.equal(files.length, inheritsSummary ? 1 : 0, "wrong number of fork archive files")
    if (files.length === 0) return 0
    assert(files[0].endsWith(".md"), "archive should be fully published before fork returns")
    const archiveBytes = (await stat(join(directory, files[0]))).size
    assert(archiveBytes > 0 && archiveBytes <= MAX_ARCHIVE_BYTES)
    return archiveBytes
  }

  async function continueFork(
    threadId: string,
    inheritsSummary: boolean
  ): Promise<{ result: Continuation; timing: Timing }> {
    const saver = new SqlJsSaver(storage.getThreadCheckpointPath(threadId))
    let restoredState: Record<string, unknown>
    try {
      const tuple = await saver.getTuple(checkpointConfig(threadId))
      assert(tuple, "fork checkpoint must be restorable")
      restoredState = tuple.checkpoint.channel_values
    } finally {
      await saver.close()
    }
    assert(Array.isArray(restoredState.messages))
    assert.equal(restoredState.messages.length, ROW_COUNT)
    assert.equal(Boolean(restoredState._summarizationEvent), inheritsSummary)
    const summaryInputs: number[] = []
    let mainInputBytes = 0
    let mainMessages = 0
    const middleware = createCmbSummarizationMiddleware({
      model: {
        profile: { maxInputTokens: 64_000 },
        async invoke(messages: BaseMessage[]) {
          summaryInputs.push(contentBytes(messages))
          assert(String(messages[1]?.content).includes(FIRST_MESSAGE))
          return new AIMessage(
            `## Goal\n${FAKE_SUMMARY}.\n## Current State\nReview complete.\n` +
              "## Next Step\nContinue from the last turn."
          )
        }
      } as never,
      backend: { write: async (path: string) => ({ path }) } as never,
      trigger: { type: "tokens", value: 16_000 },
      keep: { type: "messages", value: RETAINED_TAIL + 1 },
      maxInputTokens: 64_000
    }) as unknown as {
      wrapModelCall: (
        request: Request,
        handler: (request: Request) => Promise<AIMessage>
      ) => Promise<unknown>
    }
    const request = {
      messages: [...restoredState.messages, new HumanMessage(FOLLOWUP)],
      state: restoredState,
      tools: []
    }
    return measure(async () => {
      await middleware.wrapModelCall(request, async (wrapped) => {
        mainMessages = wrapped.messages.length
        mainInputBytes = contentBytes(wrapped.messages)
        assert(
          String(wrapped.messages[0]?.content).includes(
            inheritsSummary ? ORIGINAL_SUMMARY : FAKE_SUMMARY
          )
        )
        assert.equal(wrapped.messages.at(-1)?.content, FOLLOWUP)
        return new AIMessage("Benchmark continuation")
      })
      assert.equal(summaryInputs.length, inheritsSummary ? 0 : 1)
      assert.equal(mainMessages, RETAINED_TAIL + 2)
      return {
        summaryCalls: summaryInputs.length,
        summaryInputBytes: summaryInputs.reduce((total, bytes) => total + bytes, 0),
        mainInputBytes,
        mainMessages
      }
    })
  }

  async function runCase(scenario: Scenario): Promise<Sample> {
    const sourceThreadId = threadIds[scenario]
    await closeCheckpointer(sourceThreadId)
    const { result, timing: fork } = await measure(() => forkThread({ sourceThreadId }))
    const threadId = result.thread.thread_id
    try {
      const inheritsSummary = revision === "fixed" && scenario === "compressed"
      const archiveBytes = await countArchiveBytes(threadId, inheritsSummary)
      const { result: continuation, timing } = await continueFork(threadId, inheritsSummary)
      return { scenario, fork, archiveBytes, continuation: { ...continuation, ...timing } }
    } finally {
      await closeCheckpointer(threadId)
      db.deleteThread(threadId)
      storage.deleteThreadCheckpoint(threadId)
      await deleteProjectThreadDataDirectory(workspacePath, threadId)
    }
  }

  try {
    await mkdir(workspacePath)
    await db.initializeDatabase()
    // Seed generation and disk writes are excluded from both measured phases.
    const rows = seedMessages()
    const retained = {
      compressed: await seed("compressed", rows),
      uncompressed: await seed("uncompressed", rows)
    }
    assert.deepEqual(retained, { compressed: BOUNDARY_COUNT, uncompressed: BOUNDARY_COUNT })
    rows.length = 0

    await runCase("compressed")
    await runCase("uncompressed")
    const samples: Sample[] = []
    for (let index = 0; index < repetitions; index += 1) {
      const scenarios: Scenario[] =
        index % 2 === 0 ? ["compressed", "uncompressed"] : ["uncompressed", "compressed"]
      for (const scenario of scenarios) samples.push(await runCase(scenario))
    }
    console.log(
      JSON.stringify(
        {
          revision,
          node: process.version,
          rows: ROW_COUNT,
          retainedBoundaries: retained,
          repetitions,
          samples,
          statistics: summarize(samples)
        },
        null,
        2
      )
    )
  } finally {
    restoreMigrationParser()
    await closeRuntime()
    await db.closeDatabase()
  }
}

function summarize(samples: Sample[]) {
  return (["compressed", "uncompressed"] as const).map((scenario) => {
    const matches = samples.filter((sample) => sample.scenario === scenario)
    const phases = (["fork", "continuation"] as const).map((phase) => {
      const timings = matches.map((sample) => sample[phase])
      const durations = timings.map((timing) => timing.elapsedMs)
      return {
        phase,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        maxEventLoopDelayMs: percentile(
          timings.map((timing) => timing.eventLoopMaxMs),
          1
        ),
        maxSampledRssDeltaMiB: percentile(
          timings.map((timing) => timing.rssDeltaMiB),
          1
        )
      }
    })
    return {
      scenario,
      phases,
      archiveBytes: matches[0].archiveBytes,
      summaryCalls: matches[0].continuation.summaryCalls,
      summaryInputBytes: matches[0].continuation.summaryInputBytes,
      mainInputBytes: matches[0].continuation.mainInputBytes
    }
  })
}

async function main(): Promise<void> {
  const revision = process.argv[2]
  assert(revision === "baseline" || revision === "fixed", "pass baseline or fixed")
  const repetitions = Number(process.env.FORK_BENCHMARK_REPETITIONS ?? 3)
  assert(Number.isSafeInteger(repetitions) && repetitions > 0 && repetitions <= 50)
  const fixtureRoot = await mkdtemp(join(tmpdir(), "cmb-fork-summarization-bench-"))
  const env = ["HOME", "USERPROFILE", "CMB_COWORK_AGENT_HOME"] as const
  const previous = env.map((key) => process.env[key])
  try {
    process.env.HOME = fixtureRoot
    process.env.USERPROFILE = fixtureRoot
    process.env.CMB_COWORK_AGENT_HOME = join(fixtureRoot, ".cmbcoworkagent")
    await benchmark(revision, repetitions, fixtureRoot)
  } finally {
    for (const [index, key] of env.entries()) {
      const value = previous[index]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(fixtureRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
