import { expect, it } from "vitest"
import { PromptEditController, type PromptEditSnapshot } from "./prompt-edit-controller"
import {
  applyPromptEdit,
  type FunctionPromptEditInput,
  type FunctionPromptEditResult
} from "../../../shared/mods/v2/prompt-edit"

const initial: PromptEditSnapshot = {
  owner: "actual",
  revision: 0,
  text: "",
  cursor: 0,
  selectionStart: 0,
  selectionEnd: 0,
  selectionDirection: "none",
  composing: false,
  available: true
}
function fixture(
  dispatch: (
    input: FunctionPromptEditInput,
    signal: AbortSignal
  ) => Promise<FunctionPromptEditResult>
) {
  let state = { ...initial }
  const inputs: FunctionPromptEditInput[] = []
  const controller = new PromptEditController({
    initial: state,
    read: () => state,
    dispatch: async (input, _token, signal) => {
      inputs.push(input)
      return dispatch(input, signal)
    },
    apply: (_expected, result) => {
      state = {
        ...state,
        ...result,
        selectionStart: result.cursor,
        selectionEnd: result.cursor,
        revision: state.revision + 1
      }
      return true
    }
  })
  const edit = (text: string, extra: Partial<PromptEditSnapshot> = {}) => {
    state = {
      ...state,
      text,
      cursor: text.length,
      selectionStart: text.length,
      selectionEnd: text.length,
      revision: state.revision + 1,
      ...extra
    }
    controller.change(state)
  }
  return {
    controller,
    edit,
    inputs,
    read: () => state,
    patch: (value: Partial<PromptEditSnapshot>) => {
      state = { ...state, ...value }
    }
  }
}

it("never promotes an unverified rejected X when Y arrives, even after an old reply", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const f = fixture(async (input) => {
    if (input.inputText === "X") {
      entered.resolve()
      await release.promise
    }
    return input.inputText.includes("X")
      ? { text: input.text, cursor: input.cursor }
      : applyPromptEdit(input)
  })
  f.edit("X")
  const flushed = f.controller.flush()
  await entered.promise
  f.edit("XY")
  release.resolve()
  expect(await flushed).toEqual({ text: "", cursor: 0 })
  expect(f.inputs[1]).toMatchObject({ text: "", inputText: "XY" })
  expect(f.read().text).toBe("")
})

it("pasted and typed bursts remain cumulative until accepted", async () => {
  const f = fixture(async (input) => applyPromptEdit(input))
  f.edit("paste")
  f.edit("paste-and-type")
  expect(await f.controller.flush()).toEqual({ text: "paste-and-type", cursor: 14 })
  expect(f.inputs).toHaveLength(1)
  expect(f.inputs[0]).toMatchObject({ text: "", inputText: "paste-and-type" })
  f.edit("paste-and-type!")
  await f.controller.flush()
  expect(f.inputs[1]).toMatchObject({ text: "paste-and-type", inputText: "!" })
})

it.each(["selection", "owner", "revision", "dialog"])(
  "a %s conflict cannot apply or send",
  async (kind) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const f = fixture(async (input) => {
      entered.resolve()
      await release.promise
      return applyPromptEdit(input)
    })
    f.edit("original")
    const result = f.controller.flush()
    const rejected = expect(result).rejects.toThrow("MODS_PROMPT_EDIT_CONFLICT")
    await entered.promise
    f.patch(
      kind === "selection"
        ? { selectionEnd: 0, selectionDirection: "backward" }
        : kind === "owner"
          ? { owner: "another" }
          : kind === "revision"
            ? { revision: 100 }
            : { available: false }
    )
    release.resolve()
    await rejected
    expect(f.read().text).toBe("original")
  }
)

it("does not process a half-composed draft and validates the full committed IME text before sending", async () => {
  const f = fixture(async (input) => ({
    text: applyPromptEdit(input).text.toUpperCase(),
    cursor: input.inputText.length
  }))
  f.edit("i", { composing: true })
  await expect(f.controller.flush()).rejects.toThrow("MODS_PROMPT_EDIT_COMPOSING")
  expect(f.inputs).toHaveLength(0)
  f.edit("你好", { composing: false })
  expect(await f.controller.flush()).toEqual({ text: "你好", cursor: 2 })
  expect(f.inputs[0]).toMatchObject({ text: "", inputText: "你好" })
})

it("close rejects an outstanding flush without applying its late result", async () => {
  const release = Promise.withResolvers<void>()
  const f = fixture(async (input) => {
    await release.promise
    return applyPromptEdit(input)
  })
  f.edit("pending")
  const result = f.controller.flush()
  const rejected = expect(result).rejects.toThrow("MODS_PROMPT_EDITOR_CLOSED")
  f.controller.close()
  release.resolve()
  await rejected
  expect(f.read().revision).toBe(1)
})

it("a trusted fill resets pending work, and the next edit starts at that explicit baseline", async () => {
  const f = fixture(async (input) => applyPromptEdit(input))
  f.edit("unconfirmed")
  f.patch({ text: "trusted", cursor: 7, selectionEnd: 7, revision: 10 })
  f.controller.reset(f.read())
  f.edit("trusted!")
  await f.controller.flush()
  expect(f.inputs[0]).toMatchObject({ text: "trusted", inputText: "!" })
})

it("reserves a running native rule for Enter and preserves the next draft", async () => {
  const release = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  const f = fixture(async (input, activeSignal) => {
    signal = activeSignal
    await release.promise
    const value = applyPromptEdit(input)
    return { text: value.text.toUpperCase(), cursor: value.cursor }
  })
  f.edit("first")
  const background = f.controller.flush()
  const captured = { ...f.read() }
  const submission = f.controller.flushSubmission(captured)
  f.edit("next draft")
  expect(signal?.aborted).toBe(false)
  expect(f.inputs).toHaveLength(1)
  release.resolve()
  expect(await submission).toEqual({ text: "FIRST", cursor: 5, revision: captured.revision })
  await background
  expect(f.read().text).toBe("next draft")
  await f.controller.flush()
  expect(f.read().text).toBe("NEXT DRAFT")
  expect(f.inputs).toHaveLength(2)
})

it("returns the normalized editor revision only when the captured draft still owns the editor", async () => {
  const f = fixture(async (input) => ({
    text: applyPromptEdit(input).text.toUpperCase(),
    cursor: 3
  }))
  f.edit("one")
  const captured = { ...f.read() }
  const result = await f.controller.flushSubmission(captured)
  expect(result).toEqual({ text: "ONE", cursor: 3, revision: captured.revision + 1 })
  expect(f.read().text).toBe("ONE")
})

it("retains the next draft on submission validation failure and permits a new send", async () => {
  const release = Promise.withResolvers<void>()
  let calls = 0
  const f = fixture(async (input) => {
    if (++calls === 1) {
      await release.promise
      throw Error("rule rejected")
    }
    return applyPromptEdit(input)
  })
  f.edit("rejected")
  const submission = f.controller.flushSubmission({ ...f.read() })
  const rejected = expect(submission).rejects.toThrow("rule rejected")
  f.edit("next")
  release.resolve()
  await rejected
  expect(f.read().text).toBe("next")
  expect(await f.controller.flushSubmission({ ...f.read() })).toMatchObject({ text: "next" })
})

it("refuses a reserved submission after editor ownership is lost", async () => {
  const release = Promise.withResolvers<void>()
  const f = fixture(async (input) => {
    await release.promise
    return applyPromptEdit(input)
  })
  f.edit("first")
  const submission = f.controller.flushSubmission({ ...f.read() })
  const rejected = expect(submission).rejects.toThrow("MODS_PROMPT_EDITOR_UNAVAILABLE")
  f.patch({ owner: "replacement" })
  release.resolve()
  await rejected
})

it("cannot finish a reserved send after a trusted editor reset cancels it", async () => {
  const release = Promise.withResolvers<void>()
  const f = fixture(async (input) => {
    await release.promise
    return applyPromptEdit(input)
  })
  f.edit("first")
  const submission = f.controller.flushSubmission({ ...f.read() })
  const rejected = expect(submission).rejects.toThrow()
  f.patch({ text: "trusted", revision: 9 })
  f.controller.reset(f.read())
  release.resolve()
  await rejected
  expect(f.read().text).toBe("trusted")
})
