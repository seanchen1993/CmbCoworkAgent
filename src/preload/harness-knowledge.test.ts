import { expect, it, vi } from "vitest"
import { createHarnessKnowledgeApi } from "./harness-knowledge"

it("forwards project, feature and chat identities and preserves legacy optional calls", async () => {
  const invoke = vi.fn(async () => ({ host: "result" }))
  const api = createHarnessKnowledgeApi(invoke)
  for (const target of [{ projectId: "project", featureId: "feature" }, { threadId: "chat" },
    undefined]) {
    expect(await api.syncProjectConstraints("plugin", target)).toEqual({ host: "result" })
    expect(invoke).toHaveBeenLastCalledWith("harnessBoard:syncProjectConstraints", "plugin", target)
    await api.getKnowledgePreview("plugin", target)
    expect(invoke).toHaveBeenLastCalledWith("harnessBoard:getKnowledgePreview", "plugin", target)
  }
  await api.getPublicAgentmdDeployUnits("project", "feature")
  expect(invoke).toHaveBeenLastCalledWith("harnessBoard:getPublicAgentmdDeployUnits", "project", "feature")
  await api.getPublicAgentmdDeployUnits("project")
  expect(invoke).toHaveBeenLastCalledWith("harnessBoard:getPublicAgentmdDeployUnits", "project", undefined)
})

it("propagates host scope/configuration rejection unchanged", async () => {
  const error = Error("HARNESS_KNOWLEDGE_TARGET_INVALID")
  const api = createHarnessKnowledgeApi(async () => { throw error })
  await expect(api.getKnowledgePreview("plugin", { threadId: "missing" })).rejects.toBe(error)
})
