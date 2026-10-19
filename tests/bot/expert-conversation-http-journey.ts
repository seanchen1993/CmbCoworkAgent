import { createHash } from "node:crypto"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { AIMessage, isHumanMessage, type BaseMessage } from "@langchain/core/messages"
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
import { prepareServiceConversationScope } from "../../src/main/services/bot/service-conversation-scope"
import {
  instantiateBoundServiceModel,
  serviceModelBinding,
  type ServiceModelBinding
} from "../../src/main/services/bot/service-model-binding"
import { delivery, withSqlite, open } from "./requirement-execution-fixture"
import type { NativeSqliteAdapter } from "../../src/main/db/native-sqlite-adapter"
async function until(check: () => Promise<boolean>, label: string) {
  const end = Date.now() + 30000
  while (!(await check())) {
    if (Date.now() > end) throw Error("M04_TIMEOUT_" + label)
    await new Promise((r) => setTimeout(r, 50))
  }
}
async function main() {
  const helper = await import(pathToFileURL(resolve("deploy/dev/service/partner-http.mjs")).href)
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 240000)
  let phase = "init",
    calls = 0,
    tools = 0,
    legacyCalls = 0
  try {
    await helper.withPartnerHttpFixture(
      async (fixture: {
        descriptor: PartnerConnectionDescriptor
        reopen(): Promise<PartnerConnectionDescriptor>
        expertProbe(action: string): Promise<unknown>
      }) =>
        withSqlite(async (initialDb, path) => {
          let db: NativeSqliteAdapter = initialDb,
            saved: PartnerLocalConfig | null = null,
            controller: PartnerDevController,
            service: ServiceConversationService,
            journal: ServiceConversationStore,
            router: ServiceConversationRouter | undefined
          const config = {
            ref: "custom:m04-fixture",
            name: "M04 fake text",
            model: "fixture",
            baseUrl: "https://example.test/v1",
            apiKey: "FAKE_TEST_ONLY_NO_REAL_MODEL",
            temperature: 1
          }
          const prompts: string[] = [],
            inputs: any[] = [],
            children: string[] = []
          let loseCoordinate = true,
            coordinateLost = false,
            holdCoordinate = false,
            modelAvailable = true
          const scopeFor = (c: PartnerLocalConfig): ServiceScope => ({
            url: c.descriptor.url,
            ...(c.serviceInstanceId ? { serviceInstanceId: c.serviceInstanceId } : {}),
            spaceId: c.descriptor.spaceId,
            nodeId: c.descriptor.nodeId,
            ownerPrincipalId: c.descriptor.ownerPrincipalId,
            businessPrincipalId: c.descriptor.businessPrincipalId,
            workspaceRef: c.descriptor.workspaceRef,
            workspaceHash: createHash("sha256")
              .update(c.workspacePath ?? "")
              .digest("hex"),
            groupId: c.groupId!,
            botId: c.botId!
          })
          const model = async (ref: string) => {
            if (!modelAvailable) throw new PartnerLocalFault("MODEL_UNAVAILABLE")
            return serviceModelBinding(config, ref)
          }
          class Fake extends PartnerFakeRequirementModel {
            override bindTools(value: unknown[]) {
              tools += value.length
              assert.equal(value.length, 0)
              return super.bindTools(value)
            }
            override async _generate(messages: BaseMessage[]) {
              calls++
              prompts.push(messages.map((m) => String(m.content)).join("\n"))
              const input = JSON.parse(String(messages.filter(isHumanMessage).at(-1)!.content))
              inputs.push(input)
              let text: string
              if (input.profile === "expert_main_v1") {
                const user = input.messages.findLast((m: any) => m.role === "user").text
                text = user.includes("BAD_PROTOCOL")
                  ? '{"reply":"bad","intent":null,"extra":true}'
                  : JSON.stringify({
                      reply: "这是一轮普通讨论。",
                      intent: user.includes("DELEGATE")
                        ? {
                            kind: "create_task",
                            sourceRequestId: input.sourceRequestId,
                            title: "季度安排",
                            contextSourceIds: input.messages
                              .filter((m: any) => m.role === "assistant")
                              .slice(-1)
                              .map((m: any) => m.sourceId)
                          }
                        : user.includes("TRANSFER")
                          ? {
                              kind: "append_task",
                              sourceRequestId: input.sourceRequestId,
                              targetTaskRef: input.targets.find((t: any) => t.title === "季度安排")
                                .taskId
                            }
                          : null
                    })
              } else {
                assert.equal(input.profile, "expert_task_v1")
                text = "任务文本回复 " + input.messages.findLast((m: any) => m.role === "user").text
              }
              return { generations: [{ message: new AIMessage(text), text }] }
            }
          }
          class Client extends PartnerLocalClient {
            override async coordinateExpertTask(command: string, source: string) {
              if (holdCoordinate) throw new PartnerLocalFault("DEPENDENCY_UNAVAILABLE")
              const receipt = await super.coordinateExpertTask(command, source)
              if (loseCoordinate) {
                loseCoordinate = false
                coordinateLost = true
                holdCoordinate = true
                throw new PartnerLocalFault("OUTCOME_UNKNOWN")
              }
              children.push(receipt.task.id)
              return receipt
            }
            override async enqueue(...args: Parameters<PartnerLocalClient["enqueue"]>) {
              const receipt = await super.enqueue(...args)
              const snapshot = journal.expert.input(
                serviceScopeKey(scopeFor(saved!)),
                journal.requestByCommand(serviceScopeKey(scopeFor(saved!)), args[2])!.requestId
              )
              assert.equal(receipt.executionProfile, snapshot!.profile)
              assert.equal(receipt.contextDigest, snapshot!.digest)
              return receipt
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
                    throw Error("LEGACY_ESCAPE")
                  }
                  return instantiateBoundServiceModel(
                    ref,
                    hash!,
                    modelAvailable ? config : null,
                    async () => new Fake({})
                  )
                }
              })
            )
            controller = new PartnerDevController({
              store: {
                load: async () => structuredClone(saved),
                save: async (value) => {
                  saved = structuredClone(value)
                }
              },
              clientFactory: (d) => new Client(d),
              prepareServiceScope: async (config, client) =>
                prepareServiceConversationScope(journal, scopeFor(config), client),
              onWorkerChange: () => service?.wake(),
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
                    onProtocolFailure: (run) => service.markProtocolFailure(scope, run),
                    cancelBeforeStart: (run) => service.cancelledBeforeStart(scope, run)
                  })
                router = new ServiceConversationRouter({
                  scope,
                  store: journal,
                  legacy: executor(),
                  legacyRunId: c.lastRunId,
                  model,
                  attemptState: (run) => attempts.get(run)?.state ?? null,
                  createExecutor: executor,
                  claimed: (s, r) => service.claimed(s, r),
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
                const value = await controller.getStatus()
                return {
                  connected: value.connected,
                  nodeEnabled: value.nodeEnabled,
                  expertName: "工作专家"
                }
              },
              models: async () => [{ ref: config.ref, name: config.name }],
              model,
              cancelOwned: (id) => router?.cancelOwned(id) ?? false,
              cadenceMs: 50
            })
          }
          install()
          const waitRequest = async (id: string) =>
            until(async () => {
              await service.drain()
              const r = journal.request(
                serviceScopeKey((await controller.conversationContext()).scope),
                id
              )
              if (["blocked", "failed", "outcome_unknown"].includes(r.status) && !r.protocolFailure)
                throw Error("M04_REQUEST_" + r.status + "_" + r.notice)
              return (
                r.phase === "terminal" && (r.profile !== "expert_main_v1" || !!r.coordinationDone)
              )
            }, id)
          try {
            phase = "configure"
            await controller.importDescriptor(fixture.descriptor)
            await controller.connect()
            await controller.setWorkspace("/m04-isolated-workspace")
            await controller.createExpert(
              "工作专家",
              "按用户给出的文本讨论和完成工作，保留本任务的前文和修改意见。"
            )
            await controller.startExpert()
            const first = await service.openChats(),
              id = first.conversationId!,
              mainRef = first.mainTaskRef!
            await service.selectModel({ conversationId: id, modelRef: config.ref })
            const send = (requestId: string, text: string, taskRef: string | null = null) =>
              service.chat({
                conversationId: id,
                taskRef,
                role: taskRef ? "task" : "main",
                requestId,
                text
              })
            phase = "normal-main"
            await send("hello", "你好，请解释安排工作的方法，中文🧭")
            await waitRequest("hello")
            assert.equal(
              (await service.chatTasks({ conversationId: id, cursor: null, query: "" })).items
                .length,
              0
            )
            assert.ok(
              inputs[0].messages.some((m: any) => m.role === "user" && m.text.includes("中文🧭"))
            )
            phase = "bad-protocol"
            await send("bad", "BAD_PROTOCOL")
            await until(async () => {
              await service.drain()
              return (
                (
                  await service.read({ conversationId: id, taskRef: mainRef, cursor: null })
                ).items.at(-1)?.status === "failed"
              )
            }, "bad")
            await send("after-bad", "继续普通讨论")
            await waitRequest("after-bad")
            phase = "coordinate-loss"
            await send("delegate", "DELEGATE 请写季度安排")
            await until(async () => {
              await service.drain()
              return coordinateLost
            }, "lost-coordinate")
            const callsBefore = calls
            await service.stop()
            await controller.shutdown()
            db.close()
            db = open(path)
            holdCoordinate = false
            install()
            await controller.connect()
            await controller.startExpert()
            await waitRequest("delegate")
            const card = (
              await service.read({ conversationId: id, taskRef: mainRef, cursor: null })
            ).items.find((r) => r.requestId === "delegate")!.coordination!
            assert.equal(card.state, "delivered")
            const ref = card.taskRef!,
              key = serviceScopeKey((await controller.conversationContext()).scope)
            await until(async () => {
              await service.drain()
              return journal.latest(key, ref)?.status === "succeeded"
            }, "child")
            assert.equal(calls, callsBefore + 1)
            const serverTask = journal.task(key, ref).task!.id
            phase = "task-modification"
            await send("modify", "改短一点", ref)
            await waitRequest("modify")
            assert.ok(
              inputs
                .at(-1)
                .messages.some(
                  (m: any) => m.role === "assistant" && m.text.includes("任务文本回复")
                )
            )
            phase = "transfer"
            await send("transfer", "TRANSFER 给季度安排补充里程碑")
            await waitRequest("transfer")
            await until(async () => {
              await service.drain()
              return journal.latest(key, ref)?.status === "succeeded"
            }, "transfer-child")
            assert.equal(journal.task(key, ref).task!.id, serverTask)
            phase = "complete-reopen"
            const beforeComplete = calls
            modelAvailable = false
            await service.taskLifecycle({
              conversationId: id,
              taskRef: ref,
              operationId: "complete",
              action: "complete"
            })
            await until(async () => {
              await service.drain()
              return journal.expert.summary(key, ref)?.status === "completed"
            }, "complete")
            assert.equal(calls, beforeComplete)
            await assert.rejects(send("closed", "不能自动重开", ref), /INPUT_CHANGED/)
            await service.taskLifecycle({
              conversationId: id,
              taskRef: ref,
              operationId: "reopen",
              action: "reopen"
            })
            await until(async () => {
              await service.drain()
              return journal.expert.summary(key, ref)?.status === "active"
            }, "reopen")
            modelAvailable = true
            await send("continued", "保留原安排，补一项", ref)
            await waitRequest("continued")
            assert.equal(journal.task(key, ref).task!.id, serverTask)
            phase = "service-reopen"
            await service.stop()
            await controller.shutdown()
            const descriptor = await fixture.reopen()
            assert.notEqual(descriptor.url, fixture.descriptor.url)
            install()
            await controller.importDescriptor(descriptor)
            await controller.connect()
            const reopened = await service.openChats()
            assert.equal(reopened.conversationId, id)
            assert.equal(
              (await service.read({ conversationId: id, taskRef: ref, cursor: null })).items.at(-1)!
                .text,
              "保留原安排，补一项"
            )
            assert.equal(calls, beforeComplete + 1)
            assert.equal(legacyCalls, 0)
            assert.equal(tools, 0)
            assert.ok(prompts.every((p) => !p.includes("参与Biz—Dev需求交付协作")))
            assert.equal(journal.deliveries.actions(key, ref).length, 0)
            phase = "java-probe"
            await controller.shutdown()
            const proof = await fixture.expertProbe("exercise")
            console.log(JSON.stringify({ stage: "m04-java-proof", proof }))
            console.log(
              JSON.stringify({
                stage: "m04-http-complete",
                calls,
                tools,
                legacyCalls,
                sourceOnce: new Set(children).size === 1,
                physicalSqliteReopen: true,
                portChangedHistory: true,
                completeReopenSameTask: true,
                realJavaMysql: true
              })
            )
          } finally {
            await service.stop()
            await controller.shutdown()
            if (db !== initialDb) db.close()
          }
        }),
      { signal: abort.signal, upgradeV8: true }
    )
    await helper.withPartnerHttpFixture(
      async () => {
        console.log(JSON.stringify({ stage: "m04-new-v9", migrations: 9, noForeignKeys: true }))
      },
      { signal: abort.signal }
    )
  } catch (error) {
    console.error(
      JSON.stringify({
        stage: "m04-failed",
        phase,
        reason: error instanceof Error ? error.message : "UNKNOWN"
      })
    )
    throw error
  } finally {
    clearTimeout(timer)
    await helper.stopPartnerChildren()
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "M04_HTTP_FAILURE")
  process.exitCode = 1
})
