import assert from "node:assert/strict"
import type { Page } from "playwright"
import { waitForAsyncEvidence } from "./async-evidence"

interface ContinuitySample {
  frames: number
  emptyFrames: number
  concealedFrames: number
  duplicateFrames: number
}
type MonitoredWindow = Window & { stopCompositionContinuity(): ContinuitySample }

async function rendererHeapBytes(page: Page): Promise<number> {
  const session = await page.context().newCDPSession(page)
  try {
    // performance.memory is bucketed without a Chromium flag and can mask real growth.
    return (await session.send("Runtime.getHeapUsage")).usedSize
  } finally {
    await session.detach()
  }
}

export async function runCompositionLongSession(
  page: Page,
  threadId: string,
  workspace: string,
  turns = 20
) {
  const timings: Array<{
    turn: number
    responseMs: number
    rendererHeapBytes?: number
    switchMs?: number
    switchSteps?: number[]
    continuity: ContinuitySample
  }> = []
  const other = await page.evaluate(async (workspace) => {
    const thread = await window.api.threads.create({
      title: "Long session switching target",
      workspacePath: workspace,
      agentMode: "normal"
    })
    await window.api.workspace.set(thread.thread_id, workspace)
    return thread.thread_id
  }, workspace)
  assert(other !== threadId)
  // IPC creation does not insert a sidebar item into the renderer's in-memory store.
  await page.reload()
  await page.getByRole("tab", { name: "项目模式", exact: true }).click()
  await page.getByText("Composition IPC Session", { exact: true }).first().click()
  for (let turn = 1; turn <= turns; turn++) {
    const started = Date.now()
    // Raw browser script avoids tsx adding its Node-only function-name helper.
    await page.evaluate(`(() => {
      const sample = { frames: 0, emptyFrames: 0, concealedFrames: 0, duplicateFrames: 0 }
      let seenRows = false
      let frame = 0
      const observe = () => {
        sample.frames++
        const rows = [...document.querySelectorAll("[data-chat-message-row]")]
        if (seenRows && !rows.length) sample.emptyFrames++
        const pending = !!document.querySelector('[data-chat-initial-presentation="pending"]')
        if (seenRows && pending)
          sample.concealedFrames++
        seenRows ||= rows.length > 0 && !pending
        const ids = rows.map((row) => row.dataset.chatMessageId)
        if (new Set(ids).size !== ids.length) sample.duplicateFrames++
        frame = requestAnimationFrame(observe)
      }
      frame = requestAnimationFrame(observe)
      window.stopCompositionContinuity = () => {
        cancelAnimationFrame(frame)
        return sample
      }
    })()`)
    await page.locator("textarea.composer-textarea").fill(`LONG_TURN_${turn} preserve one answer`)
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await page.getByText(`LONG_DONE_${turn}`, { exact: true }).waitFor({ timeout: 60000 })
    await page.waitForFunction(
      () => !document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")?.disabled
    )
    const persisted = await waitForAsyncEvidence(
      () =>
        page.evaluate(
          async ({ threadId, turn }) => {
            const messages = await window.api.threads.getMessages(threadId)
            return messages.find(
              (message) =>
                message.role === "assistant" &&
                JSON.stringify(message.content).includes(`LONG_DONE_${turn}\\n`) &&
                JSON.stringify(message.content).includes("段落 64：")
            )
          },
          { threadId, turn }
        ),
      (message) => Boolean(message),
      `long session turn ${turn} complete persisted answer`,
      30_000
    )
    assert.equal(persisted?.role, "assistant")
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor()
    const continuity = await page.evaluate(() =>
      (window as MonitoredWindow).stopCompositionContinuity()
    )
    assert(continuity.frames > 0, "Actual rendered frames were observed during streaming")
    assert.equal(
      continuity.emptyFrames,
      0,
      "The entire message list must not disappear during streaming"
    )
    assert.equal(
      continuity.concealedFrames,
      0,
      "Existing conversation must not reset to a loading placeholder during streaming"
    )
    assert.equal(
      continuity.duplicateFrames,
      0,
      "Rendered message IDs remain unique during streaming"
    )
    const sample: {
      turn: number
      responseMs: number
      rendererHeapBytes?: number
      switchMs?: number
      switchSteps?: number[]
      continuity: ContinuitySample
    } = {
      turn,
      responseMs: Date.now() - started,
      rendererHeapBytes: await rendererHeapBytes(page),
      continuity
    }
    if (turn % 5 === 0) {
      const switching = Date.now()
      sample.switchSteps = []
      await page.getByRole("tab", { name: "对话模式", exact: true }).click()
      sample.switchSteps.push(Date.now() - switching)
      await page.getByText("Long session switching target", { exact: true }).first().click()
      sample.switchSteps.push(Date.now() - switching)
      assert.equal(await page.getByRole("button", { name: "项目能力", exact: true }).count(), 0)
      await page.getByRole("tab", { name: "项目模式", exact: true }).click()
      sample.switchSteps.push(Date.now() - switching)
      await page.getByText("Composition IPC Session", { exact: true }).first().click()
      sample.switchSteps.push(Date.now() - switching)
      await page.locator("textarea.composer-textarea").waitFor()
      await page.getByText(`LONG_DONE_${turn}`, { exact: true }).waitFor()
      sample.switchMs = Date.now() - switching
    }
    timings.push(sample)
  }
  const messages = await page.evaluate((id) => window.api.threads.getMessages(id), threadId)
  for (let turn = 1; turn <= turns; turn++) {
    assert.equal(
      messages.filter(
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message.content).includes(`LONG_DONE_${turn}\\n`)
      ).length,
      1,
      `Exactly one persisted answer for long turn ${turn}`
    )
  }
  return timings
}
