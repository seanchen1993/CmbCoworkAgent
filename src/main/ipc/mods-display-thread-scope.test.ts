import { describe, expect, it, vi } from "vitest"
import { captureDirectDisplayScope } from "./mods-display-thread-scope"

function fixture() {
  const state = {
    db: {},
    child: false,
    missing: false,
    created: 10,
    metadata: { workspacePath: "Project", cmb_thread_incarnation: "original" } as Record<
      string,
      unknown
    >
  }
  const read = vi.fn(() =>
    state.missing ? null : { created_at: state.created, metadata: JSON.stringify(state.metadata) }
  )
  const scope = captureDirectDisplayScope("project", "chat", {
    database: () => state.db,
    isChild: () => state.child,
    read,
    canonical: (path) => path.toLowerCase()
  })
  return { state, read, scope }
}

describe("direct Mods display scope", () => {
  it("reads one fresh row per check without reusing an earlier authorization", () => {
    const { read, scope, state } = fixture()
    scope.assertCurrent()
    expect(read).toHaveBeenCalledTimes(2)
    state.metadata.workspacePath = "another project"
    expect(scope.assertCurrent).toThrow("MODS_CALL_SCOPE_CHANGED")
    expect(read).toHaveBeenCalledTimes(3)
  })

  it.each([{ remoteState: "historical" }, { targetKind: "inbox", remoteReadOnly: true }])(
    "rechecks read-only flags before publishing",
    (flags) => {
      const { scope, state } = fixture()
      Object.assign(state.metadata, flags)
      expect(scope.assertCurrent).toThrow("MODS_THREAD_READ_ONLY")
    }
  )

  it("rejects a replaced thread, missing row, different database or child association", () => {
    for (const change of ["incarnation", "missing", "database", "child"]) {
      const { scope, state } = fixture()
      if (change === "incarnation") state.metadata.cmb_thread_incarnation = "recreated"
      if (change === "missing") state.missing = true
      if (change === "database") state.db = {}
      if (change === "child") state.child = true
      expect(scope.assertCurrent).toThrow("MODS_CALL_SCOPE_CHANGED")
    }
  })
})
