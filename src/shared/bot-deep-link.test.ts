import { expect, it, vi } from "vitest"
import { botMessageLink, parseBotDeepLink } from "./bot-deep-link"
import { BotDeepLinkController } from "../main/bots/upstream/grok-deep-link-controller"
const link = {
    conversationId: "11111111-1111-1111-1111-111111111111",
    messageId: "22222222-2222-2222-2222-222222222222"
  },
  url = botMessageLink(link)
it("round trips exact local message addresses without accepting commands, query injection or noncanonical paths", () => {
  expect(parseBotDeepLink(url)).toEqual({ link, canonicalUrl: url })
  for (const value of [
    null,
    url + "?approve=true",
    url + "#run",
    url.replace("app/", "user:pass@app/"),
    url.replace("app/", "app:88/"),
    url.replace("/v1/", "/../v1/"),
    url.replace("/v1/", "/%76%31/"),
    url.replace("cmbcowork:", "https:"),
    " " + url,
    url + "\n",
    url.replace("/messages/", "/messages\\"),
    url.replace(link.messageId, "missing"),
    url + "?",
    "x".repeat(2049)
  ])
    expect(parseBotDeepLink(value)).toBeNull()
})
it("reuses Grok's bounded cold-start queue, readiness fence and duplicate window", () => {
  const dispatch = vi.fn(),
    focusWindow = vi.fn()
  let now = 0
  const controller = new BotDeepLinkController({
    dispatch,
    focusWindow,
    log: vi.fn(),
    now: () => now
  })
  controller.handleArgv(["app.exe", url, url, "--not-a-link", "cmbcowork://app/invalid"], "startup")
  expect(dispatch).not.toHaveBeenCalled()
  expect(focusWindow).toHaveBeenCalledTimes(1)
  controller.markReady()
  expect(dispatch).toHaveBeenCalledWith({ link, canonicalUrl: url })
  now = 3000
  controller.handleCandidate(url, "second-instance")
  expect(dispatch).toHaveBeenCalledTimes(2)
  controller.markNotReady()
  for (let index = 0; index < 20; index++)
    controller.handleCandidate(
      botMessageLink({
        ...link,
        messageId: `22222222-2222-2222-2222-${String(index).padStart(12, "0")}`
      }),
      "open-url"
    )
  expect(dispatch).toHaveBeenCalledTimes(2)
  controller.markReady()
  expect(dispatch).toHaveBeenCalledTimes(18)
})
