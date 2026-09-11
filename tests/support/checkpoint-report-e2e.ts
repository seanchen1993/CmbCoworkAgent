import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Page } from "playwright"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import type { Message } from "../../src/main/types"

const IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
const DEEP_ARGS = { a: { b: { c: { d: { e: { f: { value: 42 } } } } } } }
const ERROR_TEXT = "本地会话消息索引不完整，自动恢复失败"
type Kind = "multimodal" | "intact-lossy" | "legacy-timing" | "lossy" | "unknown"
interface Fixture {
  kind: Kind
  threadId: string
  title: string
  prompt: string
  reply: string
  finalHistory: string
  checkpointPath: string
  checkpointId: string
  startAt: number
  endAt: number
}

export interface CheckpointReportE2e {
  replyForRequest: (body: Record<string, unknown>) => string | undefined
  exercise: (
    page: Page,
    send: (page: Page, prompt: string, reply: string) => Promise<number>,
    ready: (page: Page) => Promise<void>
  ) => Promise<void>
  verifyAfterClose: () => Promise<void>
}

export async function seedCheckpointReportE2e(
  workspace: string,
  modelRef: string
): Promise<CheckpointReportE2e> {
  // The parent runner installs an isolated home before importing application storage.
  const db = await import("../../src/main/db/index")
  const { getDbPath, getThreadCheckpointPath } = await import("../../src/main/storage")
  const { SqlJsSaver } = await import("../../src/main/checkpointer/sqljs-saver")
  const { bootstrapLegacyCheckpointTranscript } =
    await import("../../src/main/checkpointer/runtime-projection-store")
  const { AIMessage, HumanMessage, ToolMessage } = await import("@langchain/core/messages")
  const fixtures: Fixture[] = []
  const requests = new Map<Kind, Record<string, unknown>[]>()
  await db.initializeDatabase()
  const messageDatabasePath = getDbPath()
  try {
    for (const kind of [
      "multimodal",
      "intact-lossy",
      "legacy-timing",
      "lossy",
      "unknown"
    ] as const) {
      const key = randomUUID()
      const threadId = `checkpoint-report-${kind}-${key}`
      const title = `Checkpoint ${kind} ${key.slice(0, 8)}`
      const prompt = `REPORT_${kind}_${key}`
      const reply = `REPORT_OK_${kind}_${key}`
      const finalHistory = `report-history-${kind}-${key}`
      const startAt = Date.now() - 120_000
      const endAt = startAt + 10_000
      const checkpointId = `cp-report-${key}`
      db.createThread(threadId, {
        title,
        workspacePath: workspace,
        model: modelRef,
        agentMode: "normal"
      })
      const userContent =
        kind === "multimodal"
          ? [
              { type: "text", text: `image-${key}` },
              { type: "image_url", image_url: { url: IMAGE } }
            ]
          : `question-${key}`
      const toolCalls = [{ id: `tool-${key}`, name: "audit_inspect", args: DEEP_ARGS }]
      const runtimeMessages = [
        new HumanMessage({ id: `user-${key}`, content: userContent }),
        ...(kind === "lossy" || kind === "intact-lossy"
          ? [
              new AIMessage({ id: `call-${key}`, content: "", tool_calls: toolCalls }),
              new ToolMessage({
                id: `result-${key}`,
                content: "already completed",
                tool_call_id: `tool-${key}`
              })
            ]
          : []),
        new AIMessage({ id: `answer-${key}`, content: finalHistory })
      ]
      if (kind !== "legacy-timing") {
        db.upsertThreadMessages(
          threadId,
          runtimeMessages.map((message, index) => ({
            id: message.id!,
            role:
              message.getType() === "human"
                ? "user"
                : message.getType() === "tool"
                  ? "tool"
                  : "assistant",
            content: message.content as Message["content"],
            ...(message instanceof AIMessage && message.tool_calls?.length
              ? { tool_calls: message.tool_calls as Message["tool_calls"] }
              : {}),
            ...(message instanceof ToolMessage ? { tool_call_id: message.tool_call_id } : {}),
            created_at: new Date(startAt + index)
          }))
        )
      }
      if (kind === "unknown") {
        db.getDb().run("UPDATE thread_messages SET recovery_integrity = NULL WHERE thread_id = ?", [
          threadId
        ])
      }
      const checkpointPath = getThreadCheckpointPath(threadId)
      const checkpoint = {
        v: 1,
        id: checkpointId,
        ts: new Date(endAt + 1000).toISOString(),
        channel_values: { messages: runtimeMessages, todos: [] },
        channel_versions: { messages: 1 },
        versions_seen: {},
        pending_sends: []
      } as Checkpoint
      const metadata = {
        source: "loop",
        step: 1,
        writes: {},
        parents: {},
        cmb_fork_boundary: {
          source: "agent_run_complete",
          outcome: "completed",
          markedAt: checkpoint.ts
        }
      } as CheckpointMetadata
      const saver = new SqlJsSaver(checkpointPath)
      await saver.put(
        { configurable: { thread_id: threadId, checkpoint_ns: "" } },
        checkpoint,
        metadata
      )
      const [type, payload] = await saver.serde.dumpsTyped(checkpoint)
      await saver.close()
      const raw = new DatabaseSync(checkpointPath)
      try {
        if (kind === "legacy-timing") {
          raw.prepare("UPDATE checkpoints SET type = ?, checkpoint = ?").run(type, payload)
          raw.exec(
            "DELETE FROM checkpoint_message_snapshots; DELETE FROM checkpoint_runtime_projections"
          )
        } else if (kind !== "intact-lossy") {
          raw.exec("DELETE FROM checkpoint_message_snapshots")
        }
      } finally {
        raw.close()
      }
      if (kind === "legacy-timing") {
        // Simulate an older completed import, then a compact values write before the repair opens it.
        bootstrapLegacyCheckpointTranscript(
          checkpointPath,
          messageDatabasePath,
          threadId,
          "",
          new SharedArrayBuffer(4)
        )
        db.updateThread(threadId, {
          thread_values: JSON.stringify({
            messageTimes: {
              [`user-${key}`]: {
                start_at: new Date(startAt).toISOString(),
                end_at: new Date(startAt).toISOString()
              },
              [`answer-${key}`]: {
                start_at: new Date(startAt).toISOString(),
                end_at: new Date(endAt).toISOString()
              }
            }
          })
        })
        db.mergeThreadValues(threadId, { todos: [] })
      } else {
        db.getDb().run(
          `INSERT INTO legacy_checkpoint_transcript_migrations
          (thread_id, checkpoint_id, total_messages, next_index, current_fragment_index, status, updated_at)
          VALUES (?, ?, ?, ?, 0, 'complete', ?)`,
          [threadId, checkpointId, runtimeMessages.length, runtimeMessages.length, Date.now()]
        )
      }
      fixtures.push({
        kind,
        threadId,
        title,
        prompt,
        reply,
        finalHistory,
        checkpointPath,
        checkpointId,
        startAt,
        endAt
      })
    }
  } finally {
    await db.closeDatabase()
  }

  const assertTiming = (fixture: Fixture) => {
    const raw = new DatabaseSync(messageDatabasePath, { readOnly: true })
    try {
      const answer = raw
        .prepare(
          "SELECT start_at, end_at FROM thread_messages WHERE thread_id = ? AND content_json = ?"
        )
        .get(fixture.threadId, JSON.stringify(fixture.finalHistory))
      assert.equal(answer?.start_at, fixture.startAt)
      assert.equal(answer?.end_at, fixture.endAt)
      assert.equal(Number(answer.end_at) - Number(answer.start_at), 10_000)
    } finally {
      raw.close()
    }
  }
  return {
    replyForRequest(body) {
      const serialized = JSON.stringify(body)
      const fixture = fixtures.find((candidate) => serialized.includes(candidate.prompt))
      if (!fixture) return undefined
      const records = requests.get(fixture.kind) ?? []
      records.push(body)
      requests.set(fixture.kind, records)
      return fixture.reply
    },
    async exercise(page, send, ready) {
      for (const fixture of fixtures) {
        if ((await page.getByText(fixture.title, { exact: true }).count()) === 0) {
          await page
            .getByRole("button", { name: /展开显示/ })
            .first()
            .click()
        }
        await page.getByText(fixture.title, { exact: true }).first().click()
        await ready(page)
        await page
          .getByText(fixture.finalHistory, { exact: true })
          .last()
          .waitFor({ timeout: 30_000 })
        // The page paints before UAT's ancillary hydration mounts its stream holder.
        await page.waitForTimeout(1_000)
        if (fixture.kind === "lossy" || fixture.kind === "unknown") {
          const composer = page.locator(".composer-textarea")
          await composer.fill(fixture.prompt)
          await composer
            .locator("xpath=ancestor::form")
            .locator('button[type="submit"]')
            .last()
            .click()
          await page.getByText(ERROR_TEXT, { exact: false }).last().waitFor({ timeout: 30_000 })
          await ready(page)
          assert.equal(
            requests.get(fixture.kind)?.length ?? 0,
            0,
            `${fixture.kind} must fail before model execution`
          )
        } else {
          await send(page, fixture.prompt, fixture.reply)
          const records = requests.get(fixture.kind) ?? []
          assert.equal(records.length, 1, `${fixture.kind} model requests`)
          if (fixture.kind === "multimodal") {
            assert.ok(
              JSON.stringify(records[0]).includes(IMAGE),
              "model receives the recovered image"
            )
          }
          if (fixture.kind === "intact-lossy") {
            const messages = records[0].messages as Array<{
              tool_calls?: Array<{ function: { arguments: string } }>
            }>
            const call = messages.flatMap((message) => message.tool_calls ?? [])[0]
            assert.deepEqual(
              JSON.parse(call.function.arguments),
              DEEP_ARGS,
              "intact checkpoint keeps exact deep arguments"
            )
          }
          if (fixture.kind === "legacy-timing") {
            assertTiming(fixture)
            await page.getByText("耗时 10s", { exact: true }).first().waitFor({ timeout: 10_000 })
          }
        }
        const artifactDirectory = process.env.CMB_SESSION_RECOVERY_E2E_ARTIFACT_DIR
        if (artifactDirectory) {
          mkdirSync(artifactDirectory, { recursive: true })
          await page.screenshot({ path: join(artifactDirectory, `${fixture.kind}.png`) })
        }
        console.log(`[checkpoint-report-e2e] PASS ${fixture.kind}`)
      }
    },
    async verifyAfterClose() {
      for (const fixture of fixtures) {
        if (fixture.kind === "lossy" || fixture.kind === "unknown") {
          const raw = new DatabaseSync(fixture.checkpointPath, { readOnly: true })
          try {
            assert.equal(
              raw
                .prepare(
                  "SELECT COUNT(*) AS count FROM checkpoint_message_snapshots WHERE checkpoint_id = ?"
                )
                .get(fixture.checkpointId)?.count,
              0,
              "rejected recovery must not replace the broken snapshot"
            )
          } finally {
            raw.close()
          }
        } else {
          const saver = new SqlJsSaver(fixture.checkpointPath)
          try {
            const tuple = await saver.getTuple({
              configurable: { thread_id: fixture.threadId, checkpoint_ns: "" }
            })
            assert.ok(tuple)
            if (fixture.kind === "multimodal")
              assert.ok(JSON.stringify(tuple.checkpoint.channel_values.messages).includes(IMAGE))
            if (fixture.kind === "legacy-timing") assertTiming(fixture)
          } finally {
            await saver.close()
          }
        }
      }
    }
  }
}
