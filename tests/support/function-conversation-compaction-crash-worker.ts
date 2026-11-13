import { readFileSync, writeFileSync } from "node:fs"
import { StatementSync } from "node:sqlite"
import { HumanMessage, RemoveMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import { createAgent, createMiddleware } from "langchain"
import { z } from "zod"
import type { RunnableConfig } from "@langchain/core/runnables"
import { openNativeSqliteDatabase } from "../../src/main/db/native-sqlite-adapter"
import { FunctionConversationStore, type FunctionConversationRef } from
  "../../src/main/db/function-conversation-store"
import { ModControlStore } from "../../src/main/mods/control-store"
import { SqlJsSaver } from "../../src/main/checkpointer/sqljs-saver"
import { createFunctionConversationIdleEditor } from
  "../../src/main/checkpointer/function-conversation-idle-editor"
import { createFunctionConversationMiddleware } from "../../src/main/agent/mods-conversation"
import { captureFunctionConversationCompactionSource, prepareFunctionConversationCompactionCommit,
  prepareFunctionConversationCompactionWrite, observeFunctionConversationCompactionWrite,
  acknowledgeFunctionConversationCompactionWrite, settleFunctionConversationCompactionAttempt,
  stageFunctionConversationCompactionWrites, assertFunctionConversationCompactionReadable,
  assertFunctionConversationCompactionWriteCurrent,
  functionConversationCompactionCanonicalCut, commitFunctionConversationCompactionBoundary,
  reconcileFunctionConversationCompaction, readFunctionConversationCompactionBoundary } from
  "../../src/main/checkpointer/function-conversation-compaction-boundary"

class ForbiddenModel extends BaseChatModel {
  _llmType() { return "compaction-recovery-must-not-call-provider" }
  bindTools(): this { return this }
  async _generate(): Promise<ChatResult> { throw Error("COMPACTION_MUST_NOT_REPLAY_MODEL") }
}

// This is an actual separate OS process. The exit calls deliberately bypass every finally
// and normal close to exercise WAL recovery at the original native transaction boundaries.
async function main() {
  const input = JSON.parse(readFileSync(process.argv[2], "utf8")) as {
    database: string; checkpoint: string; control: string; target: FunctionConversationRef
    config: RunnableConfig; stage: string; result: string; action: "write" | "recover" | "inspect-source"
  }
  const database = openNativeSqliteDatabase(input.database).database
  const saver = new SqlJsSaver(input.checkpoint, undefined, { maxRootCheckpoints: 1 })
  const control = new ModControlStore(input.control)
  const store = new FunctionConversationStore(database), signal = new AbortController().signal
  const mainTarget = store.findMain(input.target, () => signal.throwIfAborted())
  if (!mainTarget || mainTarget.conversationId !== input.target.conversationId ||
    mainTarget.logicalSessionId !== input.target.logicalSessionId || input.target.kind !== "main")
    throw Error("ACTUAL_CRASH_NATIVE_SOURCE_REQUIRED")
  const target = store.selectBranch(mainTarget, input.target.branchId, () => signal.throwIfAborted())
  const assertCurrent = () => { signal.throwIfAborted(); store.assertCurrent(target) }
  const binding = { target, checkpointThreadId: target.threadId,
    signal, assertCurrent }
  const host = { saver, store, control, database, binding }
  const crash = (stage: string) => { if (input.stage === stage) process.exit(73) }
  try {
    await saver.initialize()
    if (input.action === "inspect-source") {
      const source = await saver.readCompactionCheckpoint(input.config)
      const exists = database.exec(`SELECT 1 FROM sqlite_master WHERE type='table'
        AND name='function_conversation_compaction_commits'`)[0]?.values.length
      const journalCount = exists ? Number(database.exec(`SELECT COUNT(*) FROM
        function_conversation_compaction_commits WHERE json_extract(target,'$.conversationId')=?`,
        [target.conversationId])[0]?.values[0]?.[0]) : 0
      writeFileSync(input.result, JSON.stringify({ sourcePresent: Boolean(source), journalCount,
        pendingWriteCount: source?.tuple.pendingWrites?.length ?? 0 }))
      return
    }
    if (input.action === "recover") {
      const journal = database.exec(`SELECT record_json FROM function_conversation_compaction_commits
        WHERE target=? ORDER BY updated_at DESC LIMIT 1`, [JSON.stringify({
          threadId: target.threadId, workspace: target.workspace,
          incarnation: target.incarnation, checkpointNamespace: target.checkpointNamespace,
          logicalSessionId: target.logicalSessionId, conversationId: target.conversationId,
          branchId: target.branchId, kind: target.kind })])[0]?.values[0]?.[0]
      if (typeof journal !== "string") throw Error("ACTUAL_CRASH_JOURNAL_REQUIRED")
      const record = JSON.parse(journal)
      const destination = { configurable: { ...input.config.configurable,
        checkpoint_id: record.destination.checkpointId } }
      const result = await reconcileFunctionConversationCompaction(host, destination)
      const tuple = await saver.getTuple(destination)
      const boundary = tuple ? await readFunctionConversationCompactionBoundary(host, tuple) : undefined
      const cutHighWater = tuple ? store.readCheckpointRecoverySnapshot(target, {
        checkpointThreadId: target.threadId, checkpointIncarnation: target.incarnation,
        checkpointId: tuple.checkpoint.id }, assertCurrent).snapshot.cut.highWater : undefined
      writeFileSync(input.result, JSON.stringify({ result, boundary,
        cutHighWater,
        sourcePresent: Boolean(await saver.getTuple(input.config)),
        phase: JSON.parse(String(database.exec(`SELECT record_json FROM
          function_conversation_compaction_commits WHERE intent_id=?`, [record.intentId])
          [0]?.values[0]?.[0])).phase }))
      return
    }
    const before = await saver.getTuple(input.config)
    if (!before) throw Error("ACTUAL_CRASH_SOURCE_REQUIRED")
    const source = await captureFunctionConversationCompactionSource(host, input.config)
    const messages = [new HumanMessage({ content: "actual crash-safe summary",
      additional_kwargs: { lc_source: "summarization" } })]
    const update = { messages, _summarizationEvent: { cutoffIndex: 2, summaryMessage: messages[0] } }
    const commit = await prepareFunctionConversationCompactionCommit(source, update)
    const editor = createFunctionConversationIdleEditor(saver, store, binding,
      () => crash("checkpoint-committed"), {
        canonicalCut: () => functionConversationCompactionCanonicalCut(commit),
        prepared: receipt => { prepareFunctionConversationCompactionWrite(commit, receipt); crash("prepared") },
        observed: async receipt => { await observeFunctionConversationCompactionWrite(commit, receipt); crash("observed") },
        acknowledgement: (actual, id) => {
          acknowledgeFunctionConversationCompactionWrite(commit, actual, id)
          crash("ack-inside-transaction")
        },
        stageWrites: async (config, writes, taskId) => {
          await stageFunctionConversationCompactionWrites(commit, config, writes, taskId)
          crash("source-writes-staged")
        },
        assertReadable: () => assertFunctionConversationCompactionReadable(commit),
        assertWriteCurrent: () => assertFunctionConversationCompactionWriteCurrent(commit)
      })
    const graph = createAgent({ model: new ForbiddenModel({}), checkpointer: editor,
      middleware: [createFunctionConversationMiddleware({ store,
        capture: () => { throw Error("COMPACTION_MUST_NOT_REPLAY_INTAKE") } }),
      createMiddleware({ name: "actual-compaction-event-state",
        stateSchema: z.object({ _summarizationEvent: z.unknown().optional() }) })] })
    const saved = await graph.updateState(before.config, {
      ...update, messages: [new RemoveMessage({ id: "__remove_all__" }), ...messages]
    }, "model_request")
    settleFunctionConversationCompactionAttempt(commit)
    crash("ack-persisted")
    if (input.stage === "ledger-persisted") {
      const originalRun = StatementSync.prototype.run
      StatementSync.prototype.run = function (this: StatementSync, ...args: Parameters<StatementSync["run"]>) {
        const result = Reflect.apply(originalRun, this, args)
        // Test-only exit after the real control database statement has committed. The
        // original prepared SQL, data and every native reader/proof remain unchanged.
        if (args[0] === `host-compaction-boundary:${target.threadId}`) process.exit(73)
        return result
      }
    }
    await commitFunctionConversationCompactionBoundary(source, saved)
    writeFileSync(input.result, JSON.stringify({ result: "ready" }))
  } finally {
    await saver.close()
    control.close()
    database.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
