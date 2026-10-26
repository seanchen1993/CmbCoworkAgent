import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock("../app-attention-events", () => ({ emitAppAttention: () => {} }))
import {
  HostUserInputStore,
  type HostUserInputBinding,
  type HostContextResumeProof
} from "./host-user-input-store"
import {
  bindHostUserInputScope,
  configureHostUserInputPersistence,
  requestUserInput,
  getPendingUserInputForThread,
  submitUserInputResponse,
  cancelUserInputsForThread,
  markHostInputExternalBoundary,
  prepareHostInputInterrupt,
  claimHostInputContinuation
} from "./user-input"
import type { UserInputRequest, UserInputResponse } from "../types"
import { FunctionUiSites } from "../mods/v2/sites"

const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((run) => run())
  configureHostUserInputPersistence(undefined)
})
const binding: HostUserInputBinding = {
  projectId: "project",
  operationId: "operation",
  stageId: "draft",
  installedPluginId: "installation",
  expectedVersion: 1,
  pluginDigest: "a".repeat(64),
  inputFingerprint: "b".repeat(64),
  incarnationKey: JSON.stringify({ token: "thread-generation", legacyCreatedAt: 1 })
}
const request: UserInputRequest = {
  requestId: "request",
  threadId: "host-thread",
  createdAt: "2026-10-23T00:00:00.000Z",
  questions: [
    {
      id: "choice",
      header: "Choice",
      question: "Which input?",
      options: [
        { label: "One", description: "First input" },
        { label: "Two", description: "Second input" }
      ]
    }
  ]
}
function answer(requestId: string, index = 0): UserInputResponse {
  return {
    requestId,
    answers: {
      choice: {
        type: "option",
        questionId: "choice",
        optionIndex: index,
        label: "untrusted",
        description: "untrusted"
      }
    }
  }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "host-input-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "input.sqlite")
  const store = new HostUserInputStore(path)
  cleanup.push(() => store.close())
  const isCurrent = vi.fn(() => true)
  configureHostUserInputPersistence({ store: () => store, isCurrent })
  return { store, path, isCurrent }
}

function questionSites() {
  const sites = new FunctionUiSites({
    plugins: [],
    assertLive: vi.fn(),
    changed: vi.fn(),
    publish: async (value) => value,
    dispatch: async (_event, input, options) =>
      options.core ? options.core(input, new AbortController().signal) : { type: "engine", ref: 0 },
    callback: async () => undefined,
    pendingQuestion: () => getPendingUserInputForThread(request.threadId)
  })
  cleanup.push(() => sites.close())
  return sites
}

function durableQuestion() {
  const release = bindHostUserInputScope(request.threadId, binding, () => {})
  const record = prepareHostInputInterrupt(request.threadId, "native-question", request.questions)!
  release()
  return record
}

const questionProps = {
  tool: "request_user_input",
  questions: JSON.parse(JSON.stringify(request.questions))
}

it("pins a durable native question across fresh database reads and accepts its first answer", async () => {
  const f = fixture()
  const record = durableQuestion()
  const first = getPendingUserInputForThread(request.threadId)!
  const reads = f.isCurrent.mock.calls.length
  expect(getPendingUserInputForThread(request.threadId)).toBe(first)
  expect(f.isCurrent.mock.calls.length).toBe(reads + 1)
  expect(first.recoveryRequired).toBe(false)
  expect(Object.isFrozen(first)).toBe(true)
  expect(Object.isFrozen(first.questions[0].options[0])).toBe(true)
  expect(() => {
    first.questions[0].options[0].label = "changed"
  }).toThrow()

  const sites = questionSites()
  const owner = await sites.mount("AskUserQuestion", undefined, record.request.requestId)
  await expect(sites.render(owner, questionProps)).resolves.toBeDefined()
  expect(submitUserInputResponse(answer(first.requestId))).toBe(true)
  expect(f.store.get(first.requestId)?.status).toBe("answered")
  expect(getPendingUserInputForThread(request.threadId)).toBeNull()
  await expect(sites.render(owner, questionProps)).rejects.toThrow("MODS_UI_QUESTION_STALE")
})

it("replaces a durable question view when recovery evidence changes and rejects the old card", async () => {
  const f = fixture()
  durableQuestion()
  const first = getPendingUserInputForThread(request.threadId)!
  const sites = questionSites()
  const owner = await sites.mount("AskUserQuestion", undefined, first.requestId)
  f.store.disqualifyContinuation(binding.operationId)
  const recovered = getPendingUserInputForThread(request.threadId)!
  expect(recovered).not.toBe(first)
  expect(recovered.recoveryRequired).toBe(true)
  expect(getPendingUserInputForThread(request.threadId)).toBe(recovered)
  await expect(sites.render(owner, questionProps)).rejects.toThrow("MODS_UI_QUESTION_STALE")
  const replacement = await sites.mount("AskUserQuestion", undefined, recovered.requestId)
  await expect(sites.render(replacement, questionProps)).resolves.toBeDefined()
})

it("revalidates durable view authority on every native read and never revives a cancelled card", async () => {
  const f = fixture()
  durableQuestion()
  const first = getPendingUserInputForThread(request.threadId)!
  const sites = questionSites()
  const owner = await sites.mount("AskUserQuestion", undefined, first.requestId)
  f.isCurrent.mockReturnValue(false)
  await expect(sites.render(owner, questionProps)).rejects.toThrow("MODS_UI_QUESTION_STALE")
  expect(f.store.get(first.requestId)?.status).toBe("cancelled")
  f.isCurrent.mockReturnValue(true)
  expect(getPendingUserInputForThread(request.threadId)).toBeNull()
  expect(submitUserInputResponse(answer(first.requestId))).toBe(false)
})

it("rotates same-id native question identity on persistence reconfiguration and store replacement", async () => {
  const f = fixture()
  durableQuestion()
  const sites = questionSites()
  const first = getPendingUserInputForThread(request.threadId)!
  const owner = await sites.mount("AskUserQuestion", undefined, first.requestId)
  configureHostUserInputPersistence({ store: () => f.store, isCurrent: f.isCurrent })
  const rebound = getPendingUserInputForThread(request.threadId)!
  expect(rebound).toEqual(first)
  expect(rebound).not.toBe(first)
  await expect(sites.render(owner, questionProps)).rejects.toThrow("MODS_UI_QUESTION_STALE")
  const reopened = new HostUserInputStore(f.path)
  cleanup.push(() => reopened.close())
  configureHostUserInputPersistence({ store: () => reopened, isCurrent: f.isCurrent })
  expect(getPendingUserInputForThread(request.threadId)).not.toBe(rebound)
  const replacement = await sites.mount("AskUserQuestion", undefined, first.requestId)
  await expect(sites.render(replacement, questionProps)).resolves.toBeDefined()
})

it("retains a main-issued context proof across restart and rejects an alien operation binding", () => {
  const f = fixture()
  const proof: HostContextResumeProof = {
    authority: {
      protocol: "devclaw.native-project-context-readonly/v1",
      workspace: "C:/workspace",
      threadId: request.threadId,
      operationId: binding.operationId,
      inputIdentity: binding.inputFingerprint,
      policy: "native-materials-only/v1",
      provider: {
        pluginId: "provider",
        plugin: "selector",
        digest: "c".repeat(64),
        actionId: "select"
      }
    },
    providerId: "context",
    runId: "flow",
    executionId: "execution",
    definitionDigest: "d".repeat(64),
    canonicalContextDigest: "e".repeat(64)
  }
  cleanup.push(
    bindHostUserInputScope(request.threadId, binding, () => {}, "context", undefined, proof)
  )
  const waiting = prepareHostInputInterrupt(request.threadId, "ask", request.questions)!
  const reopened = new HostUserInputStore(f.path)
  cleanup.push(() => reopened.close())
  expect(reopened.get(waiting.request.requestId)?.continuation?.contextResumeProof).toEqual(proof)
  expect(() =>
    reopened.create({ ...request, requestId: "alien" }, binding, {
      ...waiting.continuation!,
      contextResumeProof: { ...proof, authority: { ...proof.authority, operationId: "other" } }
    })
  ).toThrow("HOST_USER_INPUT_CONTEXT_PROOF_INVALID")
})

it("persists a real waiting request and consumes a canonical answer once on the live run", async () => {
  const f = fixture()
  const assertCurrent = vi.fn()
  const release = bindHostUserInputScope(request.threadId, binding, assertCurrent)
  cleanup.push(release)
  const pending = requestUserInput({ threadId: request.threadId, questions: request.questions })
  const shown = getPendingUserInputForThread(request.threadId)!
  expect(f.store.get(shown.requestId)).toMatchObject({ binding, status: "waiting" })
  expect(submitUserInputResponse({ requestId: shown.requestId, answers: {}, ignored: true })).toBe(
    true
  )
  expect(getPendingUserInputForThread(request.threadId)?.requestId).toBe(shown.requestId)
  expect(submitUserInputResponse(answer(shown.requestId))).toBe(true)
  expect(await pending).toMatchObject({
    answers: { choice: { label: "One", description: "First input" } }
  })
  expect(f.store.get(shown.requestId)?.status).toBe("consumed")
  expect(submitUserInputResponse(answer(shown.requestId))).toBe(true)
  expect(submitUserInputResponse(answer(shown.requestId, 1))).toBe(false)
  expect(assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(3)
})

it("reopens a durable request as recovery-only and saves the answer without inventing a continuation", () => {
  const f = fixture()
  f.store.create(request, binding)
  const reopened = new HostUserInputStore(f.path)
  cleanup.push(() => reopened.close())
  configureHostUserInputPersistence({ store: () => reopened, isCurrent: f.isCurrent })
  expect(getPendingUserInputForThread(request.threadId)).toMatchObject({
    requestId: request.requestId,
    recoveryRequired: true,
    questions: request.questions
  })
  expect(submitUserInputResponse(answer(request.requestId))).toBe(true)
  expect(reopened.get(request.requestId)?.status).toBe("answered")
  expect(getPendingUserInputForThread(request.threadId)).toBeNull()
  expect(submitUserInputResponse(answer(request.requestId))).toBe(true)
  expect(submitUserInputResponse(answer(request.requestId, 1))).toBe(false)
})

it("expires recovered input when its operation, installation or thread binding is revoked", () => {
  const f = fixture()
  f.store.create(request, binding)
  f.isCurrent.mockReturnValue(false)
  expect(getPendingUserInputForThread(request.threadId)).toBeNull()
  expect(f.store.get(request.requestId)?.status).toBe("cancelled")
  expect(submitUserInputResponse(answer(request.requestId))).toBe(false)
})

it("revalidates authority and input identity before a live answer can resume its original run", async () => {
  const f = fixture()
  let current = true
  cleanup.push(
    bindHostUserInputScope(request.threadId, binding, () => {
      if (!current) throw Error("INPUT_CHANGED")
    })
  )
  const pending = requestUserInput({ threadId: request.threadId, questions: request.questions })
  const rejected = expect(pending).rejects.toThrow("HOST_USER_INPUT_SCOPE_CHANGED")
  const id = getPendingUserInputForThread(request.threadId)!.requestId
  current = false
  expect(submitUserInputResponse(answer(id))).toBe(false)
  await rejected
  expect(f.store.get(id)?.status).toBe("cancelled")
})

it("records cancellation and rejects answers to a cancelled durable request", async () => {
  const f = fixture()
  cleanup.push(bindHostUserInputScope(request.threadId, binding, () => {}))
  const controller = new AbortController()
  const pending = requestUserInput({
    threadId: request.threadId,
    questions: request.questions,
    abortSignal: controller.signal
  })
  const rejected = expect(pending).rejects.toThrow("cancelled")
  const id = getPendingUserInputForThread(request.threadId)!.requestId
  controller.abort()
  await rejected
  expect(f.store.get(id)?.status).toBe("cancelled")
  expect(submitUserInputResponse(answer(id))).toBe(false)
})

it("requires explicit cancellation of a recovered request and never times out into a default answer", async () => {
  const f = fixture()
  cleanup.push(bindHostUserInputScope(request.threadId, binding, () => {}))
  await expect(
    requestUserInput({
      threadId: request.threadId,
      questions: request.questions,
      autoResolutionMs: 30_000
    })
  ).rejects.toThrow("AUTO_RESOLUTION_UNSUPPORTED")
  f.store.create(request, binding)
  expect(cancelUserInputsForThread(request.threadId, "Task cancelled")).toBe(1)
  expect(f.store.get(request.requestId)).toMatchObject({
    status: "cancelled",
    reason: "Task cancelled"
  })
})

it("never upgrades an observed external Hook lifetime into a resumable checkpoint", () => {
  const f = fixture()
  // Ordinary conversations have no Host scope and this has no effect on their input lifecycle.
  markHostInputExternalBoundary("ordinary-thread")
  cleanup.push(bindHostUserInputScope(request.threadId, binding, () => {}))
  markHostInputExternalBoundary(request.threadId)
  expect(
    prepareHostInputInterrupt(request.threadId, "input-call", request.questions)
  ).toBeUndefined()
  expect(f.store.pending(request.threadId)).toBeUndefined()
})

it("invalidates an already displayed checkpoint when an external Hook starts before settlement", () => {
  const f = fixture()
  cleanup.push(bindHostUserInputScope(request.threadId, binding, () => {}))
  const interrupted = prepareHostInputInterrupt(request.threadId, "input-call", request.questions)!
  expect(interrupted.continuation?.priorToolsSettled).toBe(true)
  markHostInputExternalBoundary(request.threadId)
  expect(f.store.get(interrupted.request.requestId)).toMatchObject({
    continuation: { priorToolsSettled: false },
    reason: "HOST_INPUT_UNPROVED_EXTERNAL_LIFETIME"
  })
  expect(getPendingUserInputForThread(request.threadId)?.recoveryRequired).toBe(true)
  expect(submitUserInputResponse(answer(interrupted.request.requestId))).toBe(true)
  expect(() => claimHostInputContinuation(interrupted.request.requestId)).toThrow(
    "CONTINUATION_UNAVAILABLE"
  )
  expect(f.store.get(interrupted.request.requestId)?.status).toBe("answered")
})
