import { expect, it } from "vitest"
import {
  createRootShellNavigationState,
  recordRootShellAgentSelection,
  resolveRootShellNavigation
} from "../components/bots/upstream/grok-navigation-history"

it("returns through visits, skips unavailable Bots and truncates forward history on a fresh selection", () => {
  let state = createRootShellNavigationState()
  for (const id of ["a", "b", "c"]) state = recordRootShellAgentSelection(state, id)
  const back = resolveRootShellNavigation(state, new Set(["a", "c"]), "back")!
  expect(back.targetId).toBe("a")
  state = recordRootShellAgentSelection(back.state, "a")
  expect(state.entries).toEqual(["a", "b", "c"])
  expect(resolveRootShellNavigation(state, new Set(["a", "c"]), "forward")?.targetId).toBe("c")
  state = recordRootShellAgentSelection(state, "d")
  expect(state.entries).toEqual(["a", "d"])
  expect(resolveRootShellNavigation(state, new Set(["a", "c", "d"]), "forward")).toBeNull()
})
it("does not retain unlimited navigation or duplicate refresh selections", () => {
  let state = createRootShellNavigationState()
  for (let i = 0; i < 500; i++) state = recordRootShellAgentSelection(state, String(i))
  expect(state.entries).toHaveLength(200)
  expect(state.cursor).toBe(199)
  expect(recordRootShellAgentSelection(state, "499")).toBe(state)
  expect(state.entries[0]).toBe("300")
})
