import assert from "node:assert/strict"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { BaseMessage } from "@langchain/core/messages"
import {
  registerPartnerInputOnlyImplementation,
  startAgentRun
} from "../../src/main/agent/agent-run-service"
import { createInputOnlyRequirementImplementation } from "../../src/main/services/bot/input-only-requirement-run"
import {
  PartnerFakeRequirementModel,
  PARTNER_FAKE_MODEL_REF
} from "../../src/main/services/bot/partner-fake-model"
import { PartnerDevController } from "../../src/main/services/bot/partner-dev-controller"
import type { PartnerConnectionDescriptor } from "../../src/main/services/bot/partner-local-client"
import type { PartnerLocalConfig } from "../../src/main/services/bot/partner-local-config"
import { PartnerRequirementExecutor } from "../../src/main/services/bot/requirement-executor"
import { PartnerTaskThreadStore } from "../../src/main/services/bot/task-thread-store"
import { PartnerRequirementAttemptStore } from "../../src/main/services/bot/requirement-attempt-store"
import { delivery, withSqlite } from "./requirement-execution-fixture"
import type { PartnerDevRunView } from "../../src/shared/bot/partner-dev"

/** Owned MySQL + actual Java HTTP/App worker/SQLite/DeepAgent, fake model only. */
async function main() {
  const helper = (await import(
    pathToFileURL(resolve("deploy/dev/service/partner-http.mjs")).href
  )) as {
    withPartnerHttpFixture(
      callback: (fixture: { descriptor: PartnerConnectionDescriptor }) => Promise<void>,
      options: { signal: AbortSignal }
    ): Promise<void>
    stopPartnerChildren(): Promise<void>
  }
  const abort = new AbortController(),
    stop = () => abort.abort(),
    timer = setTimeout(stop, 240000)
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  let models = 0,
    block = false,
    signal: AbortSignal | undefined
  const prompts: string[] = []
  try {
    await helper.withPartnerHttpFixture(
      async (fixture) => {
        await withSqlite(async (db) => {
          class Fake extends PartnerFakeRequirementModel {
            override bindTools(tools: unknown[]) {
              assert.equal(tools.length, 0)
              return super.bindTools(tools)
            }
            override async _generate(messages: BaseMessage[]) {
              models++
              prompts.push(
                messages
                  .map((m) =>
                    typeof m.content === "string" ? m.content : JSON.stringify(m.content)
                  )
                  .join("\n")
              )
              if (block)
                await new Promise<void>((resolve) => {
                  if (signal?.aborted) resolve()
                  else signal?.addEventListener("abort", () => resolve(), { once: true })
                })
              return super._generate(messages)
            }
          }
          registerPartnerInputOnlyImplementation(
            createInputOnlyRequirementImplementation({
              resolveThread(id) {
                const metadata = JSON.parse(
                  String(
                    db.exec("SELECT metadata FROM threads WHERE thread_id=?", [id])[0].values[0][0]
                  )
                )
                return { metadata, workspacePath: metadata.workspacePath }
              },
              resolveModel(ref) {
                assert.equal(ref, PARTNER_FAKE_MODEL_REF)
                return new Fake({})
              }
            })
          )
          let saved: PartnerLocalConfig | null = null
          const store = {
            async load() {
              return structuredClone(saved)
            },
            async save(c: PartnerLocalConfig) {
              saved = structuredClone(c)
            }
          }
          const controller = new PartnerDevController({
            store,
            createExecutor(config, client) {
              return new PartnerRequirementExecutor({
                config: {
                  spaceId: config.descriptor.spaceId,
                  nodeId: config.descriptor.nodeId,
                  ownerPrincipalId: config.descriptor.ownerPrincipalId,
                  modelRef: PARTNER_FAKE_MODEL_REF,
                  workspaces: new Map([[config.descriptor.workspaceRef, config.workspacePath!]])
                },
                control: client,
                threads: new PartnerTaskThreadStore(db),
                attempts: new PartnerRequirementAttemptStore(db),
                delivery,
                startRun: (request, target, context) => {
                  signal = context?.signal
                  return startAgentRun(request, target, context)
                }
              })
            }
          })
          const wait = async <T>(
            read: () => Promise<T>,
            ready: (value: T) => boolean
          ): Promise<T> => {
            const until = Date.now() + 20000
            while (!abort.signal.aborted && Date.now() < until) {
              const value = await read()
              if (ready(value)) return value
              await new Promise((resolve) => setTimeout(resolve, 60))
            }
            throw Error("MEMORY_JOURNEY_WAIT")
          }
          const run = async (number: string): Promise<PartnerDevRunView> => {
            const queued = await controller.analyzeTask(number)
            assert.ok(queued.runId)
            return wait(
              () => controller.inspectRun(queued.runId!),
              (value) => value.status === "succeeded"
            )
          }
          try {
            await controller.importDescriptor(fixture.descriptor)
            await controller.setWorkspace("/explicit-memory-owner-workspace")
            await controller.connect()
            await controller.createTeam("领域专家", "仅使用明确任务与本团队已确认记忆", true)
            const first = await controller.sendMessage(true, "新任务：确认交易日查询规则")
            const source = {
              kind: "task" as const,
              taskId: first.taskId!,
              taskVersion: first.taskVersion!
            }
            const publication = await controller.createMemory({
              text: "MEMORY_SENTINEL_TPLUS1：交易数据采用T+1",
              source
            })
            assert.equal(publication.revision, 1)
            assert.equal(publication.botPolicies[0].memoryPolicy, "explicit_only")
            await controller.authorizeTeam()
            await controller.enableNode()
            const one = await run(first.taskNumber!)
            assert.equal(one.memorySnapshot?.revision, 1)
            assert.equal(one.memorySnapshot?.memories[0].version, 1)
            assert.match(prompts[0], /MEMORY_SENTINEL_TPLUS1/)
            const second = await controller.sendMessage(true, "新任务：同产品的第二项查询需求")
            const two = await run(second.taskNumber!)
            assert.equal(two.memorySnapshot?.memories[0].id, publication.memories[0].id)
            assert.match(prompts[1], /MEMORY_SENTINEL_TPLUS1/)
            assert.equal(models, 2)
            const memory = publication.memories[0]
            const updated = await controller.updateMemory({
              memoryId: memory.id,
              expectedVersion: 1,
              text: "MEMORY_SENTINEL_TPLUS2：已核实日切规则",
              source,
              status: "active"
            })
            assert.equal(updated.revision, 2)
            block = true
            const third = await controller.sendMessage(true, "新任务：等待执行的第三项需求"),
              queued = await controller.analyzeTask(third.taskNumber!)
            await wait(
              () => controller.inspectRun(queued.runId!),
              (value) => value.status === "running" && models === 3
            )
            assert.match(prompts[2], /MEMORY_SENTINEL_TPLUS2/)
            const disabled = await controller.disableMemory(memory.id, 2)
            assert.equal(disabled.revision, 3)
            const failed = await wait(
              () => controller.inspectRun(queued.runId!),
              (value) => value.status === "failed"
            )
            assert.equal(failed.result?.text, "MEMORY_CHANGED")
            assert.equal(failed.memorySnapshot?.revision, 2)
            await wait(
              () => controller.getStatus(),
              (value) => value.activeRunId === null
            )
            assert.equal(models, 3)
            block = false
            const fourth = await controller.sendMessage(true, "新任务：停用记忆后的新需求"),
              four = await run(fourth.taskNumber!)
            assert.equal(four.memorySnapshot?.revision, 3)
            assert.equal(four.memorySnapshot?.memories.length, 0)
            assert.ok(!/MEMORY_SENTINEL_TPLUS[12]/.test(prompts[3]))
            assert.equal(models, 4)
            await controller.stopNode()
            await controller.disconnect()
            // An entirely fresh Runtime SQLite cannot remove authoritative team memory.
            await withSqlite(async (empty) => {
              assert.equal(empty.exec("SELECT COUNT(*) FROM threads")[0].values[0][0], 0)
              const reopened = new PartnerDevController({
                store,
                createExecutor: () => {
                  throw Error("reopen must not execute")
                }
              })
              try {
                assert.equal((await reopened.getStatus()).connected, false)
                await reopened.connect()
                const persisted = await reopened.listMemories()
                assert.equal(persisted.revision, 3)
                assert.equal(persisted.memories[0].status, "disabled")
                assert.equal((await reopened.inspectRun(one.runId)).memorySnapshot?.revision, 1)
                assert.equal((await reopened.inspectRun(four.runId)).result?.outcome, "succeeded")
                assert.equal((await reopened.getStatus()).nodeEnabled, false)
                assert.equal(models, 4)
              } finally {
                await reopened.disconnect()
              }
            })
            console.log(
              JSON.stringify({
                stage: "group-memory-http-journey",
                realJavaHTTP: true,
                realMySQL57: true,
                actualAppWorker: true,
                actualExistingDeepAgent: true,
                simulatedModelCalls: models,
                tools: 0,
                twoTasksReuse: true,
                inFlightChangeCancelled: true,
                noAutoReplay: true,
                disabledNotInjected: true,
                freshSQLiteKeepsMemory: true,
                historicalSnapshots: true,
                esS3Required: false
              })
            )
          } finally {
            await controller.shutdown()
          }
        })
      },
      { signal: abort.signal }
    )
  } finally {
    clearTimeout(timer)
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
    await helper.stopPartnerChildren()
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "MEMORY_JOURNEY_FAILED")
  process.exitCode = 1
})
