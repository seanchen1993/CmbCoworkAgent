import { expect, it } from "vitest"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { LocalBotComputerProvider } from "./computer-provider"
import { executeBotBrowserMaintenance as execute } from "./browser-maintenance"

it.skipIf(process.env.CMB_BOT_BROWSER_TEST !== "1")(
  "restores persistent site state and cookies through the real native browser, then resets it",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bot-browser-checkpoint-live-"))
    const provider = new LocalBotComputerProvider(join(root, "browser-profile"))
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8")
      const value = request.url === "/first" ? "before" : request.url === "/second" ? "after" : null
      if (value)
        response.setHeader("set-cookie", `fixture=${value}; Path=/; Max-Age=3600; SameSite=Lax`)
      response.end(`<html><body><p>${request.headers.cookie ?? "no-cookie"}</p><p id="value"></p><script>
      ${value ? `localStorage.setItem('state',${JSON.stringify(value)});` : ""}
      document.getElementById('value').textContent=localStorage.getItem('state')||'no-state';
      </script></body></html>`)
    })
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const origin = "http://127.0.0.1:" + (server.address() as { port: number }).port
      const observe = async (path: string) => {
        const browser = await provider.get(),
          target = await browser.ensure("checkpoint-bot")
        const next = await browser.act(target, { op: "navigate", url: origin + path }, () => {})
        return (await browser.act(next.target, { op: "snapshot" }, () => {})).data!
      }
      expect(await observe("/first")).toContain("before")
      await provider.close()
      const checkpoint = (await execute(root, { action: "create", nonce: randomUUID() }))
        .checkpoint!
      expect(await observe("/second")).toContain("after")
      await provider.close()
      await execute(root, {
        action: "restore",
        nonce: randomUUID(),
        checkpoint: { id: checkpoint.id, sha256: checkpoint.sha256 }
      })
      const restored = await observe("/read")
      expect(restored).toContain("fixture=before")
      expect(restored).toContain("before")
      expect(restored).not.toContain("after")
      await provider.close()
      await execute(root, { action: "reset", nonce: randomUUID() })
      const reset = await observe("/read")
      expect(reset).toContain("no-cookie")
      expect(reset).toContain("no-state")
    } finally {
      await provider.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true, maxRetries: 3 })
    }
  },
  90_000
)
