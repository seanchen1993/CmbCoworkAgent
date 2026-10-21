import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { isModObject } from "../../../shared/mods/v2/contracts"
import type { FunctionUiAction } from "../../../shared/mods/v2/ui"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionPanes } from "./panes"

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

async function fixture(
  adapter: "panes" | "session",
  initiallyFocused = false,
  failDrawing = false
) {
  const focusEntered = barrier(),
    releaseFocus = barrier()
  const drawingEntered = barrier(),
    releaseDrawing = barrier()
  let armed = false
  let blockFocus = true
  const publish = async (value: ModJson): Promise<ModJson> => {
    if (
      armed &&
      Array.isArray(value) &&
      value.some((row) => isModObject(row) && row.key === "focus:board")
    ) {
      armed = false
      drawingEntered.release()
      await releaseDrawing.promise
      if (failDrawing) throw Error("protected drawing publication rejected")
    }
    return value
  }
  let panes: FunctionPanes
  if (adapter === "panes") {
    let count = 0
    panes = new FunctionPanes({
      plugins: [],
      assertLive() {
        /* This fixture remains live until the explicit cleanup. */
      },
      changed() {
        /* Test-controlled reads observe committed state without a UI scheduler. */
      },
      callback: async () => {},
      publish,
      dispatch: async (event, input, options): Promise<ModJson> => {
        if (event === "ui.render")
          return {
            type: "Text",
            props: {},
            children: [
              `focus:${count} focused:${isModObject(input.props) && input.props.isFocused}`
            ]
          }
        if (event === "ui.focus") {
          count++
          panes.invalidate()
          if (blockFocus) {
            focusEntered.release()
            await releaseFocus.promise
          }
        }
        return (await options.core?.(input, options.signal ?? new AbortController().signal)) ?? {}
      }
    })
    panes.open("focus", { id: "board" })
    cleanups.push(() => panes.close())
  } else {
    const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
      let count=0;
      on("session.start",async($,e,next)=>{await $.command.register({name:"open",description:"Open"});return next(e)});
      on("command.run",{command:"open"},async $=>{await $.ui.open({id:"board"});return {}});
      on("ui.focus",{component:"Pane",requestId:"board"},async($,e,next)=>{
        count++;$.ui.invalidate("ui.render");await $.store.set("focus-block",true);return next(e)
      });
      on("ui.render",{component:"Pane",requestId:"board"},($,e)=>
        $.ui.resolve(e).Text({children:"focus:"+count+" focused:"+String(e.props.isFocused)}));
    }}`)
    const state = new Map<string, ModJson>()
    const session = new FunctionSession(
      [
        {
          name: "focus",
          root: "/focus",
          tier: "user",
          guest,
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace: "/focus",
        threadId: "focus",
        assertLive() {
          /* This fixture remains live until the explicit cleanup. */
        },
        publish,
        state: () => ({
          get: async (key) => state.get(key),
          keys: async () => [...state.keys()],
          delete: (key) => {
            state.delete(key)
          },
          set: async (key, value) => {
            state.set(key, value)
            if (key === "focus-block" && blockFocus) {
              focusEntered.release()
              await releaseFocus.promise
            }
          }
        })
      }
    )
    cleanups.push(() => session.close())
    await session.run("open", "")
    panes = session.panes
  }
  if (initiallyFocused) {
    blockFocus = false
    const [initial] = await panes.snapshot()
    await panes.act({
      pane: initial.key,
      generation: initial.generation,
      plugin: initial.plugin,
      handle: 0,
      intentId: randomUUID(),
      kind: "focus",
      value: { focused: true }
    })
    blockFocus = true
  }
  cleanups.unshift(() => {
    releaseFocus.release()
    releaseDrawing.release()
  })
  return {
    panes,
    focusEntered: focusEntered.promise,
    drawingEntered: drawingEntered.promise,
    releaseFocus: releaseFocus.release,
    releaseDrawing: releaseDrawing.release,
    arm: () => {
      armed = true
    }
  }
}

describe("Pane focus state while an older protected snapshot is pending", () => {
  it.each([
    ["panes", "snapshot-first", true],
    ["panes", "focus-first", true],
    ["session", "snapshot-first", true],
    ["session", "focus-first", true],
    ["panes", "snapshot-first", false],
    ["panes", "focus-first", false],
    ["session", "snapshot-first", false],
    ["session", "focus-first", false]
  ] as const)(
    "preserves the latest state through %s / %s / focused=%s",
    async (adapter, order, focusedValue) => {
      const f = await fixture(adapter, !focusedValue)
      const [initial] = await f.panes.snapshot()
      const action: FunctionUiAction = {
        pane: initial.key,
        generation: initial.generation,
        plugin: initial.plugin,
        handle: 0,
        intentId: randomUUID(),
        kind: "focus",
        value: { focused: focusedValue }
      }
      const focused = f.panes.act(action)
      await f.focusEntered
      f.arm()
      const oldRead = f.panes.snapshot()
      await f.drawingEntered
      if (order === "snapshot-first") {
        f.releaseDrawing()
        const [old] = await oldRead
        expect(JSON.stringify(old.tree)).toContain(
          `focus:${focusedValue ? 1 : 2} focused:${!focusedValue}`
        )
        f.releaseFocus()
        await expect(focused).resolves.toEqual({ focused: focusedValue })
      } else {
        f.releaseFocus()
        await expect(focused).resolves.toEqual({ focused: focusedValue })
        f.releaseDrawing()
        const [old] = await oldRead
        expect(JSON.stringify(old.tree)).toContain(
          `focus:${focusedValue ? 1 : 2} focused:${!focusedValue}`
        )
      }
      // One normal read must observe the committed state; no polling or retry loop hides a lost update.
      const [latest] = await f.panes.snapshot()
      expect(JSON.stringify(latest.tree)).toContain(
        `focus:${focusedValue ? 1 : 2} focused:${focusedValue}`
      )
      const [stable] = await f.panes.snapshot()
      expect(stable.generation).toBe(latest.generation)
      expect(stable.tree).toEqual(latest.tree)
    }
  )
  it.each(["panes", "session"] as const)(
    "preserves newer focus if %s publication rejects",
    async (adapter) => {
      const f = await fixture(adapter, false, true)
      const [initial] = await f.panes.snapshot()
      const focused = f.panes.act({
        pane: initial.key,
        generation: initial.generation,
        plugin: initial.plugin,
        handle: 0,
        intentId: randomUUID(),
        kind: "focus",
        value: { focused: true }
      })
      await f.focusEntered
      f.arm()
      const oldRead = f.panes.snapshot()
      await f.drawingEntered
      f.releaseFocus()
      await expect(focused).resolves.toEqual({ focused: true })
      const rejected = expect(oldRead).rejects.toThrow("protected drawing publication rejected")
      f.releaseDrawing()
      await rejected
      const [latest] = await f.panes.snapshot()
      expect(JSON.stringify(latest.tree)).toContain("focus:1 focused:true")
      const [stable] = await f.panes.snapshot()
      expect(stable.generation).toBe(latest.generation)
    }
  )
})
