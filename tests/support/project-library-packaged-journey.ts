import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "playwright"
import type { LocalProjectView } from "../../src/shared/project-runtime/platform-api"

export const KNOWLEDGE_MARKER = "PROJECT_LIBRARY_REFERENCE_REQUIRES_NEW_VALIDATION"

export async function saveProjectKnowledge(page: Page) {
  await page.getByRole("button", { name: "打开成果与经验", exact: true }).click()
  const panel = page.getByRole("region", { name: "成果与经验" })
  await panel.getByLabel("成果名称", { exact: true }).fill("真实阶段经验")
  await panel.getByLabel("经验说明", { exact: true }).fill(KNOWLEDGE_MARKER)
  await panel.getByRole("button", { name: "保存为经验", exact: true }).click()
  await panel.getByRole("button", { name: "真实阶段经验", exact: true }).waitFor()
  await page.getByRole("button", { name: "收起成果与经验", exact: true }).click()
}

/** Real production preload/IPC/database, real DOM clicks, loopback multipart only. */
export async function exerciseProjectLibrary(page: Page, view: LocalProjectView, artifacts: string) {
  const targetWorkspace = join(artifacts, "knowledge-target")
  mkdirSync(targetWorkspace)
  const target = await page.evaluate((input) => window.api.harnessBoard.localProjects.create(input), {
    name: "经验复用目标", workspace: targetWorkspace, installedPluginId: view.project.installedPluginId,
    goal: "只验证参考资料复用，不运行任务"
  })
  const saved = await page.evaluate((id) => window.api.harnessBoard.localProjects.library.list(id), view.project.projectId)
  assert(saved.some((entry) => entry.note === KNOWLEDGE_MARKER))
  const denial = await page.evaluate(async ({ targetId, entryId }) => {
    try { await window.api.harnessBoard.localProjects.library.read(targetId, entryId, "draft.md"); return "LEAK" }
    catch (error) { return String(error) }
  }, { targetId: target.project.projectId, entryId: saved[0].id })
  assert.match(denial, /NOT_FOUND/)
  await page.getByRole("button", { name: "打开成果与经验", exact: true }).click()
  const panel = page.getByRole("region", { name: "成果与经验" })
  await panel.getByRole("button", { name: "真实阶段经验", exact: true }).click()
  await panel.getByLabel("复用到另一个任务", { exact: true }).selectOption(target.project.projectId)
  await panel.getByRole("button", { name: "加入所选任务的经验", exact: true }).click()
  await panel.getByLabel("成果名称", { exact: true }).fill("交付生产快照")
  await panel.getByRole("button", { name: "准备交付", exact: true }).click()
  await panel.getByRole("button", { name: "交付生产快照", exact: true }).click()
  const requests: string[] = []
  let failCatalog = true
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString("utf8")
    requests.push(body)
    response.writeHead(failCatalog && body.includes("DEVCLAW_ARTIFACT_CATALOG.json") ? 503 : 200)
    response.end("local fixture")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const { port } = server.address() as { port: number }
    await panel.getByLabel("接收服务地址", { exact: true }).fill(`http://127.0.0.1:${port}/upload`)
    await panel.getByLabel("接收目录", { exact: true }).fill("OWNED/DEV/Features/fixture")
    await panel.getByRole("checkbox").check()
    await panel.getByRole("button", { name: "确认发送", exact: true }).click()
    await panel.getByRole("button", { name: "确认发送未确认部分", exact: true }).waitFor()
    assert.equal(await panel.getByRole("checkbox").isChecked(), false)
    assert(requests.length >= 2)
    const priorCount = requests.length
    failCatalog = false
    await panel.getByRole("checkbox").check()
    await panel.getByRole("button", { name: "确认发送未确认部分", exact: true }).click()
    await page.waitForFunction(async (id) =>
      (await window.api.harnessBoard.localProjects.library.list(id)).some((entry) => entry.kind === "delivery" && entry.status === "sent"), view.project.projectId)
    assert.equal(requests.length, priorCount + 1, "Only catalog retried; confirmed files not repeated")
    const result = await page.evaluate(async ({ sourceId, targetId }) => ({
      source: await window.api.harnessBoard.localProjects.library.list(sourceId),
      target: await window.api.harnessBoard.localProjects.library.list(targetId),
      project: await window.api.harnessBoard.localProjects.get(sourceId)
    }), { sourceId: view.project.projectId, targetId: target.project.projectId })
    assert.deepEqual(result.project, view, "Library does not advance or rewrite project")
    assert.equal(result.target.length, 1)
    assert.equal(result.target[0].source?.projectId, view.project.projectId)
    await page.screenshot({ path: join(artifacts, "library-delivery-and-reuse.png") })
    await page.getByRole("button", { name: "收起成果与经验", exact: true }).click()
    return { source: result.source, target: result.target, multipartRequests: requests.length, crossProjectReadDenied: true }
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
}
