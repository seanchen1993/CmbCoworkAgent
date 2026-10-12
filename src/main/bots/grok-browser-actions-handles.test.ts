import { describe, expect, it } from "vitest"
import type { BrowserContext, Page } from "playwright"
import {
  executeGrokBrowserAction,
  refHandle,
  type GrokBrowserState
} from "./upstream/grok-browser-actions.js"

type Action = Record<string, unknown> & { op: string }
type Handle = {
  disposeCount: number
  asElement(): Handle | null
  dispose(): Promise<void>
  click(): Promise<void>
  fill(): Promise<void>
  selectOption(): Promise<string[]>
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>
  scrollIntoViewIfNeeded(): Promise<void>
  evaluate(): Promise<void>
}

// The real action module owns these remote-object lifetimes. This fixture tracks
// allocation/release at Page.evaluateHandle; it does not reproduce action code.
function fixture(options: { fail?: string; nullBox?: string; disposeFailure?: boolean } = {}) {
  const retained = new Set<Handle>()
  const allocated: Handle[] = []
  const performed: string[] = []
  const failure = new Error("original action failure")
  let cdpSessions = 0
  const operation = async (name: string) => {
    performed.push(name)
    if (options.fail === name) throw failure
  }
  const page = {
    isClosed: () => false,
    setDefaultTimeout: () => {},
    bringToFront: () => operation("bringToFront"),
    waitForLoadState: () => operation("waitForLoadState"),
    evaluateHandle: async (_program: unknown, ref: string) => {
      if (options.fail === `resolve:${ref}`) throw failure
      const handle: Handle = {
        disposeCount: 0,
        asElement: () => (ref === "missing" ? null : handle),
        dispose: async () => {
          handle.disposeCount++
          retained.delete(handle)
          if (options.disposeFailure) throw new Error("cleanup failure")
        },
        click: () => operation(`click:${ref}`),
        fill: () => operation(`fill:${ref}`),
        selectOption: async () => {
          await operation(`selectOption:${ref}`)
          return ["selected"]
        },
        boundingBox: async () => {
          await operation(`boundingBox:${ref}`)
          return options.nullBox === ref ? null : { x: 10, y: 20, width: 30, height: 40 }
        },
        scrollIntoViewIfNeeded: () => operation(`scroll:${ref}`),
        evaluate: () => operation(`evaluate:${ref}`)
      }
      allocated.push(handle)
      retained.add(handle)
      return handle
    },
    keyboard: {
      type: () => operation("keyboard:type"),
      press: () => operation("keyboard:press")
    },
    mouse: {
      move: () => operation("mouse:move"),
      down: () => operation("mouse:down"),
      up: () => operation("mouse:up")
    }
  } as unknown as Page
  const context = {
    pages: () => [page],
    newCDPSession: async () => {
      cdpSessions++
      return {
        send: async () => ({ targetInfo: { targetId: "owned-page" } }),
        detach: async () => {
          cdpSessions--
        }
      }
    }
  } as unknown as Pick<BrowserContext, "pages" | "newPage" | "newCDPSession">
  const state: GrokBrowserState = { views: { owned: "owned-page" }, lastViewId: "owned" }
  const execute = (action: Action) => executeGrokBrowserAction(action, context, state)
  const released = () => {
    expect(retained.size).toBe(0)
    expect(allocated.every((handle) => handle.disposeCount === 1)).toBe(true)
    expect(cdpSessions).toBe(0)
  }
  return { allocated, retained, page, context, state, execute, failure, performed, released }
}

describe("browser navigation outcome classification", () => {
  it.each(
    [
      "ERR_HTTP_RESPONSE_CODE_FAILURE",
      "ERR_NAME_NOT_RESOLVED",
      "ERR_CONNECTION_REFUSED",
      "ERR_CONNECTION_CLOSED",
      "ERR_CONNECTION_RESET",
      "ERR_EMPTY_RESPONSE"
    ].flatMap((code) => [false, true].map((newTab) => ({ code, newTab })))
  )("retains a known $code without retrying (newTab=$newTab)", async ({ code, newTab }) => {
    const f = fixture()
    let requests = 0
    f.context.newPage = async () => f.page
    f.page.goto = async () => {
      requests++
      throw new Error("page.goto: net::" + code)
    }
    const result = await f.execute({ op: "navigate", url: "https://example.test/", newTab })
    expect(JSON.parse(result.data!)).toEqual({
      navigation: {
        status: code === "ERR_HTTP_RESPONSE_CODE_FAILURE" ? "http_error" : "network_error",
        errorCode: code
      },
      requiresObservation: true
    })
    expect(result.page).toBe(f.page)
    expect(requests).toBe(1)
    expect(f.performed).not.toContain("waitForLoadState")
    f.released()
  })

  it.each([
    "Timeout 25000ms exceeded",
    "net::ERR_ABORTED",
    "net::ERR_CONNECTION_TIMED_OUT",
    "Target page has been closed",
    "Browser disconnected"
  ])("does not turn an uncertain %s into a completed navigation", async (message) => {
    const f = fixture()
    const failure = new Error(message)
    f.page.goto = async () => {
      throw failure
    }
    await expect(f.execute({ op: "navigate", url: "https://example.test/" })).rejects.toBe(failure)
    f.released()
  })

  it("revalidates the original input owner before returning a known HTTP outcome", async () => {
    const f = fixture()
    let dispatched = false
    f.page.goto = async () => {
      dispatched = true
      throw new Error("page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE")
    }
    const retired = new Error("original owner retired")
    await expect(
      executeGrokBrowserAction(
        { op: "navigate", url: "https://example.test/" },
        f.context,
        f.state,
        {
          prepare: async () => {},
          assert: () => {
            if (dispatched) throw retired
          }
        }
      )
    ).rejects.toBe(retired)
    f.released()
  })
})

const actions: Action[] = [
  { op: "click", ref: "source", offsetX: 2 },
  { op: "type", ref: "source", text: "hello", clear: true, submit: true },
  { op: "fill", ref: "source", value: "hello" },
  { op: "select_option", ref: "source", values: ["selected"] },
  { op: "scroll", ref: "source" },
  { op: "drag", sourceRef: "source", targetRef: "target" },
  { op: "get_bounding_box", ref: "source" },
  { op: "highlight", ref: "source" }
]

describe("browser action remote handle ownership", () => {
  it("releases repeated action handles without waiting for page navigation", async () => {
    const f = fixture()
    for (let index = 0; index < 50; index++)
      await f.execute({ op: "fill", ref: "source", value: String(index) })
    expect(f.performed.filter((name) => name === "fill:source")).toHaveLength(50)
    f.released()
  })

  it.each(actions)("releases a successful $op operation exactly once", async (action) => {
    const f = fixture()
    expect((await f.execute(action)).page).toBe(f.page)
    f.released()
  })

  it.each([
    [{ op: "click", ref: "source" }, "click:source"],
    [{ op: "type", ref: "source", text: "hello" }, "keyboard:type"],
    [{ op: "fill", ref: "source", value: "hello" }, "fill:source"],
    [{ op: "select_option", ref: "source", values: ["selected"] }, "selectOption:source"],
    [{ op: "scroll", ref: "source" }, "scroll:source"],
    [{ op: "get_bounding_box", ref: "source" }, "boundingBox:source"],
    [{ op: "highlight", ref: "source" }, "evaluate:source"],
    [{ op: "drag", sourceRef: "source", targetRef: "target" }, "resolve:target"],
    [{ op: "drag", sourceRef: "source", targetRef: "target" }, "boundingBox:target"],
    [{ op: "drag", sourceRef: "source", targetRef: "target" }, "mouse:move"]
  ] satisfies [Action, string][])("releases handles when %j fails at %s", async (action, fail) => {
    const f = fixture({ fail })
    await expect(f.execute(action)).rejects.toBe(f.failure)
    f.released()
  })

  it.each(["source", "target"])(
    "releases drag handles when %s has no bounding box",
    async (nullBox) => {
      const f = fixture({ nullBox })
      await expect(
        f.execute({ op: "drag", sourceRef: "source", targetRef: "target" })
      ).rejects.toThrow("no visible bounding box")
      f.released()
    }
  )

  it("releases a non-element handle before rejecting a stale ref", async () => {
    const f = fixture()
    await expect(refHandle(f.page, "missing")).rejects.toThrow("Unknown or stale ref")
    f.released()
  })

  it("retains directly requested handles for their review/secret owner", async () => {
    const f = fixture()
    const element = await refHandle(f.page, "source")
    expect(f.retained.size).toBe(1)
    expect(f.allocated[0].disposeCount).toBe(0)
    await element.dispose()
    f.released()
  })

  it.each([false, true])(
    "does not replace an action result with a disposal error (actionFailed=%s)",
    async (actionFailed) => {
      const f = fixture({ disposeFailure: true, ...(actionFailed ? { fail: "fill:source" } : {}) })
      const result = f.execute({ op: "fill", ref: "source", value: "hello" })
      if (actionFailed) await expect(result).rejects.toBe(f.failure)
      else expect((await result).summary).toContain("Filled")
      f.released()
    }
  )
})

it("releases the pressed button even when an original drag error and mouse cleanup both fail", async () => {
  const f = fixture()
  let moves = 0
  const move = f.page.mouse.move.bind(f.page.mouse)
  const original = new Error("original move failed")
  f.page.mouse.move = async (...args) => {
    await move(...args)
    if (++moves === 2) throw original
  }
  f.page.mouse.up = async () => {
    f.performed.push("mouse:up")
    throw new Error("cleanup failed")
  }
  await expect(f.execute({ op: "drag", sourceRef: "source", targetRef: "target" })).rejects.toBe(
    original
  )
  expect(f.performed.filter((item) => item === "mouse:up")).toHaveLength(1)
  f.released()
})

it("does not type or submit after the requested clear fails", async () => {
  const f = fixture({ fail: "fill:source" })
  await expect(
    f.execute({ op: "type", ref: "source", text: "new text", clear: true, submit: true })
  ).rejects.toBe(f.failure)
  expect(f.performed).toContain("fill:source")
  expect(f.performed).not.toContain("keyboard:type")
  expect(f.performed).not.toContain("keyboard:press")
  f.released()
})

it("does not repeat a native selection after the first response fails", async () => {
  const f = fixture({ fail: "selectOption:source" })
  await expect(
    f.execute({ op: "select_option", ref: "source", values: ["Option label"] })
  ).rejects.toBe(f.failure)
  expect(f.performed.filter((item) => item === "selectOption:source")).toHaveLength(1)
  f.released()
})
