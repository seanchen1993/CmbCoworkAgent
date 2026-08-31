import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("./service.ts", import.meta.url), "utf8")
const ipcSource = readFileSync(new URL("../ipc/harness-board.ts", import.meta.url), "utf8")
const chatSource = readFileSync(
  new URL("../../renderer/src/components/chat/ChatContainer.tsx", import.meta.url),
  "utf8"
)

function functionSection(start: string, end?: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe("Harness detail runtime isolation contract", () => {
  it("keeps renderer batch and single project-detail requests on separate latest lanes", () => {
    expect(ipcSource).toContain("harness-project-detail:${event.sender.id}:single")
    expect(ipcSource).toContain("harness-project-detail:${event.sender.id}:batch")
    expect(
      ipcSource.match(
        /cancelHarnessDetailRequestScope\(`harness-project-detail:\$\{event\.sender\.id\}:single`\)/g
      )
    ).toHaveLength(2)
    expect(
      ipcSource.match(
        /cancelHarnessDetailRequestScope\(`harness-project-detail:\$\{event\.sender\.id\}:batch`\)/g
      )
    ).toHaveLength(1)
  })

  it("keeps project-store and plugin-config parsing out of project detail batches", () => {
    const section = functionSection(
      "async function loadHarnessProjectDetails(",
      "export async function getHarnessRunDetail("
    )
    expect(section).toContain("readHarnessProjectContextsInWorker")
    expect(section).not.toContain("readProjectStore()")
    expect(section).not.toContain("createHarnessPluginCatalogSnapshot()")
    expect(section).not.toContain("readFileSync(")
  })

  it("keeps adapter JSON and hook NDJSON projection out of the main run-detail path", () => {
    const section = functionSection("async function loadHarnessRunDetail(")
    expect(section).toContain("parseHarnessAdapterRunInWorker")
    expect(section).not.toContain("JSON.parse(")
    expect(section).not.toContain("readFileSync(")
    expect(section).not.toContain("readHookLogRefs(")
    expect(section).not.toContain("parseInspectAdapterOutput(")
  })

  it("loads dialog tips through a bounded catalog-worker lane and cancels on cleanup", () => {
    const section = functionSection(
      "export async function buildHarnessFeatureDialogTips(",
      "export async function listHarnessProjects("
    )
    expect(section).toContain("readHarnessDialogTipsInWorker")
    expect(section).not.toContain("requireProject(")
    expect(section).not.toContain("readProjectStore(")
    expect(section).not.toContain("readBoardConfig(")
    expect(ipcSource).toContain("harness-dialog-tips:${event.sender.id}")
    expect(ipcSource).toContain('ipcMain.handle("harnessBoard:cancelDialogTips"')
    const effectStart = chatSource.indexOf("const harnessDialogTipsProjectId")
    const effectEnd = chatSource.indexOf("// Hook logs live", effectStart)
    expect(effectStart).toBeGreaterThanOrEqual(0)
    expect(effectEnd).toBeGreaterThan(effectStart)
    expect(chatSource.slice(effectStart, effectEnd)).toContain(
      "window.api.harnessBoard.cancelDialogTips()"
    )
  })
})
