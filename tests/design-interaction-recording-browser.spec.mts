import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import { build } from "esbuild"
import { chromium } from "playwright"
import { localizeCaptureAssets } from "../src/main/services/design/capture-assets"
import { installSnapshotRuntime } from "../src/main/services/design/page-snapshot"

const root = process.cwd()
const app = await build({
  stdin: {
    resolveDir: root,
    contents: `
export * from './src/main/services/design/interaction-recording';
export * from './src/main/services/design/page-snapshot';
export * from './src/renderer/src/lib/design-html-srcdoc';
`
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm"
})
let businessRequests = 0
const server = createServer((request, response) => {
  if (request.url === "/app.js") {
    response.setHeader("content-type", "text/javascript")
    response.end(app.outputFiles[0].contents)
    return
  }
  if (request.url === "/business") {
    businessRequests++
    response.end("ok")
    return
  }
  if (request.url === "/menu-only.svg" || request.url?.startsWith("/scene-")) {
    response.setHeader("content-type", "image/svg+xml")
    const width = request.url?.startsWith("/scene-two")
      ? 9
      : request.url?.startsWith("/scene-three")
        ? 10
        : 8
    response.end(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="8"><rect width="${width}" height="8" fill="red"/></svg>`
    )
    return
  }
  response.setHeader("content-type", "text/html; charset=utf-8")
  response.end(`<!doctype html><html><head><style>.menu{position:absolute;top:50px;left:0;background:white;padding:12px}</style></head><body>
    <style id="body-style">button{cursor:pointer}</style><button id="toggle" aria-expanded="false"><span id="label">A</span></button>
    <p id="unrelated">Editable content</p><iframe id="embedded" srcdoc="<p>Embedded</p>"></iframe><button id="tab">Tab</button><p id="panel">First</p>
    <button id="open-dialog">Open dialog</button><dialog id="dialog"><p>Dialog</p><button id="close-dialog">Close</button></dialog>
    <input type="password" value="do-not-export" style="display:none">
    <input id="native-check" type="checkbox">
    <div role="tablist" aria-label="Scenes">
      <button role="tab" id="scene-one" aria-selected="true" aria-controls="scene-panel"><span>One</span></button>
      <button role="tab" id="scene-two" aria-selected="false" aria-controls="scene-panel"><span>Two</span></button>
      <button role="tab" id="scene-three" aria-selected="false" aria-controls="scene-panel"><span>Three</span></button>
    </div><div role="tabpanel" id="scene-panel"><img id="scene-image" src="/scene-one.svg"><p>Scene one</p></div>
    <div role="tablist" id="layout-tabs"><button role="tab" id="layout-one" aria-selected="true" aria-controls="layout-panel-one">Layout one</button><button role="tab" id="layout-two" aria-selected="false" aria-controls="layout-panel-two">Layout two</button></div>
    <div role="tabpanel" id="layout-panel-one">Layout panel one</div><div role="tabpanel" id="layout-panel-two" hidden>Layout panel two</div>
    <script>
    document.querySelectorAll('[role="tab"]').forEach(tab=>tab.onclick=()=>{
      const group=tab.closest('[role="tablist"]');
      group.querySelectorAll('[role="tab"]').forEach(item=>item.setAttribute('aria-selected',String(item===tab)));
      if(group.id==='layout-tabs') {
        group.querySelectorAll('[role="tab"]').forEach(item=>document.getElementById(item.getAttribute('aria-controls')).hidden=item!==tab);
        return;
      }
      const name=tab.id.slice(6);
      document.getElementById('scene-panel').innerHTML='<img id="scene-image" src="/scene-'+name+'.svg"><p>Scene '+name+'</p>';
    });
    const toggle=document.getElementById('toggle');
    const closeMenu=()=>{document.getElementById('menu')?.remove();toggle.setAttribute('aria-expanded','false')};
    toggle.addEventListener('pointerdown',()=>{
      if(document.getElementById('menu')) {closeMenu();return}
      toggle.setAttribute('aria-expanded','true');
      const menu=document.createElement('div');menu.id='menu';menu.className='menu';
      menu.innerHTML='<img src="/menu-only.svg"><button id="option" role="option">B</button>';
      menu.querySelector('button').addEventListener('click',()=>setTimeout(()=>{document.getElementById('label').textContent='B';closeMenu();fetch('/business')},650));
      document.body.append(menu);
    });
    document.getElementById('tab').onclick=()=>document.getElementById('panel').textContent='Second';
    document.getElementById('open-dialog').onclick=()=>document.getElementById('dialog').showModal();
    document.getElementById('close-dialog').onclick=()=>document.getElementById('dialog').close();
    </script></body></html>`)
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-click-recording-"))
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined
})
try {
  const source = await browser.newPage()
  await source.goto(origin)
  await source.evaluate(async () => {
    const modulePath = "/app.js"
    const m = await import(modulePath)
    ;(window as any).recordingModule = m
    m.controlDesignInteractionRecording("start")
  })
  let count = 0
  for (const selector of [
    "#toggle",
    "#option",
    "#toggle",
    "#toggle",
    "#tab",
    "#open-dialog",
    "#close-dialog"
  ]) {
    await source.click(selector)
    await source.waitForFunction(
      (expected) =>
        (window as any).recordingModule.controlDesignInteractionRecording("status").count ===
        expected,
      ++count
    )
  }
  await source.click("#native-check")
  const snapshot = await source.evaluate(() =>
    (window as any).recordingModule.extractDesignPageSnapshot()
  )
  assert.equal(
    snapshot.warnings
      .find((item: any) => item.code === "recorded_interactions")
      ?.message.includes("7"),
    true
  )
  assert.doesNotMatch(snapshot.html, /do-not-export|closeMenu=|fetch\('/)
  const localized = await localizeCaptureAssets({
    html: snapshot.html,
    pageUrl: origin,
    directory,
    signal: new AbortController().signal,
    fetch
  })
  assert.equal(
    localized.resources.filter((item) => item.source.endsWith("/menu-only.svg")).length,
    1
  )
  const html = installSnapshotRuntime(localized.html)
  await fs.writeFile(path.join(directory, "index.html"), html)
  const data: Record<string, string> = {}
  for (const resource of localized.resources)
    data[path.join(directory, resource.file)] =
      `data:image/svg+xml;base64,${(await fs.readFile(path.join(directory, resource.file))).toString("base64")}`
  const prepared = await source.evaluate(
    async ({ html, file, data }) =>
      (window as any).recordingModule.buildDesignHtmlPreviewDocument({
        html,
        htmlPath: file,
        readDataUrlFile: async (file: string) => data[file] ?? null
      }),
    { html, file: path.join(directory, "index.html"), data }
  )
  const requestsAfterRecording = businessRequests
  for (const content of [html, prepared]) {
    const preview = await browser.newPage()
    const errors: string[] = []
    preview.on("pageerror", (error) => errors.push(error.message))
    if (content === html) await preview.goto(`file://${path.join(directory, "index.html")}`)
    else await preview.setContent(content)
    await preview.route("**/*", (route) => route.abort())
    await preview.evaluate(() => {
      document.getElementById("unrelated")!.textContent = "User edited"
    })
    await preview.evaluate(() => {
      document.getElementById("panel")!.textContent = "First"
    })
    await preview.click("#tab")
    assert.equal(await preview.locator("#panel").textContent(), "Second")
    await preview.click("#toggle")
    await preview.waitForSelector("#menu")
    await preview.click("#native-check")
    assert.equal(await preview.locator("#native-check").isChecked(), false)
    assert.deepEqual(
      await preview
        .locator("#embedded")
        .evaluate((node) => [node.previousElementSibling?.id, node.nextElementSibling?.id]),
      ["unrelated", "tab"]
    )
    await preview.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>("#menu img")
      return image?.complete && image.naturalWidth > 0
    })
    await preview.click("#option")
    assert.equal(await preview.locator("#menu").count(), 0)
    assert.equal(await preview.locator("#label").textContent(), "B")
    await preview.click("#toggle")
    await preview.click("#toggle")
    assert.equal(await preview.locator("#menu").count(), 0)
    await preview.click("#open-dialog")
    assert.equal(await preview.locator("#dialog").evaluate((node) => node.matches(":modal")), true)
    await preview.click("#close-dialog")
    assert.equal(
      await preview.locator("#dialog").evaluate((node) => node.hasAttribute("open")),
      false
    )
    assert.equal(await preview.locator("#unrelated").textContent(), "User edited")
    assert.equal(await preview.locator("#native-check").isChecked(), false)
    assert.deepEqual(errors, [])
    await preview.close()
  }
  assert.equal(businessRequests, requestsAfterRecording)
  await source.evaluate(() =>
    (window as any).recordingModule.controlDesignInteractionRecording("start")
  )
  for (let count = 1; count <= 8; count++) {
    await source.click("#toggle")
    await source.waitForFunction(
      (expected) =>
        (window as any).recordingModule.controlDesignInteractionRecording("status").count ===
        expected,
      count
    )
  }
  const limited = await source.evaluate(() =>
    (window as any).recordingModule.controlDesignInteractionRecording("status")
  )
  assert.equal(limited.recording, false)
  assert.equal(limited.count, 8)
  await source.evaluate(() => {
    const m = (window as any).recordingModule
    m.controlDesignInteractionRecording("start")
    history.pushState({}, "", "/another-page")
  })
  assert.deepEqual(
    await source.evaluate(() =>
      (window as any).recordingModule.controlDesignInteractionRecording("status")
    ),
    { recording: false, count: 0, message: "页面已跳转，请重新录制" }
  )
  await source.evaluate(() =>
    (window as any).recordingModule.controlDesignInteractionRecording("start")
  )
  for (const [index, selector] of ["#layout-two", "#scene-two", "#scene-three"].entries()) {
    await source.click(selector)
    await source.waitForFunction(
      (expected) =>
        (window as any).recordingModule.controlDesignInteractionRecording("status").count ===
        expected,
      index + 1
    )
  }
  const tabs = await source.evaluate(() =>
    (window as any).recordingModule.extractDesignPageSnapshot()
  )
  const tabsDirectory = path.join(directory, "tabs")
  const tabAssets = await localizeCaptureAssets({
    html: tabs.html,
    pageUrl: origin,
    directory: tabsDirectory,
    signal: new AbortController().signal,
    fetch
  })
  const tabHtml = installSnapshotRuntime(tabAssets.html)
  const tabData: Record<string, string> = {}
  for (const resource of tabAssets.resources)
    tabData[path.join(tabsDirectory, resource.file)] =
      `data:image/svg+xml;base64,${(await fs.readFile(path.join(tabsDirectory, resource.file))).toString("base64")}`
  for (const html of [
    tabHtml,
    tabHtml.replace(
      /<script data-design-capture-runtime>[\s\S]*?<\/script>/,
      '<script data-design-capture-runtime>document.body.dataset.legacyPlayback="ran"</script>'
    )
  ]) {
    const prepared = await source.evaluate(
      async ({ html, file, data }) =>
        (window as any).recordingModule.buildDesignHtmlPreviewDocument({
          html,
          htmlPath: file,
          readDataUrlFile: async (file: string) => data[file] ?? null
        }),
      { html, file: path.join(tabsDirectory, "index.html"), data: tabData }
    )
    const preview = await browser.newPage()
    await preview.setContent(prepared)
    await preview.evaluate(() => {
      document.getElementById("unrelated")!.textContent = "Keep this edit"
    })
    for (const name of ["one", "three", "two", "one", "two", "three"]) {
      await preview.locator(`#scene-${name} span`).click()
      assert.equal(await preview.locator(`#scene-${name}`).getAttribute("aria-selected"), "true")
      assert.equal(await preview.locator("#scene-panel p").textContent(), `Scene ${name}`)
      await preview.waitForFunction(
        (width) => {
          const image = document.querySelector<HTMLImageElement>("#scene-image")
          return image?.complete && image.naturalWidth === width
        },
        name === "one" ? 8 : name === "two" ? 9 : 10
      )
      assert.equal(await preview.locator("#unrelated").textContent(), "Keep this edit")
      assert.equal(await preview.locator("#layout-two").getAttribute("aria-selected"), "true")
    }
    for (const name of ["one", "two", "one"]) {
      await preview.locator(`#layout-${name}`).click()
      assert.equal(await preview.locator(`#layout-panel-${name}`).isVisible(), true)
      assert.equal(
        await preview.locator(`#layout-panel-${name === "one" ? "two" : "one"}`).isVisible(),
        false
      )
      assert.equal(await preview.locator("#scene-three").getAttribute("aria-selected"), "true")
    }
    assert.equal(await preview.evaluate(() => document.body.dataset.legacyPlayback), undefined)
    await preview.close()
  }
  console.log(
    "PASS dropdowns, arbitrary Tab round trips, separate panels, old captures, modal, delayed changes, offline assets, unrelated edits, limits and navigation reset"
  )
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(directory, { recursive: true, force: true })
}
