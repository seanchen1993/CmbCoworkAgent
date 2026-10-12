import { test } from "vitest"
import assert from "node:assert/strict"
import { botMessagePreviewLink } from "./bot-link-preview-policy"
import { botMessageLinkParts } from "../../../shared/bot-message-links"
const url = "https://preview.candidate.net/page#original-section"
test("single bare HTTPS uses fragment-free fetch identity and exact original opening href without modifying literal history", () => {
  const original = "  " + url + "\n"
  assert.deepEqual(botMessagePreviewLink(original), {
    url: url.split("#")[0],
    href: url
  })
  assert.equal(
    botMessageLinkParts(original)
      .map((part) => part.text)
      .join(""),
    original
  )
  for (const text of [
    "查看 " + url,
    url + " other",
    url + " " + url,
    "http://public.candidate.net/",
    "cmbcowork://app/v1/bots/11111111-1111-4111-8111-111111111111/messages/22222222-2222-4222-8222-222222222222",
    "https://preview.candidate.net/?token=secret"
  ])
    assert.equal(botMessagePreviewLink(text), null)
})
