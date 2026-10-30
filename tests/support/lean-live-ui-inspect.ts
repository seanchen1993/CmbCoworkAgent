/** Open the exact isolated project through the ordinary project list; never approve it. */
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { openUnifiedHostProject } from "./project-unified-native-journey"

async function main() {
  const run = resolve(process.argv[2])
  const [port] = readFileSync(join(run, "electron/DevToolsActivePort"), "utf8").split("\n")
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = browser
    .contexts()[0]
    .pages()
    .find((page) => page.url().includes("index.html"))!
  const { projectId } = JSON.parse(readFileSync(join(run, "evidence.json"), "utf8"))
  const view = await page.evaluate((id) => window.api.harnessBoard.localProjects.get(id), projectId)
  const threadId = view.operations.at(-1)?.execution?.threadId
  if (threadId) {
    const facts = await page.evaluate(
      async (id) => ({
        thread: await window.api.threads.get(id),
        pendingApprovals: await window.api.sandbox.getPendingApprovals(id),
        pendingUserInput: await window.api.userInput.getPending(id),
        workflows: await window.api.workflows.listRuns(id)
      }),
      threadId
    )
    writeFileSync(join(run, "current-thread-facts.json"), JSON.stringify(facts, null, 2))
  }
  await openUnifiedHostProject(page, view.project.name, view.project.workspace)
  await page.screenshot({ path: join(run, "ui-current-project.png"), fullPage: true })
  writeFileSync(join(run, "ui-current-project.txt"), await page.locator("body").innerText())
  if (process.env.LEAN_LIVE_INSPECT_CHAT === "1") {
    await page.getByRole("button", { name: "查看本次会话", exact: true }).click()
    await page.screenshot({ path: join(run, "ui-current-chat.png"), fullPage: true })
    writeFileSync(join(run, "ui-current-chat.txt"), await page.locator("body").innerText())
  }
  // Keep the production app open; disconnect only this inspection client.
  await browser.close()
}
void main().catch((error) => {
  console.error(String(error))
  process.exitCode = 1
})
