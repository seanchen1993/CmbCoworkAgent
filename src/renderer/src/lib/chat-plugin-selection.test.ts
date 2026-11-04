import { expect, it } from "vitest"
import { parseClawProfile, type ClawApi, type ClawView } from "../../../shared/mods/claw"
import { removeChatPlugin } from "./chat-plugin-selection"

function fixture(implicit = false) {
  const profile = parseClawProfile({
    id: "original",
    name: "Original",
    capabilities: [
      { pluginId: "first", name: "first", digest: "a".repeat(64) },
      { pluginId: "second", name: "second", digest: "b".repeat(64) }
    ],
    models: { default: "model", roles: { review: "reviewer" } },
    skills: { mode: "selected", items: [] },
    builtins: { contextMeter: true }
  })
  const view: ClawView = {
    revision: 1,
    bindingRevision: 0,
    workspace: "C:/chat",
    enabled: true,
    applicable: true,
    usageContext: "chat",
    issues: [],
    profiles: [profile],
    active: implicit ? null : structuredClone(profile),
    capabilities: profile.capabilities.map((item) => ({
      pluginId: item.pluginId,
      name: item.name,
      digest: item.digest,
      state: "ready",
      capabilities: []
    }))
  }
  const calls: string[] = []
  let live = true
  let afterSave = () => {}
  const api: Pick<ClawApi, "clawView" | "clawChange"> = {
    clawView: async () => structuredClone(view),
    clawChange: async (_thread, mutation) => {
      expect(mutation.revision).toBe(view.revision)
      calls.push(mutation.kind)
      if (mutation.kind === "save") {
        view.profiles.push(parseClawProfile(mutation.profile))
        view.revision++
        afterSave()
      } else {
        expect(mutation.bindingRevision).toBe(view.bindingRevision)
        view.active = structuredClone(view.profiles.find((item) => item.id === mutation.id)!)
        view.bindingRevision = ++view.revision
      }
      return structuredClone(view)
    }
  }
  const context = {
    threadId: "chat",
    workspace: "C:/chat",
    assertCurrent() {
      if (!live) throw Error("SCOPE_CHANGED")
    }
  }
  return {
    view,
    calls,
    api,
    context,
    original: profile,
    remove: (id = "first") => removeChatPlugin(api, context, id),
    afterSave: (callback: () => void) => {
      afterSave = callback
    },
    revoke: () => {
      live = false
    }
  }
}

it("removes only this chat's provider and preserves other settings and the saved original", async () => {
  const f = fixture()
  await f.remove()
  expect(f.view.active?.capabilities.map((item) => item.pluginId)).toEqual(["second"])
  expect(f.view.active?.models).toEqual(f.original.models)
  expect(f.view.active?.skills).toEqual(f.original.skills)
  expect(f.view.active?.builtins).toEqual(f.original.builtins)
  expect(f.view.profiles[0].capabilities).toHaveLength(2)
  expect(f.view.capabilities.every((item) => item.state === "ready")).toBe(true)
  expect(f.calls).toEqual(["save", "apply"])
  f.view.active = structuredClone(f.original)
  f.view.revision++
  await f.remove()
  expect(f.calls).toEqual(["save", "apply", "apply"])
  expect(f.view.profiles).toHaveLength(2)
})

it("freezes implicit defaults and keeps an explicit empty selection after the last removal", async () => {
  const f = fixture(true)
  await f.remove()
  await f.remove("second")
  expect(f.view.active).not.toBeNull()
  expect(f.view.active?.capabilities).toEqual([])
  const count = f.calls.length
  await f.remove("second")
  expect(f.calls).toHaveLength(count)
})

it("does not apply after a concurrent binding change or revoked scope", async () => {
  const f = fixture()
  f.afterSave(() => {
    f.view.bindingRevision++
    f.view.active = null
  })
  await expect(f.remove()).rejects.toThrow("未继续切换")
  expect(f.calls).toEqual(["save"])
  const revoked = fixture()
  revoked.afterSave(revoked.revoke)
  await expect(revoked.remove()).rejects.toThrow("SCOPE_CHANGED")
  expect(revoked.calls).toEqual(["save"])
})

it("blocks project usage, referenced completion rules and profile overflow before any write", async () => {
  const f = fixture()
  f.view.usageContext = "project"
  await expect(f.remove()).rejects.toThrow("聊天或目录")
  f.view.usageContext = "chat"
  f.view.active = parseClawProfile({
    ...f.original,
    completionRules: [
      {
        ...f.original.capabilities[0],
        policy: { mode: "check", maxRepairs: 0 }
      }
    ]
  })
  await expect(f.remove()).rejects.toThrow("完成规则")
  f.view.active = structuredClone(f.original)
  f.view.profiles = Array.from({ length: 24 }, (_, index) => ({
    ...f.original,
    id: `saved-${index}`
  }))
  await expect(f.remove()).rejects.toThrow("上限")
  expect(f.calls).toEqual([])
})
