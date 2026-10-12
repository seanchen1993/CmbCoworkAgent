import assert from "node:assert/strict"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { FakeChatModel } from "@langchain/core/utils/testing"
import { registerPartnerInputOnlyImplementation } from "../../src/main/agent/agent-run-service"
import { createInputOnlyRequirementImplementation } from "../../src/main/services/bot/input-only-requirement-run"
import { PartnerTaskThreadStore } from "../../src/main/services/bot/task-thread-store"
import { PartnerRequirementAttemptStore } from "../../src/main/services/bot/requirement-attempt-store"
import { PartnerRequirementExecutor } from "../../src/main/services/bot/requirement-executor"
import type {
  PartnerRequirementInput,
  PartnerRequirementRun,
  PartnerRequirementResult,
  RequirementOutcome
} from "../../src/main/services/bot/requirement-execution-types"
import { delivery, withSqlite, open } from "./requirement-execution-fixture"

interface TestControlFixture {
  run: PartnerRequirementRun
  input: PartnerRequirementInput
  start(): Promise<{ run: PartnerRequirementRun; input: PartnerRequirementInput }>
  renew(): Promise<PartnerRequirementRun>
  settle(outcome: RequirementOutcome, text: string): Promise<PartnerRequirementResult>
  read(): Promise<PartnerRequirementResult>
}

/** Fixed local demonstration, NOT a network node transport or real IM/model.
 * Uses disposable MySQL5.7 + App SQLite + the actual existing DeepAgent graph.
 * All dev DB resource/credential ownership stays in the audited service helper. */
async function main() {
  const helperUrl = pathToFileURL(
    resolve("deploy/dev/service/requirement-execution-check.mjs")
  ).href
  const helper = (await import(helperUrl)) as {
    withRequirementExecutionFixture(
      callback: (fixture: TestControlFixture) => Promise<void>,
      options: { signal: AbortSignal }
    ): Promise<{ result: PartnerRequirementResult }>
    stopRequirementExecutionChildren(): Promise<void>
  }
  assert.equal(typeof helper.withRequirementExecutionFixture, "function")
  const abort = new AbortController(),
    stop = () => abort.abort(),
    timer = setTimeout(stop, 300_000)
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  let modelCalls = 0,
    modelText = "",
    settlements = 0
  try {
    const proof = await helper.withRequirementExecutionFixture(
      async (control) => {
        await withSqlite(async (db, path) => {
          class Model extends FakeChatModel {
            bindTools(tools: unknown[]) {
              assert.equal(tools.length, 0)
              return this
            }
            async _generate(messages: BaseMessage[]) {
              modelCalls++
              modelText = messages.map((m) => JSON.stringify(m.content)).join("\n")
              const message = new AIMessage(
                "# 需求说明书草稿\n范围：本任务提供的需求文本。待澄清：业务规则、权限边界、验收标准。\n说明：未读取代码，未获业务审批。"
              )
              return { generations: [{ message, text: String(message.content) }] }
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
                assert.equal(ref, "local-test-model")
                return new Model({})
              }
            })
          )
          const dependencies = {
            config: {
              spaceId: control.run.spaceId,
              nodeId: control.run.nodeId,
              ownerPrincipalId: control.run.ownerPrincipalId,
              modelRef: "local-test-model",
              workspaces: new Map([[control.run.workspaceRef, "/explicit-test-workspace"]])
            },
            control: {
              start: () => control.start(),
              renew: () => control.renew(),
              settle: (_run: PartnerRequirementRun, outcome: RequirementOutcome, text: string) => {
                settlements++
                return control.settle(outcome, text)
              }
            },
            threads: new PartnerTaskThreadStore(db),
            attempts: new PartnerRequirementAttemptStore(db),
            delivery
          }
          const executor = new PartnerRequirementExecutor(dependencies)
          const first = executor.execute(control.run),
            duplicate = executor.execute(control.run)
          assert.equal(first, duplicate)
          const result = await first
          assert.equal(result.outcome, "succeeded")
          assert.deepEqual(result, await control.read())
          assert.ok(modelText.includes(control.input.task.title))
          assert.ok(modelText.includes(control.input.bot.name))
          assert.ok(control.input.messages.length > 0)
          assert.ok(modelText.includes("CLARIFICATION_SENTINEL"))
          assert.equal(modelCalls, 1)
          const reopened = open(path)
          try {
            const next = new PartnerRequirementExecutor({
              ...dependencies,
              threads: new PartnerTaskThreadStore(reopened),
              attempts: new PartnerRequirementAttemptStore(reopened)
            })
            assert.deepEqual(await next.execute(control.run), result)
            assert.equal(modelCalls, 1)
            assert.equal(
              new PartnerRequirementAttemptStore(reopened).get(control.run)?.state,
              "settled"
            )
          } finally {
            reopened.close()
          }
        })
      },
      { signal: abort.signal }
    )
    assert.equal(proof.result.outcome, "succeeded")
    console.log(
      JSON.stringify({
        status: "verified",
        existingDeepAgent: true,
        fakeModel: true,
        modelCalls,
        tools: 0,
        mysqlResultPersisted: true,
        sqliteReopen: true,
        identicalSettlementReplay: settlements === 2,
        dedicatedThread: true,
        realZhaohu: false,
        productionTransport: false
      })
    )
  } finally {
    clearTimeout(timer)
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
    await helper.stopRequirementExecutionChildren()
  }
}
main().catch(() => {
  console.log(JSON.stringify({ status: "failed", category: "LOCAL_REQUIREMENT_JOURNEY" }))
  process.exitCode = 1
})
