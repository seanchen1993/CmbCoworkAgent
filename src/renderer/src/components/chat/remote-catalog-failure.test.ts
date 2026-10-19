import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import { BackendNotConfiguredError } from "../../api/backend-endpoint"

function originalLoader(file: string, name: string, declarations: string, dependencies: Record<string, unknown>) {
  const source = ts.createSourceFile(file, readFileSync(resolve(
    "src/renderer/src/components/chat", file
  ), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const node = source.statements.find((entry): entry is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(entry) && entry.name?.text === name)
  if (!node) throw new Error("Original catalog loader is missing")
  const javascript = ts.transpileModule(declarations + node.getText(source) + "; return " + name, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return new Function(...Object.keys(dependencies), javascript)(...Object.values(dependencies)) as
    (...args: unknown[]) => Promise<unknown>
}

describe("remote discovery does not invent a successful catalog", () => {
  it("does not cache a false market response as a successful empty snapshot", async () => {
    const getSkills = vi.fn().mockResolvedValue({ success: false, errorCode: "BACKEND_NOT_CONFIGURED" })
    const load = originalLoader("WelcomeSkills.tsx", "loadMarketSkillsSnapshot",
      "let marketSkillsSnapshot = null; let marketSkillsRequest = null; const MARKET_SKILLS_CACHE_TTL_MS = 60000;",
      { marketApi: { getSkills }, BackendNotConfiguredError })
    await expect(load(new AbortController().signal)).rejects.toBeInstanceOf(BackendNotConfiguredError)
    await expect(load(new AbortController().signal)).rejects.toBeInstanceOf(BackendNotConfiguredError)
    expect(getSkills).toHaveBeenCalledTimes(2)
  })

  it("keeps original org failures rejected instead of returning mock cards", async () => {
    const error = new BackendNotConfiguredError("组织技能服务")
    const getOrgSkills = vi.fn().mockRejectedValue(error)
    const mock = vi.fn()
    const load = originalLoader("OrganizationSkillsSection.tsx", "loadOrganizationSkillsOnce",
      "let cachedOrganizationSkillsData = null; let organizationSkillsRequestPromise = null;",
      { orgSkillMarketApi: { getOrgSkills }, getMockOrgSkillMarketResponse: mock })
    await expect(load()).rejects.toBe(error)
    await expect(load()).rejects.toBe(error)
    expect(mock).not.toHaveBeenCalled()
    expect(getOrgSkills).toHaveBeenCalledTimes(2)
  })
})
