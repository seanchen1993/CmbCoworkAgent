import { describe, expect, it, vi } from "vitest"
import type { ModConfigurationChangeEvent, ModUiChangeEvent } from "../../../shared/mods/types"
import {
  subscribeFunctionSiteCardsChanged as cards,
  subscribeFunctionSiteConfigurationChanged as configuration
} from "./function-site-events"

const event: ModUiChangeEvent = { threadId: "thread", scope: "records" }

function fixture() {
  const cardsListeners = new Set<(event: ModUiChangeEvent) => void>()
  const configurationListeners = new Set<(event?: ModConfigurationChangeEvent) => void>()
  const cardsReleased = vi.fn()
  const configurationReleased = vi.fn()
  const source = {
    onCardsChanged: vi.fn((callback: (event: ModUiChangeEvent) => void) => {
      cardsListeners.add(callback)
      return () => {
        cardsListeners.delete(callback)
        cardsReleased()
      }
    }),
    onConfigurationChanged: vi.fn((callback: (event?: ModConfigurationChangeEvent) => void) => {
      configurationListeners.add(callback)
      return () => {
        configurationListeners.delete(callback)
        configurationReleased()
      }
    })
  }
  return {
    source,
    cardsReleased,
    configurationReleased,
    emit: (value = event) => {
      for (const listener of [...cardsListeners]) listener(value)
    },
    configure: (value?: ModConfigurationChangeEvent) => {
      for (const listener of [...configurationListeners]) listener(value)
    }
  }
}

describe("FunctionSite shared native event subscriptions", () => {
  it("keeps one native listener for many slots and releases only the last reference", () => {
    const f = fixture()
    const calls: number[] = []
    const stops = Array.from({ length: 100 }, (_, index) =>
      cards(f.source, (received) => {
        expect(received).toBe(event)
        calls.push(index)
      })
    )
    expect(f.source.onCardsChanged).toHaveBeenCalledTimes(1)
    f.emit()
    expect(calls).toEqual(Array.from({ length: 100 }, (_, index) => index))
    for (const stop of stops.slice(0, -1)) stop()
    expect(f.cardsReleased).not.toHaveBeenCalled()
    stops.at(-1)!()
    stops.at(-1)!()
    expect(f.cardsReleased).toHaveBeenCalledTimes(1)
    const stopAgain = cards(f.source, () => {})
    expect(f.source.onCardsChanged).toHaveBeenCalledTimes(2)
    stopAgain()
  })

  it("treats repeated subscriptions of the same callback as independent references", () => {
    const f = fixture(),
      callback = vi.fn()
    const first = cards(f.source, callback),
      second = cards(f.source, callback)
    f.emit()
    expect(callback).toHaveBeenCalledTimes(2)
    first()
    f.emit()
    expect(callback).toHaveBeenCalledTimes(3)
    expect(f.cardsReleased).not.toHaveBeenCalled()
    second()
    expect(f.cardsReleased).toHaveBeenCalledTimes(1)
  })

  it("skips unmounted callbacks and defers new subscribers during synchronous fanout", () => {
    const f = fixture(),
      calls: string[] = []
    let stopSecond = () => {},
      stopNew = () => {}
    const stopFirst = cards(f.source, () => {
      calls.push("first")
      stopSecond()
      stopNew()
      stopNew = cards(f.source, () => {
        calls.push("new")
      })
    })
    stopSecond = cards(f.source, () => {
      calls.push("removed")
    })
    f.emit()
    expect(calls).toEqual(["first"])
    stopFirst()
    f.emit()
    expect(calls).toEqual(["first", "new"])
    stopNew()
  })

  it("keeps nested event order and never calls a callback after its own removal", () => {
    const f = fixture(),
      calls: string[] = []
    let stopFirst = () => {}
    stopFirst = cards(f.source, () => {
      calls.push("first")
      stopFirst()
      f.emit({ ...event, scope: "cards" })
    })
    const stopSecond = cards(f.source, (value) => {
      calls.push(value.scope ?? "missing")
    })
    f.emit()
    expect(calls).toEqual(["first", "cards", "records"])
    stopSecond()
  })

  it("ignores late native delivery after the final unsubscribe", () => {
    const f = fixture(),
      callback = vi.fn()
    const stop = cards(f.source, callback)
    const native = f.source.onCardsChanged.mock.calls[0][0]
    stop()
    native(event)
    expect(callback).not.toHaveBeenCalled()
    expect(f.cardsReleased).toHaveBeenCalledTimes(1)
  })

  it("closes before native release reenters and keeps a new listener generation independent", () => {
    const f = fixture(),
      oldCallback = vi.fn(),
      newCallback = vi.fn()
    const stopOld = cards(f.source, oldCallback)
    const oldNative = f.source.onCardsChanged.mock.calls[0][0]
    let stopNew = () => {}
    f.cardsReleased.mockImplementationOnce(() => {
      oldNative(event)
      stopNew = cards(f.source, newCallback)
    })
    stopOld()
    expect(oldCallback).not.toHaveBeenCalled()
    expect(f.source.onCardsChanged).toHaveBeenCalledTimes(2)
    f.emit()
    expect(newCallback).toHaveBeenCalledOnce()
    oldNative(event)
    expect(newCallback).toHaveBeenCalledOnce()
    stopNew()
    expect(f.cardsReleased).toHaveBeenCalledTimes(2)
  })

  it("isolates API objects and event types and forwards configuration synchronously", () => {
    const a = fixture(),
      b = fixture(),
      values: unknown[] = []
    const stopA = cards(a.source, (value) => {
      values.push(value)
    })
    const stopB = cards(b.source, () => {
      values.push("other")
    })
    const stopConfig = configuration(a.source, (value) => {
      values.push(value)
    })
    a.configure()
    a.configure({ scope: "schema" })
    a.emit()
    expect(values).toEqual([undefined, { scope: "schema" }, event])
    expect(a.source.onCardsChanged).toHaveBeenCalledTimes(1)
    expect(b.source.onCardsChanged).toHaveBeenCalledTimes(1)
    expect(a.source.onConfigurationChanged).toHaveBeenCalledTimes(1)
    stopA()
    expect(a.configurationReleased).not.toHaveBeenCalled()
    b.emit()
    expect(values.at(-1)).toBe("other")
    stopConfig()
    stopB()
  })

  it("runs every remaining revocation before rethrowing the first callback error", () => {
    const f = fixture(),
      revoked = vi.fn(),
      failure = new Error("callback")
    const first = cards(f.source, () => {
      throw failure
    })
    const second = cards(f.source, revoked)
    expect(() => f.emit()).toThrow(failure)
    expect(revoked).toHaveBeenCalledWith(event)
    first()
    second()
  })

  it("discards a failed native registration so a later subscription can retry", () => {
    const f = fixture()
    f.source.onCardsChanged.mockImplementationOnce(() => {
      throw new Error("registration")
    })
    expect(() => cards(f.source, () => {})).toThrow("registration")
    const callback = vi.fn(),
      stop = cards(f.source, callback)
    f.emit()
    expect(callback).toHaveBeenCalledOnce()
    expect(f.source.onCardsChanged).toHaveBeenCalledTimes(2)
    stop()
  })
})
