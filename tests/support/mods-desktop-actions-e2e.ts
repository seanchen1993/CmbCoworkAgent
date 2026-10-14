import assert from "node:assert/strict"
import { join } from "node:path"
import { writeFileSync } from "node:fs"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { openModsResults } from "./mods-sidebar-navigation"

/** Production utility guest, mounted React chat, authenticated IPC and actual OS clipboard. */
export async function verifyDesktopActions(
  app: ElectronApplication,
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  // Original clipboard content never crosses into the renderer, test runner or logs.
  await app.evaluate(({ clipboard }) => {
    const formats = clipboard.availableFormats()
    if (
      formats.some(
        (format) =>
          !["text/plain", "text/html", "text/rtf", "image/png", "image/jpeg"].includes(format)
      )
    )
      throw Error("Clipboard has a format this isolated test cannot safely restore")
    const image = clipboard.readImage()
    const saved = {
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
      formats,
      ...(!image.isEmpty() ? { image } : {}),
      empty: formats.length === 0
    }
    ;(globalThis as unknown as { __modsClipboardBefore: typeof saved }).__modsClipboardBefore =
      saved
  })
  try {
    const id = await page.evaluate(async (workspace) => {
      const thread = await window.api.threads.create({
        title: "桌面组件实际验证",
        workspacePath: workspace,
        agentMode: "normal"
      })
      const id = (thread as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, workspace)
      await window.api.mods.configure(id, true, true)
      return id
    }, workspace)
    for (const [name, hook] of [
      [
        "desktop-kit",
        `
        on("session.start",async($,e,next)=>{for(const name of ["desk-open","desk-copy","desk-state","desk-panes","desk-select","desk-bench"])
          await $.command.register({name,description:name,immediate:true});return next(e)});
        on("command.run",{command:"desk-open"},async($)=>{await $.ui.open({id:"desktop",title:"桌面组件"});return {}});
        on("command.run",{command:"desk-copy"},async($,e)=>({text:JSON.stringify(await $.ui.copy({text:e.args}))}));
        on("command.run",{command:"desk-state"},async($)=>({text:JSON.stringify({selected:await $.store.get("selected"),
          copied:await $.store.get("copied"),renders:await $.store.get("renders")})}));
        on("command.run",{command:"desk-panes"},async($)=>({text:JSON.stringify(await $.ui.panes())}));
        on("command.run",{command:"desk-bench"},async($)=>{const samples=[];for(let i=0;i<24;i++){
          const start=Date.now();await $.ui.panes();samples.push(Date.now()-start)}return {text:JSON.stringify(samples)}});
        on("command.run",{command:"desk-select"},async($)=>({text:JSON.stringify(await $.ui.selection())}));
        on("ui.render",{component:"Pane",requestId:"desktop"},async($,e)=>{
          await $.store.set("renders",(await $.store.get("renders")??0)+1);
          const {Box,Text,Button}=$.ui.resolve(e);return <Box flexDirection="column">
            <Text>选中聊天文字，再点复制按钮</Text>
            <Button key="copy" label="复制所选内容" onPress={async()=>{
              const selected=await $.ui.selection();await $.store.set("selected",selected??null);
              const copied=selected?await $.ui.copy({text:selected.text}):{isCopied:false,reason:"refused"};
              await $.store.set("copied",copied)
            }}/></Box>
        });`
      ],
      ["desktop-neighbor", `on("ui.copy",async($,e,next)=>next({...e,text:"[combined] "+e.text}));`]
    ]) {
      const zip = new AdmZip()
      zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name, version: "1.0.0" })))
      zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
      zip.addFile("hooks/register.tsx", Buffer.from(`export function register(on){${hook}}`))
      const installed = await page.evaluate(
        (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "desktop.zip", "local"),
        [...zip.toBuffer()]
      )
      assert(installed.success, installed.error)
      const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
        (row) => row.name === name
      )!
      assert(mod?.digest)
      await page.evaluate(
        ({ id, mod }) => window.api.mods.approveFunction(id, mod.pluginId, mod.digest!),
        { id, mod }
      )
    }
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("桌面组件实际验证", { exact: true }).first().click()
    const run = async (command: string, text = "") => {
      const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), id)).find(
        (row) => row.command === command
      )!
      assert(descriptor, command)
      const job = await page.evaluate(
        ({ id, descriptor, text }) => window.api.mods.enqueue(id, descriptor, { text }),
        { id, descriptor, text }
      )
      await until(async () => {
        const current = (await page.evaluate((id) => window.api.mods.jobs(id), id)).find(
          (row) => row.id === job.id
        )!
        if (current.state === "failed") throw Error(JSON.stringify(current))
        return current.state === "succeeded"
      }, command)
      return (await page.evaluate((id) => window.api.mods.jobs(id), id)).find(
        (row) => row.id === job.id
      )!.result!
    }
    const equals = async (text: string) =>
      app.evaluate(({ clipboard }, text) => clipboard.readText() === text, text)
    const diagnose = () =>
      app.evaluate(({ clipboard }) => {
        const text = clipboard.readText()
        return {
          matchesSaved:
            text ===
            (globalThis as unknown as { __modsClipboardBefore: { text: string } })
              .__modsClipboardBefore.text,
          containsFixture: text.includes("cold desktop text"),
          doublePrefix: text === "[combined] [combined] cold desktop text",
          empty: text === "",
          fixtureWrapped: text.includes("[combined]")
        }
      })
    const receipt = JSON.parse((await run("desk-copy", "cold desktop text")).text)
    const clipboardAvailable = receipt.isCopied === true
    if (clipboardAvailable) {
      assert(await equals("[combined] cold desktop text"), JSON.stringify(await diagnose()))
      pass("Cold approved command uses two actual guests and writes the real OS clipboard")
    } else {
      assert.deepEqual(receipt, { isCopied: false, reason: "no-clipboard" })
      pass(
        "Actual OS clipboard denies the write; SDK honestly returns no-clipboard (positive native copy unverified here)"
      )
    }
    await run("desk-open")
    await openModsResults(page)
    const pane = page.locator('[data-function-pane="desktop"]')
    await pane.getByRole("button", { name: "复制所选内容", exact: true }).waitFor()
    const composer = page.locator("textarea.composer-textarea")
    await composer.fill("ChosenDesktopWord")
    await composer.press("Enter")
    await until(
      async () =>
        (await page
          .locator("[data-chat-message-id]")
          .getByText("ChosenDesktopWord", { exact: true })
          .count()) === 1 &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "actual transcript"
    )
    const chosen = page
      .locator("[data-chat-message-id]")
      .getByText("ChosenDesktopWord", { exact: true })
    const requestId = await chosen.evaluate(
      (node) => node.closest<HTMLElement>("[data-chat-message-id]")!.dataset.chatMessageId
    )
    await chosen.dblclick({ position: { x: 15, y: 8 } })
    await pane.getByRole("button", { name: "复制所选内容", exact: true }).click()
    if (clipboardAvailable)
      await until(() => equals("[combined] ChosenDesktopWord"), "native selection copy")
    let state: { selected?: unknown; copied?: unknown; renders?: number } = {}
    await until(async () => {
      state = JSON.parse((await run("desk-state")).text)
      return Boolean(state.copied)
    }, "actual button completion")
    assert.deepEqual(state.selected, { text: "ChosenDesktopWord", requestId })
    assert.deepEqual(
      state.copied,
      clipboardAvailable ? { isCopied: true } : { isCopied: false, reason: "no-clipboard" }
    )
    pass(
      "Actual mouse selection survives a component click and retains real message id and honest clipboard receipt"
    )
    const metadata = JSON.parse((await run("desk-panes")).text)
    assert.equal(metadata.length, 1)
    assert.deepEqual(
      { ...metadata[0], isFocused: false },
      { id: "desktop", title: "桌面组件", isPlaced: true, isShown: true, isFocused: false }
    )
    assert.equal(JSON.parse((await run("desk-state")).text).renders, state.renders)
    pass("Pane SDK reports the actual placed drawing without invoking render again")
    const samples = JSON.parse((await run("desk-bench")).text) as number[]
    assert.equal(samples.length, 24)
    const sorted = [...samples].sort((a, b) => a - b),
      median = sorted[12],
      p95 = sorted[22]
    assert(median < 150 && p95 < 500, "actual SDK pane query latency")
    assert.equal(JSON.parse((await run("desk-state")).text).renders, state.renders)
    writeFileSync(
      join(artifacts, "desktop-actions-performance.json"),
      JSON.stringify(
        {
          scope:
            "24 actual guest SDK pane queries including main/renderer IPC; local isolated app, not network or model latency",
          samples,
          medianMs: median,
          p95Ms: p95,
          clipboardPositiveVerified: clipboardAvailable
        },
        null,
        2
      )
    )
    pass(`Actual desktop pane queries: median ${median} ms, p95 ${p95} ms; no extra render`)
    await page.screenshot({ path: join(artifacts, "desktop-selection-copy.png"), fullPage: true })
    await chosen.dblclick({ position: { x: 15, y: 8 } })
    assert.deepEqual(JSON.parse((await run("desk-select")).text), {
      text: "ChosenDesktopWord",
      requestId
    })
    assert.equal((await run("desk-select")).text, "")
    pass("Command completion clears only its captured selection; next query sees real undefined")
    await page.getByRole("button", { name: "配置", exact: true }).click()
    assert.equal(JSON.parse((await run("desk-panes")).text)[0].isShown, false)
    pass("Switching sidebar tab reports the plugin pane as hidden")
    await page.evaluate((id) => window.api.mods.configure(id, false, false), id)
    await until(
      async () => !(await page.evaluate((id) => window.api.mods.status(id), id)).effective,
      "Mods off"
    )
    pass("Disabling Mods retires the desktop owner and preserves the ordinary chat")
  } finally {
    const restored = await app.evaluate(({ clipboard }) => {
      const scope = globalThis as unknown as {
        __modsClipboardBefore?: {
          text: string
          html: string
          rtf: string
          formats: string[]
          image?: Electron.NativeImage
          empty: boolean
        }
      }
      const saved = scope.__modsClipboardBefore!
      if (saved.empty) clipboard.clear()
      else
        clipboard.write({
          ...(saved.formats.includes("text/plain") ? { text: saved.text } : {}),
          ...(saved.formats.includes("text/html") ? { html: saved.html } : {}),
          ...(saved.formats.includes("text/rtf") ? { rtf: saved.rtf } : {}),
          ...(saved.image ? { image: saved.image } : {})
        })
      const ok =
        clipboard.readText() === saved.text &&
        clipboard.readRTF() === saved.rtf &&
        (!saved.image || clipboard.readImage().toPNG().equals(saved.image.toPNG()))
      delete scope.__modsClipboardBefore
      return ok
    })
    assert(restored, "original clipboard restored in main process")
    pass(
      "Main-process clipboard cleanup completed without exposing content; inaccessible OS clipboard preservation is not claimed"
    )
  }
}
