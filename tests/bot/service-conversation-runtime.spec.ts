import assert from "node:assert/strict"
import test from "node:test"
import { BaseMessage } from "@langchain/core/messages"
import { registerPartnerInputOnlyImplementation } from "../../src/main/agent/agent-run-service"
import { createInputOnlyRequirementImplementation } from "../../src/main/services/bot/input-only-requirement-run"
import { PartnerFakeRequirementModel } from "../../src/main/services/bot/partner-fake-model"
import { PartnerRequirementExecutor } from "../../src/main/services/bot/requirement-executor"
import { PartnerRequirementAttemptStore } from "../../src/main/services/bot/requirement-attempt-store"
import { PartnerTaskThreadStore } from "../../src/main/services/bot/task-thread-store"
import { ServiceConversationRouter } from "../../src/main/services/bot/service-conversation-router"
import {
  ServiceConversationStore,
  serviceScopeKey,
  type ServiceScope
} from "../../src/main/services/bot/service-conversation-store"
import {
  instantiateBoundServiceModel,
  serviceModelBinding
} from "../../src/main/services/bot/service-model-binding"
import { PartnerLocalFault } from "../../src/main/services/bot/partner-local-boundary"
import { PartnerLocalWorker } from "../../src/main/services/bot/partner-local-worker"
import { delivery, inputFixture, runFixture, withSqlite } from "./requirement-execution-fixture"
import type {
  PartnerRequirementControl,
  PartnerRequirementRun
} from "../../src/main/services/bot/requirement-execution-types"
const config = {
  ref: "custom:fixture",
  name: "fixture",
  apiKey: "UNIT_ONLY_NOT_A_REAL_KEY",
  model: "fixture",
  baseUrl: "https://example.test/v1",
  temperature: 1
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw Error("WAIT_TIMEOUT")
    await new Promise((r) => setTimeout(r, 10))
  }
}

test("router hash check followed by registry drift before actual resolver never calls model; model snapshot survives asynchronous construction", () =>
  withSqlite(async (db) => {
    const original = { ...config },
      model = serviceModelBinding(original, original.ref),
      journal = new ServiceConversationStore(db),
      input = inputFixture(),
      scope: ServiceScope = {
        url: "http://127.0.0.1:12345",
        spaceId: "A",
        businessPrincipalId: "business",
        ownerPrincipalId: "owner",
        nodeId: "node",
        workspaceRef: "workspace",
        groupId: "group",
        botId: "expert"
      },
      key = serviceScopeKey(scope),
      conversation = journal.conversation(scope)
    const record = journal.accept(scope, conversation.id, null, "request", "需求", model)
    journal.saveTask(key, { ...journal.task(key, record.taskRef), task: input.task })
    const run = {
      ...runFixture(),
      commandId: record.enqueueCommand,
      requesterPrincipalId: "business"
    }
    journal.bind(key, {
      ...scope,
      commandId: run.commandId,
      taskId: run.taskId,
      taskVersion: 1,
      stageId: run.stageId,
      groupVersion: 1,
      botVersionId: run.botVersionId,
      deadline: run.deadline,
      model,
      kind: "service",
      runId: null,
      attemptId: null
    })
    let models = 0,
      settles = 0
    registerPartnerInputOnlyImplementation(
      createInputOnlyRequirementImplementation({
        resolveThread(id) {
          const m = JSON.parse(
            String(db.exec("SELECT metadata FROM threads WHERE thread_id=?", [id])[0].values[0][0])
          )
          return { metadata: m, workspacePath: m.workspacePath }
        },
        resolveModel(ref, hash) {
          return instantiateBoundServiceModel(ref, hash!, original, async () => {
            models++
            return new PartnerFakeRequirementModel({})
          })
        }
      })
    )
    const control: PartnerRequirementControl = {
      start: async (r) => ({ run: { ...r, status: "running" }, input }),
      renew: async (r) => r,
      settle: async (r, outcome, text) => {
        settles++
        return {
          runId: r.id,
          attemptId: r.attemptId,
          outcome,
          text,
          settledAt: new Date().toISOString()
        }
      }
    }
    const router = new ServiceConversationRouter({
      scope,
      store: journal,
      legacy: {
        execute: async () => {
          throw Error("LOCAL_BYPASS")
        },
        cancel: () => false
      },
      legacyRunId: null,
      model: async () => model,
      createExecutor(m, refusal) {
        original.model = "changed-after-router"
        return new PartnerRequirementExecutor({
          config: {
            spaceId: "A",
            nodeId: "node",
            ownerPrincipalId: "owner",
            modelRef: m.ref,
            modelConfigHash: m.hash,
            workspaces: new Map([["workspace", "/explicit"]])
          },
          control,
          threads: new PartnerTaskThreadStore(db),
          attempts: new PartnerRequirementAttemptStore(db),
          delivery,
          refusalCode: refusal
        })
      },
      claimed: () => {},
      finished: () => {}
    })
    const result = await router.execute(run)
    assert.equal(result.outcome, "failed")
    assert.equal(result.text, "EXECUTION_FAILED")
    assert.equal(models, 0)
    assert.equal(settles, 1)
    original.model = config.model
    const actual = await instantiateBoundServiceModel(
      config.ref,
      model.hash,
      original,
      async (snapshot) => {
        await Promise.resolve()
        original.model = "changed-while-importing"
        return snapshot.model
      }
    )
    assert.equal(actual, config.model)
  }))

test("single worker recovers authenticated RUNNING result_ready after model deletion; reserved/running remains unknown", () =>
  withSqlite(async (db) => {
    const input = inputFixture(),
      model = serviceModelBinding(config, config.ref),
      journal = new ServiceConversationStore(db),
      scope: ServiceScope = {
        url: "http://127.0.0.1:12345",
        spaceId: "A",
        businessPrincipalId: "business",
        ownerPrincipalId: "owner",
        nodeId: "node",
        workspaceRef: "workspace",
        groupId: "group",
        botId: "expert"
      },
      key = serviceScopeKey(scope),
      conversation = journal.conversation(scope),
      request = journal.accept(scope, conversation.id, null, "request", "需求", model)
    const run = {
      ...runFixture(),
      commandId: request.enqueueCommand,
      requesterPrincipalId: "business"
    }
    journal.saveTask(key, { ...journal.task(key, request.taskRef), task: input.task })
    journal.bind(key, {
      ...scope,
      commandId: run.commandId,
      taskId: run.taskId,
      taskVersion: 1,
      stageId: run.stageId,
      groupVersion: 1,
      botVersionId: run.botVersionId,
      deadline: run.deadline,
      model,
      kind: "service",
      runId: null,
      attemptId: null
    })
    let modelCalls = 0,
      settles = 0,
      loseSettlement = true,
      claimCalls = 0,
      recoverCalls = 0,
      modelLookups = 0
    class Fake extends PartnerFakeRequirementModel {
      override async _generate(messages: BaseMessage[]) {
        modelCalls++
        return super._generate(messages)
      }
    }
    registerPartnerInputOnlyImplementation(
      createInputOnlyRequirementImplementation({
        resolveThread(id) {
          const m = JSON.parse(
            String(db.exec("SELECT metadata FROM threads WHERE thread_id=?", [id])[0].values[0][0])
          )
          return { metadata: m, workspacePath: m.workspacePath }
        },
        resolveModel: () => new Fake({})
      })
    )
    let current: PartnerRequirementRun = run
    const control: PartnerRequirementControl = {
      start: async (r) => {
        current = { ...r, status: "running" }
        return { run: current, input }
      },
      renew: async (r) => r,
      settle: async (r, outcome, text) => {
        settles++
        if (loseSettlement) {
          loseSettlement = false
          throw new PartnerLocalFault("DEPENDENCY_UNAVAILABLE")
        }
        current = { ...r, status: outcome }
        return {
          runId: r.id,
          attemptId: r.attemptId,
          outcome,
          text,
          settledAt: new Date().toISOString()
        }
      }
    }
    const attempts = new PartnerRequirementAttemptStore(db)
    const executor = (m: typeof model) =>
      new PartnerRequirementExecutor({
        config: {
          spaceId: "A",
          nodeId: "node",
          ownerPrincipalId: "owner",
          modelRef: m.ref,
          modelConfigHash: m.hash,
          workspaces: new Map([["workspace", "/explicit"]])
        },
        control,
        threads: new PartnerTaskThreadStore(db),
        attempts,
        delivery
      })
    const router = (deleted = false) =>
      new ServiceConversationRouter({
        scope,
        store: journal,
        legacy: {
          execute: async () => {
            throw Error("LOCAL_BYPASS")
          },
          cancel: () => false
        },
        legacyRunId: null,
        model: async () => {
          modelLookups++
          if (deleted) throw new PartnerLocalFault("MODEL_UNAVAILABLE")
          return model
        },
        attemptState: (r) => attempts.get(r)?.state ?? null,
        createExecutor: executor,
        claimed: () => {},
        finished: () => {}
      })
    const client = {
      observe: async () => {},
      poll: async () =>
        ["starting", "running"].includes(current.status)
          ? [{ id: current.id, status: current.status }]
          : [],
      claim: async () => {
        claimCalls++
        return current
      },
      recover: async () => {
        recoverCalls++
        return current
      }
    }
    const first = new PartnerLocalWorker({
      client,
      executor: router(),
      onChange: () => {},
      pollMs: 10,
      heartbeatMs: 100000
    })
    await first.start()
    await waitFor(() => !first.isEnabled())
    await first.stop()
    assert.equal(attempts.get(current)?.state, "result_ready")
    assert.equal(modelCalls, 1)
    const second = new PartnerLocalWorker({
      client,
      executor: router(true),
      onChange: () => {},
      pollMs: 10,
      heartbeatMs: 100000
    })
    await second.start()
    await waitFor(() => current.status === "succeeded")
    await second.stop()
    assert.equal(modelCalls, 1)
    assert.equal(modelLookups, 1)
    assert.equal(recoverCalls, 1)
    assert.equal(claimCalls, 1)
    assert.equal(settles, 2)
    assert.equal(attempts.get(current)?.state, "settled")
    const unknown = {
      ...run,
      id: "unknown-run",
      attemptId: "unknown-attempt",
      commandId: "unknown-command",
      status: "running"
    }
    await assert.rejects(executor(model).execute(unknown), /OUTCOME_UNKNOWN/)
    assert.equal(modelCalls, 1)
  }))
