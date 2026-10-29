import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { Page } from "playwright"
import type { genericModNativeJourney } from "./generic-mod-live-native-helpers"

/** Continues an actual persisted failed negative case; never manufactures prior authoring receipts. */
export async function verifyGenericCompositionRecovery(
  page: Page,
  threadId: string,
  profile: string,
  evidenceFile: string,
  journey: ReturnType<typeof genericModNativeJourney>,
  phase: (name: string) => void,
  relayState: () => { requests: number; inFlight: number },
  record: (observation: unknown) => void
) {
  const path = resolve(evidenceFile)
  assert.equal(dirname(path), resolve(profile))
  const prior = JSON.parse(readFileSync(path, "utf8"))
  assert.equal(prior.threadId, threadId)
  const providerId = prior.observations.find((item) => item.phase === "provider-installed")
    ?.reuse?.installationId
  const consumerReceipt = prior.observations.find((item) => item.phase === "consumer-installed")?.reuse
  assert(providerId && consumerReceipt?.installationId)
  assert(prior.observations.some((item) => item.phase === "run" &&
    item.job?.state === "succeeded" && JSON.parse(item.job.result.text).revision === "v2"),
  "The prior real native command must already have proved v2 propagation")
  const native = await page.evaluate((id) => window.api.mods.status(id), threadId)
  const provider = native.functionMods?.find((item) => item.pluginId === providerId)
  const consumer = native.functionMods?.find((item) => item.pluginId === consumerReceipt.installationId)
  assert(provider?.digest && ["needs-approval", "ready"].includes(provider.state))
  assert(consumer?.state === "ready" && consumer.digest === consumerReceipt.compiledDigest)
  if (provider.state === "ready") {
    const args = [threadId, provider.name, native.workspace] satisfies
      Parameters<Window["api"]["mods"]["revokeFunction"]>
    await page.evaluate((args) => window.api.mods.revokeFunction(...args), args)
  }
  const revoked = await page.evaluate((id) => window.api.mods.status(id), threadId)
  assert(revoked.functionMods?.some((item) => item.pluginId === provider.pluginId &&
    item.digest === provider.digest && item.state === "needs-approval"))
  const before = await page.evaluate((id) => window.api.mods.jobs(id), threadId)
  let catalogError = ""
  try { await page.evaluate((id) => window.api.mods.commands(id), threadId) }
  catch (error) { catalogError = String(error) }
  assert(catalogError.includes("ModFunctionError") && catalogError.includes(provider.name))
  assert.deepEqual(await page.evaluate((id) => window.api.mods.jobs(id), threadId), before)
  record({ phase: "revocation-observed", blockedAt: "whole-selected-composition-command-catalog",
    provider: revoked.functionMods?.find((item) => item.pluginId === provider.pluginId),
    consumer, jobsAdded: 0, nativeError: catalogError, previousEvidence: path })

  // The complete selected composition is protected; a user can review it without weakening it.
  phase("revoked-ordinary-chat")
  await journey.closePanel()
  const chat = page.locator(`[data-chat-thread-id=${JSON.stringify(threadId)}]`)
  await chat.getByRole("button", { name: "普通模式", exact: true }).click()
  const originalMessages = await page.evaluate((id) => window.api.threads.getMessages(id), threadId)
  const old = new Set(originalMessages.map((message) => message.message_id ?? message.id))
  const marker = `ORDINARY_AFTER_REVOKE_${Date.now()}`
  const input = `请在回复中包含 ${marker}。`
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill(input)
  const modelBefore = relayState()
  assert.equal(modelBefore.inFlight, 0)
  await page.getByRole("button", { name: "发送消息", exact: true }).click()
  await page.getByText("当前聊天的功能组合需要核对。消息未发送，输入已保留。", { exact: true }).waitFor()
  assert.equal(await composer.inputValue(), input)
  assert.deepEqual((await page.evaluate((id) => window.api.threads.getMessages(id), threadId))
    .map((message) => message.message_id ?? message.id), [...old])
  assert.deepEqual(relayState(), modelBefore)
  await page.getByRole("button", { name: "重新核对组合", exact: true }).click()
  const recovery = page.getByRole("complementary", { name: "任务进展", exact: true })
  await recovery.getByRole("tab", { name: "高级设置", selected: true, exact: true }).waitFor()
  assert.equal(await composer.inputValue(), input)
  assert.deepEqual(await page.evaluate((id) => window.api.mods.jobs(id), threadId), before)
  assert.deepEqual(relayState(), modelBefore)
  record({ phase: "ordinary-after-revoke", passed: true, outcome: "explicitly-blocked-before-send",
    inputPreserved: true, messagesAdded: 0, modelRequestsAdded: 0, recoveryEntryOpened: true })
  const approval = recovery.locator(`[data-claw-recovery-plugin=${JSON.stringify(provider.pluginId)}]`)
    .locator(`[data-native-function-approval=${JSON.stringify(provider.pluginId)}]`)
  await approval.getByText(`授权范围：${native.workspace}，同目录聊天共用。`, { exact: true }).waitFor()
  await approval.getByText("权限与版本详情", { exact: true }).click()
  await approval.getByText(`版本摘要：${provider.digest}`, { exact: true }).waitFor()
  await approval.getByRole("button", { name: "授权以上能力", exact: true }).click()
  await journey.until("NATIVE_REAPPROVAL", async () => {
    const approved = await page.evaluate((id) => window.api.mods.status(id), threadId)
    return approved.functionMods?.some((item) => item.pluginId === provider.pluginId &&
      item.digest === provider.digest && item.state === "ready") ? true : undefined
  })
  record({ phase: "native-reapproval", source: "selected-composition-exact-source-ui",
    pluginId: provider.pluginId, digest: provider.digest, workspace: native.workspace })
  const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), threadId))
    .find((command) => command.command === "review-text")
  assert(descriptor && descriptor.digest === consumer.digest)
  const previousJobs = new Set((await page.evaluate((id) => window.api.mods.jobs(id), threadId))
    .map((job) => job.id))
  await page.evaluate(({ id, descriptor }) => window.api.mods.enqueue(id, descriptor,
    { text: "  Alpha BETA  " }), { id: threadId, descriptor })
  const result = await journey.until("RESTORED_COMPOSITION", async () => {
    const job = (await page.evaluate((id) => window.api.mods.jobs(id), threadId))
      .find((job) => !previousJobs.has(job.id) && job.command === "review-text")
    if (!job || ["queued", "running"].includes(job.state)) return undefined
    assert.equal(job.state, "succeeded", JSON.stringify(job))
    return job
  })
  assert.deepEqual(JSON.parse(result.result!.text!),
    { text: "alpha beta", revision: "v2", passed: true, reason: "ok" })
  record({ phase: "reauthorized-composition", passed: true, job: result })
  await recovery.getByRole("button", { name: "收起任务进展", exact: true }).click()
  assert.equal(await composer.inputValue(), input)
  phase("reauthorized-ordinary-chat")
  await page.getByRole("button", { name: "发送消息", exact: true }).click()
  const reply = await journey.until("RESTORED_ORDINARY_CHAT", async () => {
    const fresh = (await page.evaluate((id) => window.api.threads.getMessages(id), threadId))
      .filter((message) => !old.has(message.message_id ?? message.id) && message.role === "assistant")
    const failed = fresh.find((message) => message.is_error)
    assert(!failed, failed ? JSON.stringify(failed.content) : undefined)
    return fresh.find((message) => typeof message.content === "string" && message.content.includes(marker))
  }, 90_000)
  await journey.idle()
  assert(relayState().requests > modelBefore.requests, "The restored reply must use the real model")
  record({ phase: "reauthorized-ordinary-chat", passed: true,
    messageId: reply.message_id ?? reply.id, modelRequestsAdded: relayState().requests - modelBefore.requests })
  return { restored: true, ordinaryChatPassed: true, catalogScope: "whole-selected-composition" }
}
