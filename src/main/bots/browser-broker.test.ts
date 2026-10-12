import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { chromium } from "playwright"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotBrowserBroker } from "./browser-broker"
import { LocalBotComputerProvider } from "./computer-provider"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { botBrowserFileReceiver } from "./browser-files"
import type { BotArtifact } from "../../shared/bot-types"

// Opt in explicitly: this launches an installed browser, never downloads one or opens personal data.
const enabled = process.env.CMB_BOT_BROWSER_TEST === "1"
describe.runIf(enabled)("Grok browser actions in the Bot broker", () => {
  let broker: BotBrowserBroker, server: Server, root: string, url: string
  let fixtureComputer: LocalBotComputerProvider
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/export" && request.method === "POST") {
        const body: Buffer[] = []
        request.on("data", (part: Buffer) => body.push(part))
        request.on("end", () => {
          response.setHeader("Content-Type", "text/plain")
          response.setHeader("Content-Disposition", 'attachment; filename="export.txt"')
          response.end(
            `POST ${Buffer.concat(body).toString()} ${request.headers.cookie || "no cookie"}`
          )
        })
        return
      }
      if (request.url?.startsWith("/file/")) {
        response.setHeader("Content-Disposition", 'attachment; filename="report.txt"')
        response.setHeader("Content-Type", "text/plain")
        if (request.url === "/file/large") {
          response.setHeader("Content-Length", String(26 * 1024 * 1024))
          response.end(Buffer.alloc(26 * 1024 * 1024, 65))
        } else if (request.url === "/file/slow") {
          response.write("start")
          const timer = setInterval(() => response.write("waiting"), 100)
          response.once("close", () => clearInterval(timer))
        } else response.end(`${request.url} ${request.headers.cookie || "no cookie"}`)
        return
      }
      if (request.url === "/login")
        response.setHeader("Set-Cookie", "bot_test=shared; Path=/; SameSite=Lax")
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      if (request.url === "/password") {
        response.end(
          '<html><body><input type="password" id="password" aria-label="Password"><input type="text" id="plain" aria-label="Plain"><button onclick="document.querySelector(\'#password\').replaceWith(document.querySelector(\'#password\').cloneNode())">Replace</button></body></html>'
        )
        return
      }
      if (request.url?.startsWith("/exports")) {
        const label =
          new URL(request.url, "http://localhost").searchParams.get("owner") === "b" ? "b" : "a"
        response.end(`<html><body>
          <form method="POST" action="/export"><input type="hidden" name="csrf" value="${label}-csrf"><button>Export POST</button></form>
          <button onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['${label}-generated']));a.download='generated.txt';a.click()">Export blob</button>
          <a href="/file/large">Export large</a><a href="/file/slow">Export slow</a>
          <a href="/file/popup" target="_blank">Export popup</a>
          <iframe src="/form" id="child"></iframe>
          <button onclick="document.querySelector('#child').contentDocument.querySelector('form').submit()">Export frame</button>
          </body></html>`)
        return
      }
      if (request.url === "/form") {
        response.end(
          '<form method="POST" action="/export"><input type="hidden" name="csrf" value="frame-csrf"></form>'
        )
        return
      }
      if (request.url === "/select") {
        response.end(`<html><body>
          <select aria-label="Region" onchange="document.querySelector('#changes').textContent='Changes: 1'">
            <option value="">请选择区域</option><option value="east">东区</option><option value="west">西区</option>
          </select>
          <select aria-label="Many" multiple>${Array.from({ length: 6 }, (_, index) => `<option selected value="${index}-${"v".repeat(60)}">${index}-${"L".repeat(100)}</option>`).join("")}</select>
          <p id="changes">Changes: 0</p>
        </body></html>`)
        return
      }
      response.end(`<html><head><title>Bot fixture</title></head><body>
        <input id="name" aria-label="Name"><button onclick="document.querySelector('#out').textContent=document.querySelector('#name').value">Save</button>
        <div id="out"></div><p>${request.headers.cookie || "no cookie"}</p></body></html>`)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    root = await mkdtemp(join(tmpdir(), "cmb-bot-browser-"))
    fixtureComputer = new LocalBotComputerProvider(root, process.env.CMB_BOT_BROWSER_CHANNEL)
    broker = await fixtureComputer.get()
  }, 30_000)
  afterAll(async () => {
    server?.closeAllConnections()
    await fixtureComputer?.close()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (root) await rm(root, { recursive: true, force: true })
  }, 30_000)

  it("reopens the provider after its browser closes and invalidates the previous target", async () => {
    const profile = await mkdtemp(join(tmpdir(), "cmb-bot-reopen-"))
    const provider = new LocalBotComputerProvider(profile)
    try {
      expect(provider.status().state).toBe("stopped")
      const first = await provider.get()
      expect(provider.status().state).toBe("ready")
      expect(provider.status().version).toMatch(/^\d+\.\d+/)
      const attemptId = provider.status().attemptId
      // Inspect the actual provider process, not only its launch options.
      const inspectionPage = await first.teachEncoderPage()
      const inspectionContext = inspectionPage.context()
      const session = await inspectionPage.context().browser()!.newBrowserCDPSession()
      try {
        const command = await session.send("Browser.getBrowserCommandLine")
        expect(command.arguments).not.toContain("--no-sandbox")
      } finally {
        await session.detach()
        await inspectionPage.close()
      }
      const stale = await first.ensure("recovering-bot")
      // Simulate Chromium/OS closure by closing its context directly. This must
      // make the Provider wait for Broker-owned cleanup before a new profile is
      // opened, rather than relying on the ordinary Broker.close() path.
      await inspectionContext.close()
      expect(provider.status().state).toBe("failed")
      const second = await provider.get()
      expect(provider.status().attemptId).not.toBe(attemptId)
      expect(second).not.toBe(first)
      const fresh = await second.ensure("recovering-bot")
      expect(fresh.generation).not.toBe(stale.generation)
      await expect(second.act(stale, { op: "snapshot" }, () => {})).rejects.toThrow("画面或控制权")
      expect((await second.frame("recovering-bot")).image).toMatch(/^data:image\/jpeg;base64,/)
    } finally {
      await provider.close()
      expect(provider.status().state).toBe("stopped")
      await rm(profile, { recursive: true, force: true })
    }
  }, 30_000)

  it("closes the browser while a page evaluation is still pending", async () => {
    const profile = await mkdtemp(join(tmpdir(), "cmb-bot-close-"))
    const provider = new LocalBotComputerProvider(profile)
    try {
      const instance = await provider.get()
      await instance.ensure("close-test")
      const target = await instance.takeControl(instance.target("close-test"))
      let started!: () => void
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      const pending = instance
        .teachObserve(target.botId, async (page) => {
          await page.exposeFunction("notifyPending", started)
          await page.evaluate(`globalThis.notifyPending(); new Promise(() => {})`)
        })
        .catch((error) => error)
      await ready
      await provider.close()
      expect(await pending).toBeInstanceOf(Error)
      await expect(instance.ensure(target.botId)).rejects.toMatchObject({
        code: "computer_unavailable"
      })
    } finally {
      await provider.close()
      await rm(profile, { recursive: true, force: true })
    }
  }, 10_000)

  it("downloads with shared login into isolated requests without changing either Bot's screen", async () => {
    let first = await broker.ensure("download-a")
    first = (await broker.act(first, { op: "navigate", url: `${url}/login` }, () => {})).target
    const second = await broker.ensure("download-b")
    const before = await broker.frame("download-a")
    const controller = new AbortController()
    const [a, b] = await Promise.all([
      broker.download(first, `${url}/file/a`, () => {}, controller.signal),
      broker.download(second, `${url}/file/b`, () => {}, controller.signal)
    ])
    expect(a.bytes.toString()).toBe("/file/a bot_test=shared")
    expect(b.bytes.toString()).toBe("/file/b bot_test=shared")
    expect(a.suggestedName).toBe("report.txt")
    const after = await broker.frame("download-a")
    expect(after.viewId).toBe(before.viewId)
    expect(after.url).toBe(before.url)
    await expect(
      broker.download(first, "file:///private/data", () => {}, controller.signal)
    ).rejects.toThrow("HTTP/HTTPS")
    await expect(
      broker.download(first, `${url}/file/large`, () => {}, controller.signal)
    ).rejects.toThrow("25 MiB")
  }, 20_000)

  it("cancels an in-flight download when the user takes over and rejects stale authority", async () => {
    const target = await broker.ensure("download-takeover")
    const downloading = broker.download(
      target,
      `${url}/file/slow`,
      () => {},
      new AbortController().signal
    )
    const rejected = expect(downloading).rejects.toThrow("画面或控制权")
    await new Promise((resolve) => setTimeout(resolve, 300))
    const human = await broker.takeControl(target)
    await rejected
    expect(human.control).toBe("human")
    await expect(
      broker.download(target, `${url}/file/a`, () => {}, new AbortController().signal)
    ).rejects.toThrow("画面或控制权")
  }, 10_000)

  it("executes transplanted snapshot, ref typing, click and screenshot on the exact Bot page", async () => {
    let target = await broker.ensure("bot-a")
    target = (await broker.act(target, { op: "navigate", url }, () => {})).target
    const snapshot = await broker.act(target, { op: "snapshot" }, () => {})
    const name = snapshot.data!.split("\n").find((line) => line.includes("Name"))!
    const save = snapshot.data!.split("\n").find((line) => line.includes("Save"))!
    const ref = (line: string) => line.match(/ref=(e\d+)/)![1]
    await broker.act(target, { op: "fill", ref: ref(name), value: "CmbCowork" }, () => {})
    await broker.act(target, { op: "click", ref: ref(save) }, () => {})
    expect((await broker.act(target, { op: "snapshot" }, () => {})).data).toContain("CmbCowork")
    expect((await broker.frame("bot-a")).image).toMatch(/^data:image\/jpeg;base64,/)
    expect((await broker.act(target, { op: "screenshot" }, () => {})).image).toMatch(
      /^data:image\/jpeg;base64,/
    )
  })

  it("observes native selections without changing them, with bounded labels and values", async () => {
    let target = await broker.ensure("select-state")
    target = (await broker.act(target, { op: "navigate", url: `${url}/select` }, () => {})).target
    const snapshot = (await broker.act(target, { op: "snapshot" }, () => {})).data!
    const region = snapshot.split("\n").find((line) => line.includes('combobox "Region"'))!
    expect(region, snapshot).toBeDefined()
    expect(region).toContain('selected=[{"value":"","label":"请选择区域"}]')
    expect(snapshot).toContain("Changes: 0")
    const many = snapshot.split("\n").find((line) => line.includes('combobox "Many"'))!
    const selections = JSON.parse(/ selected=(\[.*?\])/.exec(many)![1])
    expect(selections).toHaveLength(4)
    for (const [index, selection] of selections.entries()) {
      expect(selection).toEqual({
        value: `${index}-${"v".repeat(38)}…`,
        label: `${index}-${"L".repeat(78)}…`
      })
    }
    expect(many).toContain("selection truncated; 6 selected options")
    await broker.act(
      target,
      { op: "select_option", ref: /ref=(e\d+)/.exec(region)![1], values: ["west"] },
      () => {}
    )
    const selected = (await broker.act(target, { op: "snapshot" }, () => {})).data!
    expect(selected).toContain('selected=[{"value":"west","label":"西区"}]')
    expect(selected).toContain("Changes: 1")
    expect(selected).not.toContain('selected=[{"value":"east","label":"东区"}]')
    let other = await broker.ensure("select-other-owner")
    other = (await broker.act(other, { op: "navigate", url: `${url}/select` }, () => {})).target
    const otherSnapshot = (await broker.act(other, { op: "snapshot" }, () => {})).data!
    expect(otherSnapshot).toContain('selected=[{"value":"","label":"请选择区域"}]')
    expect(otherSnapshot).not.toContain('selected=[{"value":"west","label":"西区"}]')
  })

  it("fills only an exact password element, never exposes its value in snapshots, and rejects stale fields or takeover", async () => {
    const id = "password-test"
    const target = await broker.ensure(id)
    await broker.act(target, { op: "navigate", url: `${url}/password` }, () => {})
    const snapshot = await broker.act(broker.target(id), { op: "snapshot" }, () => {})
    const passwordRef = /Password[^\n]*?ref=(e\d+)/.exec(snapshot.data!)![1]
    const plainRef = /Plain[^\n]*?ref=(e\d+)/.exec(snapshot.data!)![1]
    const replaceRef = /Replace[^\n]*?ref=(e\d+)/.exec(snapshot.data!)![1]
    await expect(broker.prepareSecret(broker.target(id), plainRef, () => {})).rejects.toThrow(
      "密码输入框"
    )
    const first = await broker.prepareSecret(broker.target(id), passwordRef, () => {})
    expect(first).toMatchObject({ origin: url, path: "/password", field: "Password" })
    const secret = "SENSITIVE_VALUE_NEVER_LOG_73"
    await broker.fillSecret(first.token, secret, () => {}, new AbortController().signal)
    const after = await broker.act(broker.target(id), { op: "snapshot" }, () => {})
    expect(after.data).not.toContain(secret)
    expect(after.data).toContain("<redacted>")
    await expect(
      broker.fillSecret(first.token, secret, () => {}, new AbortController().signal)
    ).rejects.toThrow("过期")
    const stale = await broker.prepareSecret(broker.target(id), passwordRef, () => {})
    await broker.act(broker.target(id), { op: "click", ref: replaceRef }, () => {})
    await expect(
      broker.fillSecret(stale.token, "BLOCKED_REPLACEMENT", () => {}, new AbortController().signal)
    ).rejects.toThrow("安全填充未确认")
    const current = await broker.act(broker.target(id), { op: "snapshot" }, () => {})
    const ref = /Password[^\n]*?ref=(e\d+)/.exec(current.data!)![1]
    const handoff = await broker.prepareSecret(broker.target(id), ref, () => {})
    const human = await broker.takeControl(broker.target(id))
    await expect(
      broker.fillSecret(
        handoff.token,
        "BLOCKED_REPLACEMENT",
        () => {},
        new AbortController().signal
      )
    ).rejects.toThrow("安全填充未确认")
    // cloneNode preserves the first successful fill; rejected calls must not overwrite it.
    expect(await broker.teachObserve(id, (page) => page.locator("#password").inputValue())).toBe(
      secret
    )
    await broker.releaseControl(human)
  }, 20_000)

  it("exports POST forms, generated blobs and child-frame files through the original Grok ref click", async () => {
    await broker.act(
      await broker.ensure("export-login"),
      { op: "navigate", url: `${url}/login` },
      () => {}
    )
    const open = async (id: string, owner: string) => {
      let target = await broker.ensure(id)
      target = (
        await broker.act(target, { op: "navigate", url: `${url}/exports?owner=${owner}` }, () => {})
      ).target
      const snapshot = await broker.act(target, { op: "snapshot" }, () => {})
      const ref = (name: string) => {
        const line = snapshot.data?.split("\n").find((line) => line.includes(name))
        const match = line?.match(/ref=(e\d+)/)
        if (!match) throw new Error(`Missing export ref: ${name}`)
        return match[1]
      }
      return { target, ref }
    }
    const a = await open("post-a", "a"),
      b = await open("post-b", "b")
    const controller = new AbortController()
    const [first, second] = await Promise.all([
      broker.downloadFromPage(a.target, a.ref("Export POST"), () => {}, controller.signal),
      broker.downloadFromPage(b.target, b.ref("Export POST"), () => {}, controller.signal)
    ])
    expect(first.bytes.toString()).toBe("POST csrf=a-csrf bot_test=shared")
    expect(second.bytes.toString()).toBe("POST csrf=b-csrf bot_test=shared")
    expect(first.suggestedName).toBe("export.txt")
    const blob = await broker.downloadFromPage(
      a.target,
      a.ref("Export blob"),
      () => {},
      controller.signal
    )
    expect(blob.bytes.toString()).toBe("a-generated")
    expect(blob.suggestedName).toBe("generated.txt")
    const frame = await broker.downloadFromPage(
      a.target,
      a.ref("Export frame"),
      () => {},
      controller.signal
    )
    expect(frame.bytes.toString()).toBe("POST csrf=frame-csrf bot_test=shared")
    await expect(
      broker.downloadFromPage(a.target, a.ref("Export large"), () => {}, controller.signal)
    ).rejects.toThrow("25 MiB")
    expect((await broker.frame("post-a")).url).toBe(`${url}/exports?owner=a`)
    const stop = new AbortController()
    const pending = broker.downloadFromPage(a.target, a.ref("Export slow"), () => {}, stop.signal)
    const rejected = expect(pending).rejects.toThrow("export canceled")
    setTimeout(() => stop.abort(new Error("export canceled")), 150)
    await rejected
    expect((await broker.frame("post-a")).url).toBe(`${url}/exports?owner=a`)
  }, 30_000)

  it("collects ordinary Bot clicks, attachment-only popups and human input into the exact conversation", async () => {
    const store = new BotStore(":memory:")
    const files = new BotArtifacts(join(root, "automatic-files"), store)
    const a = store.createBot({ nonce: "auto-a", name: "Download A" })
    const b = store.createBot({ nonce: "auto-b", name: "Download B" })
    broker.humanDownloadReceiver = (botId, conversationId, threadRootId) =>
      botBrowserFileReceiver({
        botId,
        conversationId: conversationId ?? store.directConversation(botId).id,
        threadRootId,
        store,
        files
      })
    try {
      const open = async (created: typeof a, owner: string) => {
        const target = await broker.ensure(created.bot.id)
        await broker.act(target, { op: "navigate", url: `${url}/exports?owner=${owner}` }, () => {})
        const snapshot = await broker.act(
          broker.target(created.bot.id),
          { op: "snapshot" },
          () => {}
        )
        const ref = (label: string) => {
          const line = snapshot.data!.split("\n").find((line) => line.includes(label))!
          return line.match(/ref=(e\d+)/)![1]
        }
        return { ref, created }
      }
      const first = await open(a, "a"),
        second = await open(b, "b")
      const click = async (which: typeof first, label: string) => {
        const results: BotArtifact[] = []
        await broker.act(
          broker.target(which.created.bot.id),
          { op: "click", ref: which.ref(label) },
          () => {},
          botBrowserFileReceiver({
            botId: which.created.bot.id,
            conversationId: which.created.conversationId,
            store,
            files,
            results
          })
        )
        return results
      }
      const [postA, postB] = await Promise.all([
        click(first, "Export POST"),
        click(second, "Export POST")
      ])
      expect(postA).toHaveLength(1)
      expect(postB).toHaveLength(1)
      expect((await files.read(postA[0].id)).bytes.toString()).toContain("csrf=a-csrf")
      expect((await files.read(postB[0].id)).bytes.toString()).toContain("csrf=b-csrf")
      const blob = await click(first, "Export blob")
      expect((await files.read(blob[0].id)).bytes.toString()).toBe("a-generated")
      const child = await click(first, "Export frame")
      expect((await files.read(child[0].id)).bytes.toString()).toContain("frame-csrf")
      const popup = await click(first, "Export popup")
      expect(popup).toHaveLength(1)
      expect((await files.read(popup[0].id)).bytes.toString()).toContain("/file/popup")
      expect(await click(first, "Export large")).toEqual([])
      expect(store.messages(a.conversationId).at(-1)?.text).toContain("25 MiB")
      expect(store.artifacts(b.conversationId)).toEqual(postB)
      // Explicit capture supersedes automatic collection: exactly one caller publishes it.
      const count = store.artifacts(a.conversationId).length
      const explicit = await broker.downloadFromPage(
        broker.target(a.bot.id),
        first.ref("Export blob"),
        () => {},
        new AbortController().signal
      )
      expect(explicit.bytes.toString()).toBe("a-generated")
      expect(store.artifacts(a.conversationId)).toHaveLength(count)
      await broker.takeControl(broker.target(a.bot.id))
      const frame = await broker.frame(a.bot.id)
      const bounds = await broker.teachObserve(a.bot.id, (page) =>
        page.getByText("Export blob", { exact: true }).boundingBox()
      )
      await broker.humanInput(frame, {
        kind: "click",
        frameSeq: frame.frameSeq,
        x: Math.round(bounds!.x + bounds!.width / 2),
        y: Math.round(bounds!.y + bounds!.height / 2)
      })
      await expect.poll(() => store.artifacts(a.conversationId).length).toBe(count + 1)
      const humanFile = store.artifacts(a.conversationId)[0]
      expect((await files.read(humanFile.id)).bytes.toString()).toBe("a-generated")
      expect(store.messages(a.conversationId).at(-1)?.attachments).toEqual([humanFile.id])
      expect(store.snapshot().runs).toEqual([]) // Download notices never launch an Agent.
      await broker.releaseControl(broker.target(a.bot.id))
      const group = store.createGroup({
        nonce: "download-group",
        name: "Downloads",
        members: [a.bot.id, b.bot.id]
      })
      await broker.takeControl(broker.target(a.bot.id), group.id)
      const groupFrame = await broker.frame(a.bot.id)
      await broker.humanInput(groupFrame, {
        kind: "click",
        frameSeq: groupFrame.frameSeq,
        x: Math.round(bounds!.x + bounds!.width / 2),
        y: Math.round(bounds!.y + bounds!.height / 2)
      })
      await expect.poll(() => store.artifacts(group.id).length).toBe(1)
      expect(store.artifacts(a.conversationId)).toHaveLength(count + 1)
      await broker.releaseControl(broker.target(a.bot.id))
      const branchRoot = store.send({
        nonce: "download-branch-root",
        conversationId: group.id,
        text: "Download discussion",
        recipients: [a.bot.id]
      })
      store.cancel(branchRoot.runIds[0])
      await broker.takeControl(broker.target(a.bot.id), group.id, branchRoot.messageId)
      const branchFrame = await broker.frame(a.bot.id)
      await broker.humanInput(branchFrame, {
        kind: "click",
        frameSeq: branchFrame.frameSeq,
        x: Math.round(bounds!.x + bounds!.width / 2),
        y: Math.round(bounds!.y + bounds!.height / 2)
      })
      await expect
        .poll(
          () => store.messages(group.id, undefined, 100, undefined, branchRoot.messageId).length
        )
        .toBe(1)
      const branchFile = store.messages(
        group.id,
        undefined,
        100,
        undefined,
        branchRoot.messageId
      )[0].attachments[0]
      expect((await files.read(branchFile)).bytes.toString()).toBe("a-generated")
      expect(
        store.messages(group.id).some((message) => message.attachments.includes(branchFile))
      ).toBe(false)
      await broker.releaseControl(broker.target(a.bot.id))
      // A page not assigned to any Bot cannot inject a file into a conversation.
      const unowned = await broker.teachEncoderPage()
      await unowned.goto(`${url}/file/unowned`).catch(() => {})
      await unowned.close()
      expect(store.artifacts(a.conversationId)).toHaveLength(count + 1)
    } finally {
      broker.humanDownloadReceiver = undefined
      await files.close()
      store.close()
    }
  }, 30_000)

  it("shares login cookies while isolating same-URL pages and tab lists", async () => {
    const a = broker.target("bot-a"),
      b = await broker.ensure("bot-b")
    await broker.act(a, { op: "navigate", url: `${url}/login` }, () => {})
    await broker.act(b, { op: "navigate", url }, () => {})
    expect((await broker.act(b, { op: "snapshot" }, () => {})).data).toContain("bot_test=shared")
    expect(
      JSON.parse((await broker.act(a, { op: "tabs", action: "list" }, () => {})).data!)
    ).toHaveLength(1)
    expect(
      JSON.parse((await broker.act(b, { op: "tabs", action: "list" }, () => {})).data!)
    ).toHaveLength(1)
    await expect(
      broker.act({ ...b, viewId: a.viewId }, { op: "click", ref: "e1" }, () => {})
    ).rejects.toThrow("画面或控制权")
    await expect(
      broker.act(b, { op: "cdp", method: "Target.getTargets" }, () => {})
    ).rejects.toThrow("授权接口")
    await expect(
      broker.act(b, { op: "navigate", url: "file:///etc/passwd" }, () => {})
    ).rejects.toThrow("HTTP/HTTPS")
  })

  it("blocks Bot inputs during takeover and rejects stale frames after handback", async () => {
    const bot = broker.target("bot-a"),
      human = await broker.takeControl(bot)
    await expect(broker.act(bot, { op: "press_key", key: "Enter" }, () => {})).rejects.toThrow(
      "控制权"
    )
    const frame = await broker.frame(bot.botId)
    await broker.humanInput(human, { frameSeq: frame.frameSeq, kind: "click", x: 25, y: 20 })
    await expect(
      broker.humanInput(human, { frameSeq: frame.frameSeq, kind: "click", x: 25, y: 20 })
    ).rejects.toThrow("画面已过期")
    const returned = await broker.releaseControl(human)
    await expect(
      broker.humanInput(human, { frameSeq: frame.frameSeq, kind: "key", key: "Enter" })
    ).rejects.toThrow("控制权")
    expect((await broker.act(returned, { op: "snapshot" }, () => {})).summary).toContain("snapshot")
  })

  it("uses stable owned tab identities for human selection and invalidates old frame tickets", async () => {
    await broker.takeControl(broker.target("bot-a"))
    const first = await broker.frame("bot-a")
    await broker.humanInput(first, { kind: "tab_new", frameSeq: first.frameSeq })
    const second = await broker.frame("bot-a")
    expect(second.tabs).toHaveLength(2)
    expect(second.viewId).not.toBe(first.viewId)
    await expect(
      broker.humanInput(first, { kind: "click", frameSeq: first.frameSeq, x: 5, y: 5 })
    ).rejects.toThrow("画面或控制权")
    const foreign = await broker.frame("bot-b")
    await expect(
      broker.humanInput(second, {
        kind: "tab_select",
        viewId: foreign.viewId,
        frameSeq: second.frameSeq
      })
    ).rejects.toThrow("不属于")
    const refreshed = await broker.frame("bot-a")
    await broker.humanInput(refreshed, {
      kind: "tab_select",
      viewId: first.viewId,
      frameSeq: refreshed.frameSeq
    })
    const selected = await broker.frame("bot-a")
    expect(selected.viewId).toBe(first.viewId)
    await broker.humanInput(selected, {
      kind: "tab_close",
      viewId: second.viewId,
      frameSeq: selected.frameSeq
    })
    const remaining = await broker.frame("bot-a")
    expect(remaining.tabs).toHaveLength(1)
    expect(remaining.viewId).toBe(first.viewId)
    await broker.releaseControl(remaining)
  })

  it("restores owned URLs and selected tab after the browser process is recreated", async () => {
    const manifests = new Map<string, { urls: string[]; active: number }>()
    const persistence = {
      loadBrowserSession: (id: string) => manifests.get(id) ?? null,
      saveBrowserSession: (id: string, value: { urls: string[]; active: number }) => {
        manifests.set(id, value)
      }
    }
    const launch = async () =>
      new BotBrowserBroker(
        await chromium.launchPersistentContext(join(root, "restore-profile"), {
          channel:
            process.env.CMB_BOT_BROWSER_CHANNEL ||
            (process.platform === "win32" ? "msedge" : "chrome"),
          headless: true,
          chromiumSandbox: true
        }),
        persistence
      )
    let local = await launch()
    try {
      let target = await local.ensure("restore-bot")
      target = (await local.act(target, { op: "navigate", url: `${url}/first` }, () => {})).target
      target = (await local.act(target, { op: "tabs", action: "new" }, () => {})).target
      await local.act(target, { op: "navigate", url: `${url}/second` }, () => {})
      const before = await local.frame("restore-bot")
      expect(manifests.get("restore-bot")).toEqual({
        urls: [`${url}/first`, `${url}/second`],
        active: 1
      })
      await local.close()
      local = await launch()
      const restored = await local.frame("restore-bot")
      expect(restored.url).toBe(`${url}/second`)
      expect(restored.tabs).toHaveLength(2)
      expect(restored.generation).not.toBe(before.generation)
      await expect(local.act(before, { op: "click", ref: "e1" }, () => {})).rejects.toThrow(
        "画面或控制权"
      )
    } finally {
      await local.close()
    }
  }, 30_000)
})
