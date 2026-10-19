import { createHash } from "node:crypto"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { isHumanMessage, type BaseMessage } from "@langchain/core/messages"
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
      fn: (v: {
        descriptor: PartnerConnectionDescriptor
        deliveryProbe(action: string): Promise<unknown>
      }) => Promise<void>,
      options: { signal: AbortSignal; upgradeV7?: boolean }
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
          let holdFirst = false,
            releaseFirst: (() => void) | undefined,
            loseSettlement = false,
            holdEnqueue = false,
            releaseEnqueue: (() => void) | undefined
          const prompts: string[] = [],
            inputs: any[] = []
          let losePublish = true,
            holdPublish = false,
            publishLost = false,
            loseReview = false,
            holdReview = false,
            reviewLost = false
          class Fake extends PartnerFakeRequirementModel {
            override bindTools(value: unknown[]) {
              tools += value.length
              assert.equal(value.length, 0)
              return super.bindTools(value)
            }
            override async _generate(messages: BaseMessage[]) {
              modelCalls++
              prompts.push(messages.map((m) => String(m.content)).join("\n"))
              inputs.push(JSON.parse(String(messages.filter(isHumanMessage).at(-1)!.content)))
              if (holdFirst) {
                holdFirst = false
                await new Promise<void>((r) => (releaseFirst = r))
              }
              return super._generate(messages)
            }
          }
          class Client extends PartnerLocalClient {
            override async publishTextDelivery(
              v: Parameters<PartnerLocalClient["publishTextDelivery"]>[0]
            ) {
              if (holdPublish) throw new PartnerLocalFault("DEPENDENCY_UNAVAILABLE")
              const receipt = await super.publishTextDelivery(v)
              if (losePublish) {
                losePublish = false
                holdPublish = true
                publishLost = true
                throw new PartnerLocalFault("OUTCOME_UNKNOWN")
              }
              return receipt
            }
            override async decideTextDelivery(
              v: Parameters<PartnerLocalClient["decideTextDelivery"]>[0]
            ) {
              if (holdReview) throw new PartnerLocalFault("DEPENDENCY_UNAVAILABLE")
              const receipt = await super.decideTextDelivery(v)
              if (loseReview) {
                loseReview = false
                holdReview = true
                reviewLost = true
                throw new PartnerLocalFault("OUTCOME_UNKNOWN")
              }
              return receipt
            }
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
            await controller!.setWorkspace("/m03-isolated-workspace")
            await controller!.createExpert(
              "文本成果专家",
              "只按明确材料生成需求说明文本，修改时使用旧版与意见"
            )
            await controller!.startExpert()
            const conversationId = (await service!.open()).conversationId!
            await service!.selectModel({ conversationId, modelRef: modelConfig.ref })
            const first = await service!.send({
              conversationId,
              taskRef: null,
              requestId: "m03-first",
              text: "整理交易查询需求 V1_SENTINEL"
            })
            const key = serviceScopeKey((await controller!.conversationContext()).scope)
            await waitFor(async () => {
              await service!.drain()
              return publishLost
            })
            assert.equal(modelCalls, 1)
            assert.equal(journal!.deliveries.get(key, "publish:m03-first")!.phase, "remote")
            // Physical SQLite close/reopen with service already committed but no local receipt.
            await service!.stop()
            await controller!.shutdown()
            db.close()
            db = open(path)
            holdPublish = false
            install()
            await controller!.connect()
            await waitFor(async () => {
              await service!.drain()
              return journal!.deliveries.get(key, "publish:m03-first")!.phase === "done"
            })
            const initial = (await service!.delivery({
                conversationId,
                taskRef: first.taskRef,
                before: null
              }))!,
              one = initial.summary.head!.versionId
            const version1 = await service!.deliveryVersion({
              conversationId,
              taskRef: first.taskRef,
              versionId: one
            })
            assert.equal(initial.summary.taskStatus, "awaiting_business")
            assert.equal(initial.versions.length, 1)
            assert.equal(modelCalls, 1)
            loseReview = true
            const reject = {
              conversationId,
              taskRef: first.taskRef,
              operationId: "m03-reject",
              versionId: one,
              decision: "reject",
              comment: "在旧版基础上明确本人权限与跨日边界 FEEDBACK_SENTINEL"
            }
            await service!.review(reject)
            await waitFor(async () => {
              await service!.drain()
              return reviewLost
            })
            await service!.stop()
            await controller!.shutdown()
            db.close()
            db = open(path)
            holdReview = false
            install()
            await controller!.connect()
            await waitFor(async () => {
              await service!.drain()
              const a = journal!.deliveries.get(key, "m03-reject")!
              return (
                a.phase === "done" && !!a.requestId && !!journal!.request(key, a.requestId).runId
              )
            })
            const revision = journal!.latest(key, first.taskRef)!
            assert.equal(revision.taskVersion, 3)
            assert.equal(modelCalls, 1, "disabled node waits without running model")
            modelConfig = { ...modelConfig, temperature: 0.5 }
            await controller!.startExpert()
            await waitFor(async () => {
              await service!.drain()
              return journal!.request(key, revision.requestId).status === "failed"
            })
            assert.equal(modelCalls, 1)
            assert.equal(journal!.request(key, revision.requestId).notice, "MODEL_CHANGED")
            await service!.selectModel({ conversationId, modelRef: modelConfig.ref })
            const retry = {
              conversationId,
              taskRef: first.taskRef,
              actionId: "m03-reject",
              operationId: "m03-retry"
            }
            await service!.retryRevision(retry)
            await service!.retryRevision(retry)
            await waitFor(async () => {
              await service!.drain()
              return (
                (await service!.delivery({ conversationId, taskRef: first.taskRef, before: null }))!
                  .summary.head?.number === 2
              )
            })
            const second = (await service!.delivery({
                conversationId,
                taskRef: first.taskRef,
                before: null
              }))!,
              two = second.summary.head!.versionId
            assert.equal(modelCalls, 2)
            assert.equal(second.versions.length, 2)
            assert.equal(inputs[1].revision.text, version1.version.text)
            assert.equal(inputs[1].revision.digest, version1.version.digest)
            assert.equal(inputs[1].revision.feedbackText, reject.comment)
            assert.equal(
              inputs[1].clarifications.filter((m: any) => m.text === reject.comment).length,
              1
            )
            assert.equal(
              (
                await service!.deliveryVersion({
                  conversationId,
                  taskRef: first.taskRef,
                  versionId: one
                })
              ).decision!.comment,
              reject.comment
            )
            await assert.rejects(
              service!.review({ ...reject, operationId: "m03-stale" }),
              /INPUT_CHANGED/
            )
            // Exact historical reject replay does not create another revision intent or Run.
            await service!.review(reject)
            await service!.drain()
            assert.equal(modelCalls, 2)
            await controller!.stopNode()
            modelAvailable = false
            const approve = {
              conversationId,
              taskRef: first.taskRef,
              operationId: "m03-approve",
              versionId: two,
              decision: "approve",
              comment: null
            }
            await service!.review(approve)
            await waitFor(async () => {
              await service!.drain()
              return (
                (await service!.delivery({ conversationId, taskRef: first.taskRef, before: null }))!
                  .summary.taskStatus === "completed"
              )
            })
            await service!.review(approve)
            await service!.drain()
            assert.equal(modelCalls, 2)
            assert.equal(tools, 0)
            await assert.rejects(
              service!.send({
                conversationId,
                taskRef: first.taskRef,
                requestId: "closed",
                text: "已完成任务不可修改"
              }),
              /INPUT_CHANGED/
            )
            await service!.stop()
            await controller!.shutdown()
            db.close()
            db = open(path)
            install()
            await controller!.connect()
            const reopened = (await service!.delivery({
              conversationId,
              taskRef: first.taskRef,
              before: null
            }))!
            assert.equal(reopened.summary.taskStatus, "completed")
            assert.equal(
              (
                await service!.deliveryVersion({
                  conversationId,
                  taskRef: first.taskRef,
                  versionId: two
                })
              ).decision!.decision,
              "approve"
            )
            assert.equal(
              (
                await service!.deliveryVersion({
                  conversationId,
                  taskRef: first.taskRef,
                  versionId: one
                })
              ).version.text,
              version1.version.text
            )
            assert.equal(modelCalls, 2)
            await controller!.startExpert()
            const legacy = await controller!.sendMessage(
                true,
                "新任务：旧开发入口仍为模拟 LEGACY_SENTINEL"
              ),
              queued = await controller!.analyzeTask(legacy.taskNumber!)
            await waitFor(async () => !!(await controller!.inspectRun(queued.runId!)).result)
            assert.equal(legacyCalls, 1)
            assert.equal(modelCalls, 3)
            assert.equal(tools, 0)
            await controller!.stopNode()
            await service!.stop()
            const proof = await fixture.deliveryProbe("exercise")
            console.log(JSON.stringify({ stage: "m03-java-db-proof", proof }))
            console.log(
              JSON.stringify({
                stage: "m03-delivery-http-complete",
                modelCalls,
                legacyCalls,
                tools,
                v1FeedbackV2Confirmed: true,
                physicalSqliteReopen: true,
                publishAndRejectLostResponse: true,
                driftRefusedThenExplicitRetry: true,
                confirmationWithoutModelOrNode: true,
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
      { signal: abort.signal, upgradeV7: true }
    )
    // A second, sequential fixture proves a brand-new V8 catalog and no-op migration.
    await helper.withPartnerHttpFixture(
      async () => {
        console.log(
          JSON.stringify({
            stage: "m03-new-v8-catalog",
            schemaReady: true,
            migrations: 8,
            noForeignKeys: true
          })
        )
      },
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
  console.error(error instanceof Error ? error.message : "M03_HTTP_FAILURE")
  process.exitCode = 1
})
