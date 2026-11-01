import { expect, it, vi } from "vitest"
import { developmentCatalogPage } from "./development-catalog"
import { createCodePlatformProvider } from "../v2/platform-code-provider"
import { createEditorPlatformProvider } from "../v2/platform-editor-provider"
import { EditorNavigationBroker } from "../v2/platform-editor-navigation"
import { createWorkspacePlatformProvider } from "../v2/platform-workspace-provider"

function describe(query: string) {
  let cursor = 0,
    text = ""
  for (let pages = 0; pages < 20; pages++) {
    const page = developmentCatalogPage("types", cursor, query)
    expect(page).toMatchObject({
      kind: "native-capability",
      matched: true,
      declarationAvailable: false,
      descriptorAvailable: true,
      grantsAuthority: false
    })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(8000)
    if (!("content" in page) || typeof page.content !== "string") throw Error("Missing page")
    text += page.content
    if (!("nextCursor" in page)) return JSON.parse(text)
    cursor = page.nextCursor!
  }
  throw Error("Unbounded discovery")
}

it("publishes the actual native Java schemas without resolving a service or reading files", async () => {
  const capture = vi.fn(),
    authorizePath = vi.fn()
  const provider = createCodePlatformProvider({ capture, authorizePath })
  const doc = describe("native.code")
  expect(doc.ref).toEqual({
    provider: provider.provider,
    id: provider.descriptor.id,
    version: provider.descriptor.version
  })
  expect(doc.actions).toEqual(
    provider.descriptor.actions.map((action) =>
      Object.fromEntries(Object.entries(action).filter(([key]) => key !== "title"))
    )
  )
  expect(describe("native.code.diagnostics").actions).toHaveLength(1)
  expect(capture).not.toHaveBeenCalled()
  expect(authorizePath).not.toHaveBeenCalled()
  await provider.close?.()
})

it("keeps safe navigation's published schema and effect boundary aligned with its real provider", async () => {
  const navigation = new EditorNavigationBroker(
    () => undefined,
    () => {}
  )
  const authorizePath = vi.fn(),
    rendererScope = vi.fn()
  const provider = createEditorPlatformProvider({ navigation, authorizePath, rendererScope })
  const doc = describe("native.editor")
  expect(doc.actions).toEqual(
    provider.descriptor.actions.map((action) =>
      Object.fromEntries(Object.entries(action).filter(([key]) => key !== "title"))
    )
  )
  expect(doc.preview).toContain("safe source text")
  expect(doc.external).toContain("explicit user button")
  expect(authorizePath).not.toHaveBeenCalled()
  expect(rendererScope).not.toHaveBeenCalled()
  await provider.close?.()
})

it("describes observations rather than inventing a watcher-start or classic event action", async () => {
  const state = vi.fn(),
    changed = vi.fn(),
    lifecycle = vi.fn()
  const provider = createWorkspacePlatformProvider({
    state,
    changed,
    lifecycle,
    authorizePath: vi.fn()
  })
  const doc = describe("native.workspace")
  expect(doc.actions).toEqual(provider.descriptor.actions)
  expect(doc.invocation).toContain("no scan/start action")
  expect(state).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
  expect(lifecycle).not.toHaveBeenCalled()
  await provider.close?.()
})

it("rejects unknown methods and malformed cursors while keeping the overview bounded", () => {
  expect(developmentCatalogPage("types", 0, "native.code.fake")).toMatchObject({ matched: false })
  for (const cursor of [-1, 0.5, 999999])
    expect(() => developmentCatalogPage("types", cursor, "native.code")).toThrow(
      "DEVELOPMENT_CATALOG_CURSOR"
    )
  expect(JSON.stringify(developmentCatalogPage()).length).toBeLessThan(8000)
})
