import { test } from "vitest"
import assert from "node:assert/strict"
import { createBotLinkPreviewClient } from "../../renderer/src/lib/bot-link-preview-client"
import { botIpcFailure } from "./error-diagnostic"
import { BotDomainError } from "../../shared/bot-types"

test("actual safe failure envelope survives the named renderer facade without raw body or secret", async () => {
  const key = "sk-preview-key-do-not-disclose"
  const envelope = botIpcFailure(
    new BotDomainError("preview_internal", `Authorization: Bearer ${key}`)
  )
  const transport = Object.freeze({
    getLinkPreview: async () => envelope,
    cancelLinkPreview: async () => undefined
  })
  const client = createBotLinkPreviewClient(() => transport)
  await assert.rejects(
    client.getLinkPreview({
      requestId: crypto.randomUUID(),
      url: "https://preview.candidate.net/"
    }),
    (error) => {
      assert.ok(error instanceof BotDomainError)
      assert.equal(error.code, "preview_internal")
      assert.equal(error.message.includes(key), false)
      return true
    }
  )
  await client.cancelLinkPreview({ requestId: crypto.randomUUID() })
})
