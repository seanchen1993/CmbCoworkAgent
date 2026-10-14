import { expect, it } from "vitest"
import { submitAfterPromptEdit } from "./prompt-edit-submission"
import { captureComposerSubmissionState } from "./composer-submission-state"

it("blocks double Enter during validation and submits the reserved normalized draft", async () => {
  const pending = Promise.withResolvers<void>()
  let draft = { text: "old", revision: 1 },
    calls = 0
  const options = {
    flush: async () => {
      const captured = { ...draft }
      await pending.promise
      return { ...captured, text: captured.text.toUpperCase() }
    },
    read: () => draft,
    submit: async (value: typeof draft) => {
      calls++
      return value
    }
  }
  const first = submitAfterPromptEdit("double", options)
  expect(await submitAfterPromptEdit("double", options)).toBeUndefined()
  draft = { text: "validated-new", revision: 2 }
  pending.resolve()
  expect(await first).toEqual({ text: "OLD", revision: 1 })
  expect(draft.text).toBe("validated-new")
  expect(calls).toBe(1)
})
it("releases the editor gate before the run completes so busy drafts can queue", async () => {
  const running = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>()
  const first = submitAfterPromptEdit("queue", {
    flush: async () => ({ text: "first", revision: 1 }),
    read: () => ({ text: "first", revision: 1 }),
    submit: () => {
      entered.resolve()
      return running.promise
    }
  })
  await entered.promise
  expect(
    await submitAfterPromptEdit("queue", {
      flush: async () => ({ text: "queued", revision: 2 }),
      read: () => ({ text: "queued", revision: 2 }),
      submit: async (value) => value.text
    })
  ).toBe("queued")
  running.resolve()
  await first
})
it("does not route failed validation and releases for an explicit retry", async () => {
  let calls = 0
  const options = {
    read: () => ({ text: "draft", revision: 1 }),
    submit: async () => {
      calls++
    },
    flush: async () => {
      throw Error("rule failed")
    }
  }
  await expect(submitAfterPromptEdit("retry", options)).rejects.toThrow("rule failed")
  expect(calls).toBe(0)
  await submitAfterPromptEdit("retry", { ...options, flush: async () => options.read() })
  expect(calls).toBe(1)
})
it("preserves the send intent when an edit arrives before the submit continuation", async () => {
  let draft = { text: "A", revision: 1 },
    calls = 0
  const sent: string[] = []
  await submitAfterPromptEdit("handoff", {
    read: () => draft,
    flush: async () => {
      const confirmed = { ...draft }
      if (++calls === 1)
        queueMicrotask(() => {
          draft = { text: "X", revision: 2 }
        })
      else draft = { text: "VALIDATED_X", revision: 3 }
      return calls === 1 ? confirmed : { ...draft }
    },
    submit: async (value) => {
      sent.push(value.text)
    }
  })
  expect(sent).toEqual(["A"])
  expect(draft.text).toBe("X")
  expect(calls).toBe(1)
})

it("does not submit a receipt invalidated by rule or editor replacement at handoff", async () => {
  let calls = 0
  await expect(
    submitAfterPromptEdit("stale-rules", {
      read: () => ({ text: "next", revision: 2 }),
      flush: async () => ({ text: "validated", revision: 1 }),
      isConfirmed: () => false,
      submit: async () => {
        calls++
      }
    })
  ).rejects.toThrow("MODS_PROMPT_EDIT_CONFLICT")
  expect(calls).toBe(0)
})

it.each(["attachments", "selectedSkill"] as const)(
  "does not consume new %s added while a real submission hook is pending",
  async (field) => {
    const release = Promise.withResolvers<void>()
    let payload = {
      approvalQueue: [],
      attachments: [] as object[],
      selectedSkill: null as object | null
    }
    let draft = { text: "first", revision: 1 },
      consumed = false
    const assertCurrent = captureComposerSubmissionState(() => payload)
    const submission = submitAfterPromptEdit("payload-" + field, {
      read: () => draft,
      flush: async () => {
        const original = { ...draft }
        await release.promise
        return original
      },
      assertCurrent,
      submit: async () => {
        consumed = true
        payload = { ...payload, attachments: [], selectedSkill: null }
      }
    })
    const rejected = expect(submission).rejects.toThrow("当前输入已保留")
    const added = field === "attachments" ? [{ id: "file" }] : { id: "skill" }
    payload = { ...payload, [field]: added }
    draft = { text: "next", revision: 2 }
    release.resolve()
    await rejected
    expect(consumed).toBe(false)
    expect(payload[field]).toBe(added)
    expect(draft.text).toBe("next")
  }
)
