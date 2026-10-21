import { describe, expect, it, vi } from "vitest"
import { prepareDevelopmentCreation, type DevelopmentSetupApi } from "./development-creation-setup"
import type { ModWorkspaceStatus } from "../../../../shared/mods/types"

function fixture(global = false, enabled = false) {
  let status: ModWorkspaceStatus = {
    workspace: "C:/Project", enabled, outputPolicy: true, mods: [], diagnostics: []
  }
  const api = {
    globalEnabled: vi.fn(async () => global),
    status: vi.fn(async () => ({ ...status })),
    configureGlobal: vi.fn(async (value: boolean) => { global = value; return value }),
    configure: vi.fn(async (_thread: string, value: boolean, policy: boolean, workspace: string) => {
      expect(workspace).toBe(status.workspace)
      status = { ...status, enabled: value, outputPolicy: policy }
    })
  } satisfies DevelopmentSetupApi
  return { api, change: (next: Partial<ModWorkspaceStatus>) => { status = { ...status, ...next } } }
}

describe("explicit creation setup", () => {
  it("enables only required switches, preserving output policy and canonical workspace", async () => {
    const { api } = fixture()
    await prepareDevelopmentCreation(api, "thread", "c:/project", () => {})
    expect(api.configureGlobal).toHaveBeenCalledWith(true)
    expect(api.configure).toHaveBeenCalledWith("thread", true, true, "C:/Project")
  })
  it.each(["C:/Repo/A", "C:\\REPO\\A"])(
    "writes only the fresh native canonical workspace for hint %s and retains its current policy",
    async (hint) => {
      const { api, change } = fixture()
      change({ workspace: "C:\\Repo\\A", outputPolicy: true })
      api.configureGlobal.mockImplementation(async () => {
        change({ workspace: "c:\\repo\\a", outputPolicy: false })
        return true
      })
      api.configure.mockImplementation(async (thread, enabled, policy, expectedWorkspace) => {
        expect(thread).toBe("thread")
        // Match the native IPC's strict canonical comparison, not a normalized renderer hint.
        expect(expectedWorkspace).toBe("c:\\repo\\a")
        expect(policy).toBe(false)
        change({ enabled, outputPolicy: policy })
      })
      await prepareDevelopmentCreation(api, "thread", hint, () => {})
      expect(api.configure).toHaveBeenCalledExactlyOnceWith("thread", true, false, "c:\\repo\\a")
    }
  )
  it("does not rewrite existing settings", async () => {
    const { api } = fixture(true, true)
    await prepareDevelopmentCreation(api, "thread", "C:/Project", () => {})
    expect(api.configureGlobal).not.toHaveBeenCalled()
    expect(api.configure).not.toHaveBeenCalled()
  })
  it("rejects foreign scope before any mutation", async () => {
    const { api } = fixture()
    await expect(prepareDevelopmentCreation(api, "thread", "C:/Other", () => {}))
      .rejects.toThrow("DEVELOPMENT_SCOPE_CHANGED")
    expect(api.configureGlobal).not.toHaveBeenCalled()
    expect(api.configure).not.toHaveBeenCalled()
  })
  it("blocks recovery before enabling the application", async () => {
    const { api, change } = fixture()
    change({ recovery: "required" })
    await expect(prepareDevelopmentCreation(api, "thread", "C:/Project", () => {}))
      .rejects.toThrow("DEVELOPMENT_SETTINGS_RECOVERY")
    expect(api.configureGlobal).not.toHaveBeenCalled()
  })
  it("stops immediately after an awaited scope change", async () => {
    const { api } = fixture()
    let current = true
    api.globalEnabled.mockImplementation(async () => { current = false; return false })
    await expect(prepareDevelopmentCreation(api, "thread", "C:/Project", () => {
      if (!current) throw Error("DEVELOPMENT_SCOPE_CHANGED")
    })).rejects.toThrow("DEVELOPMENT_SCOPE_CHANGED")
    expect(api.status).not.toHaveBeenCalled()
    expect(api.configureGlobal).not.toHaveBeenCalled()
  })
  it("reports partial setup without rolling back application settings", async () => {
    const { api } = fixture()
    api.configure.mockRejectedValueOnce(Error("workspace unavailable"))
    await expect(prepareDevelopmentCreation(api, "thread", "C:/Project", () => {}))
      .rejects.toThrow("DEVELOPMENT_SETUP_PARTIAL")
    expect(api.configureGlobal.mock.calls).toEqual([[true]])
  })
  it("rechecks scope after application mutation and never writes a newly selected workspace", async () => {
    const { api, change } = fixture()
    api.configureGlobal.mockImplementation(async () => {
      change({ workspace: "C:/Other" })
      return true
    })
    await expect(prepareDevelopmentCreation(api, "thread", "C:/Project", () => {}))
      .rejects.toThrow("DEVELOPMENT_SETUP_PARTIAL")
    expect(api.configure).not.toHaveBeenCalled()
  })
})
