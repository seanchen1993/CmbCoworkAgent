import { describe, expect, it } from "vitest"
import {
  captureComposerSubmissionState,
  hasComposerSubmissionStateChanged
} from "./composer-submission-state"

const makeState = () => ({
  threadId: "thread",
  readOnly: false,
  contextReminderPending: false,
  effectiveInputDisabled: false,
  composerMode: "chat",
  selectedSkill: null as object | null,
  selectedBuiltinBrowser: null as object | null,
  attachments: [] as object[],
  mentionedFiles: [] as object[],
  isLoading: false,
  pendingApproval: null as object | null,
  approvalQueue: [] as object[],
  currentModel: "model",
  workspacePath: "project"
})

describe("composer submission state", () => {
  it("allows unrelated hydration to rebuild an empty approval tail", async () => {
    const admitted = makeState()
    const refreshed = await Promise.resolve({ ...admitted, approvalQueue: [].slice(1) })
    expect(hasComposerSubmissionStateChanged(admitted, refreshed)).toBe(false)
  })

  it("allows a new tail array containing the same approval objects in order", () => {
    const admitted = { ...makeState(), approvalQueue: [{ id: "a" }, { id: "b" }] }
    expect(
      hasComposerSubmissionStateChanged(admitted, {
        ...admitted,
        approvalQueue: [...admitted.approvalQueue]
      })
    ).toBe(false)
  })

  it("rejects added, removed, replaced and reordered approvals", () => {
    const first = { id: "a" },
      second = { id: "b" }
    const admitted = { ...makeState(), approvalQueue: [first, second] }
    for (const approvalQueue of [
      [first, second, { id: "c" }],
      [first],
      [{ id: "a" }, second],
      [second, first]
    ]) {
      expect(hasComposerSubmissionStateChanged(admitted, { ...admitted, approvalQueue })).toBe(true)
    }
  })

  it("preserves the guard for every other submission field", () => {
    const admitted = makeState()
    const changes = {
      threadId: "other",
      readOnly: true,
      contextReminderPending: true,
      effectiveInputDisabled: true,
      composerMode: "flow",
      selectedSkill: {},
      selectedBuiltinBrowser: {},
      attachments: [],
      mentionedFiles: [],
      isLoading: true,
      pendingApproval: {},
      currentModel: "other",
      workspacePath: "other"
    }
    for (const [key, value] of Object.entries(changes)) {
      expect(
        hasComposerSubmissionStateChanged(admitted, {
          ...admitted,
          [key]: value
        }),
        key
      ).toBe(true)
    }
  })

  it("rejects cancelling the head or promoting the next approval", () => {
    const head = { id: "head" },
      next = { id: "next" }
    const admitted: ReturnType<typeof makeState> = {
      ...makeState(),
      pendingApproval: head,
      approvalQueue: [next]
    }
    expect(
      hasComposerSubmissionStateChanged(admitted, {
        ...admitted,
        pendingApproval: null,
        approvalQueue: []
      })
    ).toBe(true)
    expect(
      hasComposerSubmissionStateChanged(admitted, {
        ...admitted,
        pendingApproval: next,
        approvalQueue: []
      })
    ).toBe(true)
    expect(
      hasComposerSubmissionStateChanged(admitted, {
        ...admitted,
        pendingApproval: { id: "head" }
      })
    ).toBe(true)
  })
})

describe("Enter-time non-text admission", () => {
  it.each([
    "attachments",
    "mentionedFiles",
    "selectedSkill",
    "selectedBuiltinBrowser",
    "currentModel",
    "pendingApproval",
    "approvalQueue",
    "composerMode",
    "workspacePath"
  ] as const)(
    "rejects a changed %s after an asynchronous hook without consuming it",
    async (key) => {
      let state = makeState()
      const assertCurrent = captureComposerSubmissionState(() => state)
      await Promise.resolve()
      const value = ["attachments", "mentionedFiles", "approvalQueue"].includes(key)
        ? [{ id: "new" }]
        : ["currentModel", "composerMode", "workspacePath"].includes(key)
          ? "changed"
          : { id: "new" }
      state = { ...state, [key]: value }
      expect(assertCurrent).toThrow("当前输入已保留")
      expect(state[key]).toBe(value)
    }
  )

  it("rejects file reordering and a model selection changed away and back", () => {
    const first = { id: "a" },
      second = { id: "b" }
    let state = { ...makeState(), attachments: [first, second] }
    const assertCurrent = captureComposerSubmissionState(() => state)
    state = { ...state, attachments: [second, first] }
    expect(assertCurrent).toThrow()
    let intentCurrent = true
    const assertModel = captureComposerSubmissionState(
      () => state,
      () => intentCurrent
    )
    intentCurrent = false
    expect(assertModel).toThrow()
  })

  it("allows new text and equivalent approval hydration without changing payload intent", () => {
    let state = makeState()
    let draft = "first"
    const assertCurrent = captureComposerSubmissionState(() => state)
    draft = "next"
    state = { ...state, approvalQueue: [] }
    expect(assertCurrent).not.toThrow()
    expect(draft).toBe("next")
  })
})
