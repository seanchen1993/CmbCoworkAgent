import { createHash } from "node:crypto"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import type { BotArtifacts } from "./artifacts"
import type { LocalBotComputerProvider } from "./computer-provider"
import type { BotBrowserBroker } from "./browser-broker"

type ObservationResult = Awaited<ReturnType<BotBrowserBroker["act"]>>
type CaptureReceipt = Omit<ObservationResult, "image"> & { sha256: string }
const jpegPrefix = "data:image/jpeg;base64,"
const interrupted = () =>
  new BotDomainError(
    "effect_requires_review",
    "截图交付未完成，未自动重新截图。请核对已有附件后重新发起截图。"
  )

/** Explicit screenshot delivery only. The intent precedes capture; original
 * JPEG bytes and their attachment notice share the existing artifact commit. */
export async function deliverBotBrowserScreenshot(input: {
  request: BotRuntimeRequest
  computer: LocalBotComputerProvider
  files: BotArtifacts
  taskRunId?: string
  callId: string
  action: Record<string, unknown> & { op: string }
  check(): void
}) {
  const { request, computer, files, taskRunId, callId, action, check } = input
  const { store, lease, run, bot } = request
  check()
  const epoch = store.dataEpoch()
  const key = `browser-shot:${createHash("sha256").update(callId).digest("hex")}`
  const artifactId = `${run.id}:${key}`
  const identity = { tool: "browser_screenshot", action, epoch, botId: bot.id, taskRunId }
  let first = false
  const intent = store.toolOnce(lease, key, identity, () => {
    first = true
    return { artifactId, name: typeof action.name === "string" ? action.name : "screenshot.jpg" }
  })
  const captureKey = `${key}:capture`
  const assertEpoch = () => {
    check()
    if (store.dataEpoch() !== epoch)
      throw new BotDomainError("data_epoch", "数据已恢复，截图交付已停止")
  }
  if (!first) {
    // A prior intent without a fully published original is uncertain, even if
    // the browser now happens to show the same URL. Never recapture on replay.
    let artifact
    try {
      artifact = store.artifactForRun(run.id, intent.artifactId)
    } catch (error) {
      if (error instanceof BotDomainError && error.code === "not_found") throw interrupted()
      throw error
    }
    const capture = store.toolOnce<CaptureReceipt>(lease, captureKey, { artifactId }, () => {
      throw interrupted()
    })
    const { bytes } = await files.read(artifact.id)
    assertEpoch()
    store.artifactForRun(run.id, artifact.id)
    if (artifact.sha256 !== capture.sha256 || artifact.mime !== "image/jpeg") throw interrupted()
    return { ...capture, image: jpegPrefix + bytes.toString("base64"), artifact }
  }
  const broker = await computer.get()
  const target = await broker.ensure(bot.id, taskRunId)
  assertEpoch()
  const result = await broker.act(target, action, assertEpoch)
  assertEpoch()
  if (!result.observation || !result.image?.startsWith(jpegPrefix)) throw interrupted()
  const encoded = result.image.slice(jpegPrefix.length)
  if (!encoded || encoded.length > Math.ceil((25 * 1024 * 1024) / 3) * 4) throw interrupted()
  const bytes = Buffer.from(encoded, "base64")
  if (
    bytes.toString("base64") !== encoded ||
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8
  )
    throw interrupted()
  const observed = {
    summary: result.summary,
    target: result.target,
    observation: result.observation
  }
  const capture = store.toolOnce<CaptureReceipt>(lease, captureKey, { artifactId }, () => ({
    ...observed,
    sha256: createHash("sha256").update(bytes).digest("hex")
  }))
  const artifact = await files.publish(
    {
      id: artifactId,
      conversationId: run.conversationId,
      runId: run.id,
      name: intent.name,
      mime: "image/jpeg",
      origin: "browser"
    },
    bytes,
    lease,
    () => {
      assertEpoch()
      broker.assertBotObservation(result.target, result.observation!)
    },
    {
      nonce: `screenshot-notice:${artifactId}`,
      botId: bot.id,
      ...(run.threadRootId ? { threadRootId: run.threadRootId } : {}),
      text: `已交付截图：${intent.name}`
    }
  )
  assertEpoch()
  store.artifactForRun(run.id, artifact.id)
  return { ...capture, image: result.image, artifact }
}
