import { createHash } from "node:crypto"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { BaseMessage } from "@langchain/core/messages"
import { registerPartnerInputOnlyImplementation } from "../../src/main/agent/agent-run-service"
import { createInputOnlyRequirementImplementation } from "../../src/main/services/bot/input-only-requirement-run"
import {
  PartnerFakeRequirementModel,
  PARTNER_FAKE_MODEL_REF
} from "../../src/main/services/bot/partner-fake-model"
import { PartnerDevController } from "../../src/main/services/bot/partner-dev-controller"
import {
  PartnerLocalClient,
  PartnerLocalFault,
  type PartnerConnectionDescriptor
} from "../../src/main/services/bot/partner-local-client"
import type { PartnerLocalConfig } from "../../src/main/services/bot/partner-local-config"
import { PartnerRequirementExecutor } from "../../src/main/services/bot/requirement-executor"
import { PartnerRequirementAttemptStore } from "../../src/main/services/bot/requirement-attempt-store"
import { PartnerTaskThreadStore } from "../../src/main/services/bot/task-thread-store"
import { ServiceConversationService } from "../../src/main/services/bot/service-conversation"
import { ServiceConversationRouter } from "../../src/main/services/bot/service-conversation-router"
import {
  ServiceConversationStore,
  serviceScopeKey,
  type ServiceScope
} from "../../src/main/services/bot/service-conversation-store"
import {
  instantiateBoundServiceModel,
  serviceModelBinding,
  type ServiceModelBinding
} from "../../src/main/services/bot/service-model-binding"
import { delivery, withSqlite, open } from "./requirement-execution-fixture"
import type { NativeSqliteAdapter } from "../../src/main/db/native-sqlite-adapter"
async function waitFor(fn: () => Promise<boolean>, timeout = 30000) {
  const end = Date.now() + timeout
  while (!(await fn())) {
    if (Date.now() > end) throw Error("M02_JOURNEY_TIMEOUT")
    await new Promise((r) => setTimeout(r, 50))
  }
}
async function main() {
  const helper = (await import(
    pathToFileURL(resolve("deploy/dev/service/partner-http.mjs")).href
  )) as {
    withPartnerHttpFixture: (
      fn: (v: { descriptor: PartnerConnectionDescriptor }) => Promise<void>,
      options: { signal: AbortSignal }
    ) => Promise<void>
    stopPartnerChildren: () => Promise<void>
  }
  const abort = new AbortController(),
    timeout = setTimeout(() => abort.abort(), 240000),
    stop = () => abort.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  let modelCalls = 0,
    tools = 0,
    legacyCalls = 0,
    earlyClaim = false,
    recoveredRunning = 0,
    claims = 0
  try {
    await helper.withPartnerHttpFixture(
      async (fixture) =>
        withSqlite(async (initialDb, path) => {
          let db: NativeSqliteAdapter = initialDb,
            saved: PartnerLocalConfig | null = null,
            controller: PartnerDevController,
            service: ServiceConversationService,
            journal: ServiceConversationStore,
            router: ServiceConversationRouter | undefined
          let modelConfig = {
              ref: "custom:m02-fixture",
              name: "M02 fixture",
              model: "fixture",
              baseUrl: "https://example.test/v1",
              apiKey: "FAKE_TEST_ONLY_NO_REAL_MODEL",
              temperature: 1
            },
            modelAvailable = true
          let holdFirst = true,
            releaseFirst: (() => void) | undefined,
            loseSettlement = false,
            holdEnqueue = false,
            releaseEnqueue: (() => void) | undefined
          const prompts: string[] = []
          class Fake extends PartnerFakeRequirementModel {
            override bindTools(value: unknown[]) {
              tools += value.length
              assert.equal(value.length, 0)
              return super.bindTools(value)
            }
            override async _generate(messages: BaseMessage[]) {
              modelCalls++
              prompts.push(messages.map((m) => String(m.content)).join("\n"))
              if (holdFirst) {
                holdFirst = false
                await new Promise<void>((r) => (releaseFirst = r))
              }
              return super._generate(messages)
            }
          }
          class Client extends PartnerLocalClient {
            override async enqueue(...args: Parameters<PartnerLocalClient["enqueue"]>) {
              const receipt = await super.enqueue(...args)
              if (holdEnqueue) {
                holdEnqueue = false
                await new Promise<void>((r) => (releaseEnqueue = r))
              }
              return receipt
            }
            override async claim(id: string) {
              claims++
              return super.claim(id)
            }
            override async recover(id: string) {
              recoveredRunning++
              return super.recover(id)
            }
            override async settle(...args: Parameters<PartnerLocalClient["settle"]>) {
              if (loseSettlement) {
                loseSettlement = false
                throw new PartnerLocalFault("DEPENDENCY_UNAVAILABLE")
              }
              return super.settle(...args)
            }
          }
          const model = async (ref: string) => {
            if (!modelAvailable) throw new PartnerLocalFault("MODEL_UNAVAILABLE")
            return serviceModelBinding(modelConfig, ref)
          }
          const scopeFor = (c: PartnerLocalConfig): ServiceScope => {
            const d = c.descriptor
            return {
              url: d.url,
              spaceId: d.spaceId,
              nodeId: d.nodeId,
              ownerPrincipalId: d.ownerPrincipalId,
              businessPrincipalId: d.businessPrincipalId,
              workspaceRef: d.workspaceRef,
              workspaceHash: createHash("sha256")
                .update(c.workspacePath ?? "")
                .digest("hex"),
              groupId: c.groupId!,
              botId: c.botId!
            }
          }
          const install = () => {
            journal = new ServiceConversationStore(db)
            registerPartnerInputOnlyImplementation(
              createInputOnlyRequirementImplementation({
                resolveThread(id) {
                  const m = JSON.parse(
                    String(
                      db.exec("SELECT metadata FROM threads WHERE thread_id=?", [id])[0]
                        .values[0][0]
                    )
                  )
                  return { metadata: m, workspacePath: m.workspacePath }
                },
                async resolveModel(ref, hash) {
                  if (ref === PARTNER_FAKE_MODEL_REF) {
                    legacyCalls++
                    return new Fake({})
                  }
                  return instantiateBoundServiceModel(
                    ref,
                    hash!,
                    modelAvailable ? modelConfig : null,
                    async () => new Fake({})
                  )
                }
              })
            )
            controller = new PartnerDevController({
              store: {
                load: async () => structuredClone(saved),
                save: async (c) => {
                  saved = structuredClone(c)
                }
              },
              clientFactory: (d) => new Client(d),
              onWorkerChange: () => service?.wake(),
              beforeLegacyEnqueue: async (c, client, task, commandId, deadline) => {
                const scope = scopeFor(c),
                  group = await client.getBusinessGroup(scope.groupId)
                journal.bind(serviceScopeKey(scope), {
                  ...scope,
                  commandId,
                  taskId: task.id,
                  taskVersion: task.version,
                  stageId: task.currentStageId,
                  groupVersion: group.version,
                  botVersionId: c.botVersionId!,
                  deadline,
                  kind: "legacy",
                  model: { ref: PARTNER_FAKE_MODEL_REF, name: "fake", hash: "" },
                  runId: null,
                  attemptId: null
                })
              },
              createExecutor(c, client) {
                const scope = scopeFor(c),
                  attempts = new PartnerRequirementAttemptStore(db)
                const executor = (
                  binding?: ServiceModelBinding,
                  refusalCode?: "MODEL_CHANGED" | "MODEL_UNAVAILABLE"
                ) =>
                  new PartnerRequirementExecutor({
                    config: {
                      spaceId: scope.spaceId,
                      nodeId: scope.nodeId,
                      ownerPrincipalId: scope.ownerPrincipalId,
                      modelRef: binding?.ref ?? PARTNER_FAKE_MODEL_REF,
                      ...(binding ? { modelConfigHash: binding.hash } : {}),
                      workspaces: new Map([[scope.workspaceRef, c.workspacePath!]])
                    },
                    control: client,
                    threads: new PartnerTaskThreadStore(db),
                    attempts,
                    delivery,
                    refusalCode,
                    cancelBeforeStart: (run) => service.cancelledBeforeStart(scope, run)
                  })
                router = new ServiceConversationRouter({
                  scope,
                  store: journal,
                  legacy: executor(),
                  legacyRunId: c.lastRunId,
                  model,
                  attemptState: (r) => attempts.get(r)?.state ?? null,
                  createExecutor: executor,
                  claimed: (s, r) => {
                    service.claimed(s, r)
                    if (releaseEnqueue) earlyClaim = true
                  },
                  refused: (s, r, code) => service.markRefused(s, r, code),
                  unknown: (s, r) => service.markUnknown(s, r),
                  finished: () => service.wake()
                })
                return router
              }
            })
            service = new ServiceConversationService({
              store: journal,
              context: () => controller.conversationContext(),
              overview: async () => {
                const s = await controller.getStatus()
                return {
                  connected: s.connected,
                  nodeEnabled: s.nodeEnabled,
                  expertName: s.expertName ?? "服务专家"
                }
              },
              models: async () =>
                modelAvailable ? [{ ref: modelConfig.ref, name: modelConfig.name }] : [],
              model,
              cancelOwned: (id) => router?.cancelOwned(id) ?? false,
              cadenceMs: 50
            })
          }
          install()
          try {
            await controller!.importDescriptor(fixture.descriptor)
            await controller!.connect()
            await controller!.setWorkspace("/m02-explicit-workspace")
            await controller!.createExpert(
              "M02文本专家",
              "只使用当前Task文本，列出规则与待确认问题"
            )
            await controller!.startExpert()
            const overview = await service!.open(),
              conversationId = overview.conversationId!
            await service!.selectModel({ conversationId, modelRef: modelConfig.ref })
            holdEnqueue = true
            const first = await service!.send({
              conversationId,
              taskRef: null,
              requestId: "m02-first",
              text: "整理交易查询需求 FIRST_SENTINEL"
            })
            await waitFor(async () => !!releaseFirst && !!releaseEnqueue)
            assert.ok(earlyClaim, "claim must route before HTTP enqueue response returns")
            releaseEnqueue!()
            releaseEnqueue = undefined
            const key = serviceScopeKey((await controller!.conversationContext()).scope),
              task = journal!.task(key, first.taskRef).task!
            const supplement = await service!.send({
              conversationId,
              taskRef: first.taskRef,
              requestId: "m02-supplement",
              text: "补充只允许本人查询 SUPPLEMENT_SENTINEL"
            })
            await service!.drain()
            assert.equal(journal!.request(key, supplement.requestId).status, "next_round")
            const context = await controller!.conversationContext()
            assert.equal(
              (await context.client.lookupTask(context.scope.groupId, task.taskNumber)).version,
              1
            )
            releaseFirst!()
            releaseFirst = undefined
            await waitFor(async () => {
              await service!.drain()
              return journal!.request(key, supplement.requestId).status === "succeeded"
            })
            assert.equal(modelCalls, 2)
            assert.ok(!prompts[0].includes("SUPPLEMENT_SENTINEL"))
            assert.ok(prompts[1].includes("SUPPLEMENT_SENTINEL"))
            assert.equal(
              (await context.client.lookupTask(context.scope.groupId, task.taskNumber)).version,
              2
            )
            const history = await service!.read({
              conversationId,
              taskRef: first.taskRef,
              cursor: null
            })
            assert.equal(history.items.length, 2)
            assert.ok(history.items.every((r) => r.result?.outcome === "succeeded"))
            console.log(
              JSON.stringify({
                stage: "service-first-and-supplement",
                modelCalls,
                tools,
                earlyClaim,
                taskVersion: 2
              })
            )
            // Model configuration changes after enqueue: durable refusal must use Java's
            // accepted EXECUTION_FAILED code, while local journal retains MODEL_CHANGED.
            await controller!.stopNode()
            const drift = await service!.send({
              conversationId,
              taskRef: null,
              requestId: "m02-drift",
              text: "模型变动不执行"
            })
            await service!.drain()
            modelConfig = { ...modelConfig, temperature: 0.5 }
            await controller!.startExpert()
            await waitFor(async () => {
              await service!.drain()
              return journal!.request(key, drift.requestId).status === "failed"
            })
            assert.equal(modelCalls, 2)
            assert.equal(journal!.request(key, drift.requestId).notice, "MODEL_CHANGED")
            assert.equal(journal!.request(key, drift.requestId).result?.text, "EXECUTION_FAILED")
            await service!.selectModel({ conversationId, modelRef: modelConfig.ref })
            // Graph completes, but settlement is unavailable. Reopen the actual SQLite
            // connection and worker; deleted model must not block same-result settlement.
            loseSettlement = true
            const lost = await service!.send({
              conversationId,
              taskRef: null,
              requestId: "m02-result-ready",
              text: "保存结果后恢复同一分析 RESULT_READY_SENTINEL"
            })
            await waitFor(async () => {
              const r = journal!.request(key, lost.requestId)
              if (!r.runId) return false
              const a = db.exec("SELECT state FROM bot_requirement_attempts WHERE run_id=?", [
                r.runId
              ])[0]?.values[0]?.[0]
              return a === "result_ready" && !(await controller!.getStatus()).nodeEnabled
            })
            assert.equal(modelCalls, 3)
            await service!.stop()
            await controller!.shutdown()
            db.close()
            db = open(path)
            modelAvailable = false
            install()
            await controller!.connect()
            await controller!.startExpert()
            await waitFor(async () => {
              await service!.drain()
              return journal!.request(key, lost.requestId).status === "succeeded"
            })
            assert.equal(modelCalls, 3)
            assert.ok(recoveredRunning >= 1)
            assert.equal(
              (await service!.read({ conversationId, taskRef: lost.taskRef, cursor: null }))
                .items[0].result?.outcome,
              "succeeded"
            )
            await assert.rejects(
              service!.send({
                conversationId,
                taskRef: null,
                requestId: "m02-no-model",
                text: "不能默认模型"
              }),
              /MODEL_UNAVAILABLE/
            )
            console.log(
              JSON.stringify({
                stage: "service-result-ready-reopen",
                modelCalls,
                recoveredRunning,
                claims,
                modelDeleted: true
              })
            )
            // The old explicit development flow still routes to fake, never the service
            // selection or an ordinary/local Bot executor.
            const legacy = await controller!.sendMessage(
                true,
                "新任务：明确旧开发模拟 LEGACY_SENTINEL"
              ),
              queued = await controller!.analyzeTask(legacy.taskNumber!)
            await waitFor(async () => !!(await controller!.inspectRun(queued.runId!)).result)
            assert.equal(legacyCalls, 1)
            assert.equal(modelCalls, 4)
            assert.equal(tools, 0)
            const replay = await service!.send({
              conversationId,
              taskRef: null,
              requestId: "m02-first",
              text: "整理交易查询需求 FIRST_SENTINEL"
            })
            assert.equal(replay.taskRef, first.taskRef)
            assert.equal(modelCalls, 4)
            console.log(
              JSON.stringify({
                stage: "m02-service-http-complete",
                modelCalls,
                legacyCalls,
                tools,
                oneTaskTwoRounds: true,
                reopenNoModelReplay: true,
                realJavaMysql: true
              })
            )
          } finally {
            releaseFirst?.()
            releaseEnqueue?.()
            await service!.stop()
            await controller!.shutdown()
            if (db !== initialDb) db.close()
          }
        }),
      { signal: abort.signal }
    )
  } finally {
    clearTimeout(timeout)
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
    await helper.stopPartnerChildren()
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "M02_HTTP_FAILURE")
  process.exitCode = 1
})
