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
  type PartnerConnectionDescriptor
} from "../../src/main/services/bot/partner-local-client"
import {
  readPartnerPrivateJson,
  type PartnerLocalConfig
} from "../../src/main/services/bot/partner-local-config"
import { PartnerRequirementExecutor } from "../../src/main/services/bot/requirement-executor"
import { PartnerTaskThreadStore } from "../../src/main/services/bot/task-thread-store"
import { PartnerRequirementAttemptStore } from "../../src/main/services/bot/requirement-attempt-store"
import { delivery, withSqlite, open } from "./requirement-execution-fixture"

/** Real Java PartnerHttpMain + isolated MySQL5.7 + actual App controller/worker
 * and existing DeepAgent/SQLite. Not a real model or real Zhaohu test. */
async function main() {
  const helper = (await import(
    pathToFileURL(resolve("deploy/dev/service/partner-http.mjs")).href
  )) as {
    withPartnerHttpFixture: (
      callback: (fixture: {
        descriptor: PartnerConnectionDescriptor
        connectionFile: string
      }) => Promise<void>,
      options: { signal: AbortSignal }
    ) => Promise<void>
    stopPartnerChildren: () => Promise<void>
  }
  const abort = new AbortController(),
    stop = () => abort.abort(),
    timer = setTimeout(stop, 300000)
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  let models = 0
  try {
    await helper.withPartnerHttpFixture(
      async (fixture) => {
        await withSqlite(async (db, path) => {
          class Fake extends PartnerFakeRequirementModel {
            override bindTools(tools: unknown[]) {
              assert.equal(tools.length, 0)
              return super.bindTools(tools)
            }
            override async _generate(messages: BaseMessage[]) {
              models++
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
          const createExecutor = (config: PartnerLocalConfig, client: PartnerLocalClient) =>
            new PartnerRequirementExecutor({
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
              delivery
            })
          const controller = new PartnerDevController({ store, createExecutor })
          try {
            await controller.importDescriptor(await readPartnerPrivateJson(fixture.connectionFile))
            await controller.connect()
            await controller.setWorkspace("/explicit-owner-workspace")
            await controller.createTeam("交易产品需求专家", "仅使用明确任务文本，不能杜撰代码事实")
            await controller.authorizeTeam()
            console.log(
              JSON.stringify({
                stage: "app-partner-offline-grace",
                heartbeatTTLSeconds: 60,
                nodeEnabled: false,
                modelCalls: models
              })
            )
            // Registration has one heartbeat. Prove actual server-side offline
            // waiting after its existing 60s TTL, not a forged/test SQL timestamp.
            const offlineAt = Date.now() + 62000
            while (Date.now() < offlineAt) {
              if (abort.signal.aborted) throw Error("JOURNEY_CANCELLED")
              await new Promise((resolve) => setTimeout(resolve, 500))
            }
            assert.equal(
              (await controller.sendMessage(false, "新任务：不要保存的整群消息")).kind,
              "ignored"
            )
            assert.equal((await controller.sendMessage(true, "普通闲聊")).kind, "clarify")
            const first = await controller.sendMessage(true, "新任务：取消前排队演示")
            const queued = await controller.analyzeTask(first.taskNumber!)
            assert.equal(queued.runStatus, "waiting_node")
            const pending = await controller.inspectRun(queued.runId!)
            assert.equal(
              (await controller.cancelPending(pending.runId, pending.version)).status,
              "cancelled"
            )
            assert.equal(models, 0)
            const task = await controller.sendMessage(true, "新任务：按日期查询交易，明确业务范围")
            const clarified = await controller.sendMessage(
              true,
              `${task.taskNumber}：仅查本人权限；CLARIFICATION_SENTINEL`
            )
            assert.equal(clarified.taskVersion, 2)
            const receipt = await controller.analyzeTask(task.taskNumber!)
            assert.equal(receipt.runStatus, "waiting_node")
            assert.equal(models, 0)
            await controller.enableNode()
            let result: Awaited<ReturnType<PartnerDevController["inspectRun"]>> | undefined
            const deadline = Date.now() + 20000
            while (Date.now() < deadline) {
              if (abort.signal.aborted) throw Error("JOURNEY_CANCELLED")
              result = await controller.inspectRun(receipt.runId!)
              if (result.result) break
              const status = await controller.getStatus()
              if (status.lastError) throw Error(status.lastError)
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
            assert.equal(result?.status, "succeeded")
            assert.equal(models, 1)
            assert.ok(result!.result!.text.includes("模拟模型返回"))
            assert.ok(result!.result!.text.includes("1 条明确任务澄清"))
            assert.ok(result!.result!.text.includes(task.taskNumber!))
            await controller.disconnect()
            const restored = new PartnerDevController({ store, createExecutor }),
              reopened = open(path)
            try {
              const state = await restored.getStatus()
              assert.equal(state.connected, false)
              assert.equal(state.nodeEnabled, false)
              assert.equal(state.lastRunId, receipt.runId)
              assert.equal(
                reopened.exec("SELECT COUNT(*) FROM bot_requirement_attempts")[0].values[0][0],
                1
              )
              await restored.connect()
              assert.deepEqual(await restored.inspectRun(receipt.runId!), result)
              await restored.authorizeTeam() // Uses current stored grant version, not assumed zero.
              await restored.enableNode()
              await new Promise((resolve) => setTimeout(resolve, 2250))
              assert.equal(models, 1)
              await restored.revokeTeam()
              assert.equal((await restored.getStatus()).nodeEnabled, false)
            } finally {
              await restored.disconnect()
              reopened.close()
            }
            console.log(
              JSON.stringify({
                stage: "app-partner-http-journey",
                model: "simulated",
                modelCalls: models,
                tools: 0,
                actualJavaHttp: true,
                actualMySQL: true,
                actualAppControllerWorker: true,
                actualDeepAgent: true,
                sqliteReopened: true,
                offlineWaiting: true,
                pendingCancelled: true,
                explicitClarification: true,
                persistentResultVisible: true,
                noReplayAfterReconnect: true,
                currentGrantCAS: true
              })
            )
          } finally {
            await controller.disconnect()
          }
        })
      },
      { signal: abort.signal }
    )
  } finally {
    clearTimeout(timer)
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
    await helper.stopPartnerChildren()
  }
}
main().catch(() => {
  console.error(
    JSON.stringify({ stage: "app-partner-http-journey-failed", code: "LOCAL_JOURNEY_FAILED" })
  )
  process.exitCode = 1
})
