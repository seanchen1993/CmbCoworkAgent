/** Actual BotWorkspace, authenticated public clone RPC and physical public backup/restore.
 * Only unrelated outer app settings, a capability projection, and delivery of
 * already accepted RPC replies are controlled. No model or native shell is used. */
import { afterAll, beforeAll, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { randomBytes, randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium, type Browser, type Page } from "playwright"
import { highlightWorkerFixture } from "../../../tests/fixtures/highlight-worker"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import {
  inspectBotOwnedShellMaintenance,
  ownedShellMaintenanceOwner
} from "./owned-shell-maintenance-fence"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { executeBotBackup } from "./backups"
import { serializeBotFailure } from "./error-diagnostic"
import type { BotCloneInput, CoworkBot } from "../../shared/bot-types"

const enabled = process.env.CMB_CLONE_EPOCH_BROWSER_TEST === "1"
let browser: Browser, script: string, styles: string
beforeAll(async () => {
  if (!enabled) return
  const renderer = resolve("src/renderer/src")
  const css = await compile(
    (await readFile(join(renderer, "index.css"), "utf8")).replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => {} }
  )
  styles = css.build(
    new Scanner({ sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }] }).scan()
  )
  const bundle = await build({
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `import React from'react';import{createRoot}from'react-dom/client';import{BotWorkspace}from'./src/renderer/src/components/bots/BotWorkspace';import{useBotWorkspaceStore as store}from'./src/renderer/src/lib/bot-workspace-store';import{Toaster}from'sonner';window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)})};window.fixtureRefresh=()=>store.getState().refresh();window.fixtureSelect=id=>store.getState().select(id);window.fixtureDraft=text=>{const s=store.getState();s.draft(s.selected,text)};window.fixtureState=()=>({selected:store.getState().selected,snapshot:store.getState().snapshot,drafts:store.getState().drafts});createRoot(document.getElementById('root')).render(<div style={{height:'100vh',display:'flex'}}><BotWorkspace/><Toaster/></div>);`
    },
    outfile: "clone-epoch-ui.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
      __APP_VERSION__: '"fixture"'
    },
    plugins: [
      await highlightWorkerFixture(renderer),
      {
        name: "outer-app-settings-only",
        setup(b) {
          b.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
            path: "thread-context",
            namespace: "outer-thread"
          }))
          b.onLoad({ filter: /.*/, namespace: "outer-thread" }, () => ({
            loader: "js",
            contents:
              "export const useThreadStateSelector=(_id,selector)=>selector({workspacePath:null,workspaceFiles:[]});"
          }))
          b.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, (a) =>
            a.path === "./store" && !a.importer.startsWith(join(renderer, "lib"))
              ? undefined
              : { path: "app", namespace: "outer" }
          )
          b.onLoad({ filter: /.*/, namespace: "outer" }, () => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents:
              'import{create}from"zustand";export const useAppStore=create(()=>({models:[],showCustomizeView:false,setMainView:()=>{},setShowCustomizeView:()=>{}}));'
          }))
        }
      }
    ]
  })
  const output = bundle.outputFiles.find((file) => file.path.endsWith(".js"))
  if (!output) throw new Error("Missing actual BotWorkspace JavaScript fixture output")
  script = output.text
  styles +=
    "\n" +
    bundle.outputFiles
      .filter((file) => file.path.endsWith(".css"))
      .map((file) => file.text)
      .join("\n")
  browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
}, 30_000)
afterAll(async () => {
  await browser?.close()
})

type Live = {
  store: BotStore
  host: BotHost
  client: BotTransportClient
  stopped: Promise<void>
}
type Ack = {
  request: BotCloneInput
  result: { bot: CoworkBot; conversationId: string }
  release(): void
  returned: boolean
}
async function fixture(label: string) {
  const evidenceRoot = resolve("output/clone-epoch")
  await mkdir(evidenceRoot, { recursive: true })
  const root = await realpath(await mkdtemp(join(evidenceRoot, label + "-")))
  await mkdir(join(root, "objects"))
  const seed = new BotStore(join(root, "bots.sqlite"))
  const a = seed.createBot({ nonce: "a", name: "A", instructions: "Review source work" }),
    b = seed.createBot({ nonce: "b", name: "B", instructions: "Keep current work" })
  seed.saveMemory({ botId: a.bot.id, text: "A private fact" })
  seed.close()
  let live: Live | undefined
  const open = async () => {
    const lock = BotHostLock.acquire(root)!
    const store = new BotStore(join(root, "bots.sqlite"))
    const host = new BotHost(store)
    host.bindOwnership(lock)
    host.bindIdleRestartPreflight((signal) =>
      inspectBotOwnedShellMaintenance(root, ownedShellMaintenanceOwner(lock), signal)
    )
    let done!: () => void, failed!: (error: unknown) => void
    const stopped = new Promise<void>((resolve, reject) => {
      done = resolve
      failed = reject
    })
    void stopped.catch(() => {})
    const token = randomBytes(32).toString("hex")
    const socket =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-clone-ui-${token.slice(0, 16)}`
        : join(tmpdir(), `cmb-clone-ui-${token.slice(0, 20)}.sock`)
    const server = new BotRpcServer(host, token, async () => {
      try {
        await server.close()
        await host.stop()
        store.close()
        lock.release()
        done()
      } catch (error) {
        failed(error)
      }
    })
    await server.listen(socket)
    const client = new BotTransportClient({
      version: 1,
      hostId: host.id,
      pid: process.pid,
      socketPath: socket,
      token
    })
    live = { store, host, client, stopped }
  }
  const stop = async () => {
    if (!live) return
    const previous = live
    expect((await previous.client.restartIfIdle(previous.host.id)).accepted).toBe(true)
    await previous.stopped
    await previous.client.closeAndWait()
    live = undefined
  }
  await open()
  let page: Page | undefined,
    hold = false,
    dropAck = false,
    stripEpochCapability = false
  const acks: Ack[] = [],
    calls: { method: string; input: unknown; epoch: string }[] = [],
    errors: string[] = []
  const createPage = async () => {
    page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
    page.setDefaultTimeout(5000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      calls.push({ method, input, epoch: live!.store.dataEpoch() })
      try {
        const result: unknown = await Reflect.apply(live!.client.call, live!.client, [
          method,
          input
        ])
        if (method === "status" && stripEpochCapability) {
          const value = result as { capabilities: string[] }
          return {
            ...value,
            capabilities: value.capabilities.filter((capability) => capability !== "clone-epoch")
          }
        }
        if (method === "clone" && hold) {
          hold = false
          let release!: () => void
          const pending = new Promise<void>((resolve) => {
            release = resolve
          })
          const ack: Ack = {
            request: input as BotCloneInput,
            result: result as Ack["result"],
            release,
            returned: false
          }
          acks.push(ack)
          await pending
          ack.returned = true
        }
        if (method === "clone" && dropAck) {
          dropAck = false
          return { botFailure: { code: "host_disconnected", message: "Accepted clone ACK lost" } }
        }
        return result
      } catch (error) {
        return { botFailure: serializeBotFailure(error) }
      }
    })
    await page.route("http://127.0.0.1:39489/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8"><style>${styles}</style><div id="root"></div><script>${script.replaceAll("</script", "<\\/script")}</script>`
      })
    )
    await page.goto("http://127.0.0.1:39489/")
    await expect
      .poll(
        async () =>
          (await page!.evaluate(() => Reflect.get(window, "fixtureState")())).snapshot?.bots.length
      )
      .toBe(2)
    await select(a.conversationId, "A")
    return page
  }
  const select = async (id: string, name: string) => {
    await page!.evaluate((id) => Reflect.get(window, "fixtureSelect")(id), id)
    await page!.getByRole("heading", { name, exact: true, level: 2 }).waitFor()
    await expect.poll(async () => (await state()).selected).toBe(id)
  }
  const state = async () => page!.evaluate(() => Reflect.get(window, "fixtureState")())
  const settle = async () =>
    page!.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
  const clone = async () => {
    await page!.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
    await page!.getByRole("menuitem", { name: "复制 Bot", exact: true }).click()
    await page!.getByRole("menu").waitFor({ state: "hidden" })
  }
  const draft = async (text: string) => {
    await page!.getByLabel("向 Bot 交办工作", { exact: true }).fill(text)
    await expect.poll(async () => (await state()).drafts[b.conversationId]?.prompt).toBe(text)
  }
  const restoreAccepted = async () => {
    await stop()
    const backup = (await executeBotBackup(root, { action: "create", nonce: randomUUID() })).backup!
    await executeBotBackup(root, {
      action: "restore",
      nonce: randomUUID(),
      backup: { id: backup.id, sha256: backup.sha256 }
    })
    await open()
    expect(live!.store.dataEpoch()).not.toBe("initial")
    await page!.evaluate(() => Reflect.get(window, "fixtureRefresh")())
    await expect.poll(async () => (await state()).snapshot?.dataEpoch).toBe(live!.store.dataEpoch())
    return backup
  }
  const close = async () => {
    for (const ack of acks) ack.release()
    if (page) {
      await settle().catch(() => {})
      await writeFile(
        join(root, "ui-final.json"),
        JSON.stringify(
          {
            calls,
            acks,
            errors,
            state: await state(),
            body: await page.locator("body").innerText()
          },
          null,
          2
        ) + "\n"
      )
      await page.screenshot({ animations: "disabled", path: join(root, "final.png") })
      await page.close()
    }
    const evidence = live
      ? {
          snapshot: live.store.snapshot(),
          receipts: live.store.db.exec("SELECT * FROM bot_receipts ORDER BY nonce")
        }
      : null
    await stop()
    await writeFile(
      join(root, "proof.json"),
      JSON.stringify({ root, a, b, calls, acks, errors, evidence }, null, 2) + "\n"
    )
    console.log(JSON.stringify({ fixture: label, retainedRoot: root }))
  }
  return {
    root,
    a,
    b,
    createPage,
    select,
    state,
    settle,
    clone,
    draft,
    restoreAccepted,
    close,
    calls,
    errors,
    acks,
    hold: () => {
      hold = true
    },
    dropAck: () => {
      dropAck = true
    },
    stripCapability: () => {
      stripEpochCapability = true
    },
    get live() {
      return live!
    }
  }
}
it.skipIf(!enabled)(
  "an accepted old clone ACK cannot navigate a restored workspace or clear the new owner's pending clone",
  async () => {
    const f = await fixture("epoch-ack")
    try {
      const page = await f.createPage()
      f.hold()
      await f.clone()
      await expect.poll(() => f.acks.length).toBe(1)
      const old = f.acks[0]
      expect(f.live.store.snapshot().bots).toHaveLength(3)
      await f.restoreAccepted()
      await f.select(f.b.conversationId, "B")
      await f.draft("CURRENT_RESTORED_B_DRAFT")
      f.hold()
      await f.clone()
      await expect.poll(() => f.acks.length).toBe(2)
      const fresh = f.acks[1]
      expect(fresh.request.id).toBe(f.b.bot.id)
      old.release()
      await expect.poll(() => old.returned).toBe(true)
      await f.settle()
      expect((await f.state()).selected).toBe(f.b.conversationId)
      expect((await f.state()).drafts[f.b.conversationId].prompt).toBe("CURRENT_RESTORED_B_DRAFT")
      await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
      expect(
        await page
          .getByRole("menuitem", { name: "正在复制…", exact: true })
          .getAttribute("aria-disabled")
      ).toBe("true")
      await page.keyboard.press("Escape")
      await page.getByRole("menu").waitFor({ state: "hidden" })
      fresh.release()
      await expect.poll(() => fresh.returned).toBe(true)
      await expect.poll(async () => (await f.state()).selected).toBe(fresh.result.conversationId)
      expect(fresh.request.expectedDataEpoch).toBe(f.live.store.dataEpoch())
      expect(f.live.store.snapshot().bots).toHaveLength(4)
      expect(f.calls.filter((call) => call.method === "clone")).toHaveLength(2)
      expect(f.live.store.memories(old.result.bot.id)).toEqual([])
      expect(f.errors).toEqual([])
    } finally {
      await f.close()
    }
  },
  30_000
)
it.skipIf(!enabled)(
  "an accepted same-epoch clone refreshes the registry without replacing another Bot's selected view or draft",
  async () => {
    const f = await fixture("view-ack")
    try {
      const page = await f.createPage()
      f.hold()
      await f.clone()
      await expect.poll(() => f.acks.length).toBe(1)
      const ack = f.acks[0]
      await f.select(f.b.conversationId, "B")
      await f.draft("CURRENT_B_DRAFT")
      ack.release()
      await expect.poll(() => ack.returned).toBe(true)
      await expect.poll(async () => (await f.state()).snapshot.bots.length).toBe(3)
      await f.settle()
      expect((await f.state()).selected).toBe(f.b.conversationId)
      expect((await f.state()).drafts[f.b.conversationId].prompt).toBe("CURRENT_B_DRAFT")
      await page.getByRole("button", { name: "A copy", exact: true }).waitFor()
      await f.clone()
      await page.getByRole("heading", { name: "B copy", exact: true, level: 2 }).waitFor()
      expect(f.calls.filter((call) => call.method === "clone")).toHaveLength(2)
      expect(f.live.store.snapshot().bots).toHaveLength(4)
      expect(f.errors).toEqual([])
    } finally {
      await f.close()
    }
  },
  30_000
)
it.skipIf(!enabled)(
  "a Host advertising generic mutation-data-epoch-v2 without the separate clone epoch contract disables only clone with an accessible reason",
  async () => {
    const f = await fixture("old-capability")
    try {
      f.stripCapability()
      const page = await f.createPage()
      expect((await f.live.client.call("status")).capabilities).toContain("mutation-data-epoch-v2")
      await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
      const clone = page.getByRole("menuitem", { name: "复制 Bot", exact: true })
      expect(await clone.getAttribute("aria-disabled")).toBe("true")
      expect(await clone.getAttribute("aria-description")).toContain("后台")
      await clone.getByText("需更新后台", { exact: true }).waitFor()
      expect(f.calls.filter((call) => call.method === "clone")).toHaveLength(0)
      expect(f.live.store.snapshot().bots).toHaveLength(2)
      expect(f.errors).toEqual([])
    } finally {
      await f.close()
    }
  },
  30_000
)
it.skipIf(!enabled)(
  "an uncertain accepted ACK retries the original scoped clone nonce and navigates the one accepted copy",
  async () => {
    const f = await fixture("nonce-retry")
    try {
      const page = await f.createPage()
      f.dropAck()
      await f.clone()
      await page.getByText("Accepted clone ACK lost", { exact: true }).waitFor()
      expect((await f.state()).selected).toBe(f.a.conversationId)
      expect(f.live.store.snapshot().bots).toHaveLength(3)
      await f.clone()
      await page.getByRole("heading", { name: "A copy", exact: true, level: 2 }).waitFor()
      const calls = f.calls.filter((call) => call.method === "clone")
      expect(calls).toHaveLength(2)
      expect(calls[1].input).toEqual(calls[0].input)
      expect((calls[0].input as BotCloneInput).expectedDataEpoch).toBe("initial")
      expect(f.live.store.snapshot().bots).toHaveLength(3)
      expect(f.errors).toEqual([])
    } finally {
      await f.close()
    }
  },
  30_000
)
