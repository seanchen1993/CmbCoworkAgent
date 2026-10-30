/** Concurrent public renderer IPC observer for a live Host start (which awaits execution). */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import type { UserInputResponse } from "../../src/main/types"

async function main() {
  const run = resolve(process.argv[2])
  assert(run.includes("lean-live-20261030"), "ISOLATED_RUN_REQUIRED")
  const [port] = readFileSync(join(run, "electron/DevToolsActivePort"), "utf8").split("\n")
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = browser
    .contexts()[0]
    .pages()
    .find((page) => page.url().includes("index.html"))!
  assert(page, "APP_PAGE_REQUIRED")
  const seen = new Set<string>()
  while (true) {
    const evidence = JSON.parse(readFileSync(join(run, "evidence.json"), "utf8"))
    if (evidence.projectId) {
      const view = await page.evaluate(
        (id) => window.api.harnessBoard.localProjects.get(id),
        evidence.projectId
      )
      writeFileSync(join(run, "observed-project.json"), JSON.stringify(view, null, 2))
      if (view.inputWait) {
        const pendingInput = await page.evaluate(
          (id) => window.api.userInput.getPending(id),
          view.inputWait.threadId
        )
        writeFileSync(join(run, "pending-user-input.json"), JSON.stringify(pendingInput, null, 2))
        const responsePath = join(run, "reviewed-user-input.json")
        if (pendingInput && existsSync(responsePath)) {
          const response = JSON.parse(readFileSync(responsePath, "utf8")) as UserInputResponse
          if (response.requestId === pendingInput.requestId)
            await page.evaluate((response) => window.api.userInput.sendResponse(response), response)
        }
      }
    }
    const pending = await page.evaluate(
      async (workspace) => {
        const threads = (await window.api.threads.list()).filter((thread) =>
          JSON.stringify(thread.metadata)
            .toLowerCase()
            .includes(workspace.toLowerCase().replaceAll("\\", "\\\\"))
        )
        const all: unknown[] = []
        for (const thread of threads)
          all.push(...(await window.api.sandbox.getPendingApprovals(thread.thread_id)))
        return all
      },
      join(run, "workspace")
    )
    for (const raw of pending) {
      const approval = raw as { id: string; tool_call_id?: string; tool_call?: { id: string } }
      const digest = createHash("sha256").update(JSON.stringify(approval)).digest("hex")
      writeFileSync(
        join(run, "pending-approval.json"),
        JSON.stringify({ digest, approval }, null, 2)
      )
      if (!seen.has(digest)) {
        console.log(JSON.stringify({ digest, approval }))
        seen.add(digest)
      }
      const path = join(run, "reviewed-approvals.json")
      const decisions = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}
      const decision = Array.isArray(decisions)
        ? decisions.includes(digest)
          ? "approve"
          : undefined
        : decisions[digest]
      if (!["approve", "reject"].includes(decision)) continue
      await page.evaluate(
        ({ approval, decision }) =>
          window.api.sandbox.sendApprovalDecision({
            requestId: approval.id,
            tool_call_id: approval.tool_call_id ?? approval.tool_call?.id ?? approval.id,
            type: decision
          }),
        { approval, decision }
      )
    }
    await new Promise((done) => setTimeout(done, 750))
  }
}
void main().catch((error) => {
  console.error(String(error))
  process.exitCode = 1
})
