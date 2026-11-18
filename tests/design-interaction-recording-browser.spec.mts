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
  if (request.url === "/events") {
    response.setHeader("content-type", "text/html; charset=utf-8")
    response.end(`<!doctype html><html><body>
      <label for="check">Check</label><input id="check" type="checkbox"><p id="check-result" hidden>Checked</p>
      <input id="radio-a" type="radio" name="radio" value="a" checked><input id="radio-b" type="radio" name="radio" value="b"><p id="radio-result">a</p>
      <select id="select" size="2"><option value="a" selected>A</option><option value="b">B</option></select><p id="select-result">a</p>
      <textarea id="text"></textarea><p id="text-result"></p>
      <input id="text-input"><p id="input-result"></p>
      <div id="hover" style="padding:12px;width:100px">Hover<span> nested</span></div><p id="tooltip" hidden>Tooltip</p>
      <div id="double">Double click</div><p id="double-result">initial</p>
      <div id="context">Right click</div><p id="context-menu" hidden>Context menu</p>
      <div id="keyboard" tabindex="0">Keyboard</div><p id="key-result">initial</p>
      <button id="escape-open">Open</button><dialog id="escape-dialog">Escape closes this</dialog>
      <button id="late">Late response</button><p id="late-result">initial</p>
      <input id="tab-a"><input id="tab-b"><p id="blur-result" hidden>Validated on blur</p><p id="focus-result" hidden>Focused</p>
      <script>
        document.getElementById('check').onchange=e=>document.getElementById('check-result').hidden=!e.target.checked;
        document.querySelectorAll('input[name="radio"]').forEach(r=>r.onchange=e=>document.getElementById('radio-result').textContent=e.target.value);
        document.getElementById('select').onchange=e=>document.getElementById('select-result').textContent=e.target.value;
        document.getElementById('text').oninput=e=>document.getElementById('text-result').textContent=e.target.value;
        document.getElementById('text-input').oninput=e=>document.getElementById('input-result').textContent=e.target.value;
        document.getElementById('hover').onmouseenter=()=>document.getElementById('tooltip').hidden=false;
        document.getElementById('hover').onmouseleave=()=>document.getElementById('tooltip').hidden=true;
        document.getElementById('double').ondblclick=()=>document.getElementById('double-result').textContent='double';
        document.getElementById('context').oncontextmenu=e=>{e.preventDefault();const menu=document.getElementById('context-menu');menu.hidden=!menu.hidden};
        document.getElementById('keyboard').onkeydown=e=>{if(e.key==='ArrowRight')document.getElementById('key-result').textContent='next';if(e.key==='n')document.getElementById('key-result').textContent='letter'};
        document.getElementById('escape-open').onclick=()=>document.getElementById('escape-dialog').showModal();
        document.getElementById('late').onclick=()=>{document.getElementById('late-result').textContent='loading';setTimeout(()=>document.getElementById('late-result').textContent='complete',650)};
        document.getElementById('tab-a').onblur=()=>document.getElementById('blur-result').hidden=false;
        document.getElementById('tab-b').onfocus=()=>document.getElementById('focus-result').hidden=false;
      </script></body></html>`)
    return
  }
  if (request.url === "/compat") {
    response.setHeader("content-type", "text/html; charset=utf-8")
    response.end(`<!doctype html><html><head><style>
      @keyframes enter { from { opacity:0 } to { opacity:1 } }
      dialog[open] { animation:enter 200ms both }
    </style></head><body>
      <style id="menu-style"></style><input id="combo" type="text" value="Choose"><p id="choice">None</p>
      <button id="modal-open">Open</button><dialog id="modal"><p>Animated modal</p><button id="modal-close">Close</button></dialog>
      <script>
        document.getElementById('combo').onmousedown=()=>{
          if(document.getElementById('compat-menu'))return;
          const style=document.getElementById('menu-style');
          style.sheet.insertRule('#compat-menu{position:fixed;top:50px;left:0;background:rgb(12,34,56);padding:16px}');
          const menu=document.createElement('div');menu.id='compat-menu';menu.innerHTML='<button id="compat-option">Selected</button>';
          menu.onclick=()=>{document.getElementById('choice').textContent='Selected';menu.remove();style.sheet.deleteRule(0)};
          document.body.append(menu);
        };
        document.getElementById('modal-open').onclick=()=>document.getElementById('modal').showModal();
        document.getElementById('modal-close').onclick=()=>document.getElementById('modal').close();
      </script></body></html>`)
    return
  }
  if (request.url === "/hover-noise") {
    response.setHeader("content-type", "text/html; charset=utf-8")
    response.end(`<!doctype html><html><head><style>
      #open{position:absolute;left:30px;top:30px;width:180px;height:50px}
      dialog{width:400px;height:240px}
      #cancel{position:absolute;left:140px;top:150px;width:120px;height:40px}
      [data-hover]{background-color:rgb(220,230,240)}
      #hint{position:absolute;left:500px;top:30px}
      #hint-popup{position:absolute;left:500px;top:90px;display:none}
      #hint-popup.shown{display:block}
    </style></head><body>
      <button id="open">Open modal</button><b id="action-count">0</b><p id="untouched">Editable</p>
      <dialog id="modal"><p>Settings</p><button id="cancel">Cancel</button></dialog>
      <button id="hint">Hint</button><p id="hint-popup" class="tooltip">Helpful content</p>
      <div data-sites-widget="editor-composer" popover="manual"></div>
      <div id="business-popover" popover="manual">Business popover</div>
      <script>
        const editor=document.querySelector('[data-sites-widget]');
        editor.attachShadow({mode:'open'}).innerHTML='<style>:host{border:0;padding:0;background:transparent;position:fixed;inset:auto 0 0 auto}</style><button>Edit website</button>';
        editor.showPopover();
        let actions=0;
        document.getElementById('open').onclick=()=>{document.getElementById('modal').showModal();document.body.style.overflow='hidden';document.getElementById('action-count').textContent=++actions};
        document.getElementById('cancel').onclick=()=>{document.getElementById('modal').close();document.getElementById('action-count').textContent=++actions};
        document.getElementById('modal').onclose=()=>{document.body.style.overflow=''};
        for(const element of document.querySelectorAll('#open,#cancel,dialog')) {
          element.onpointerenter=()=>element.setAttribute('data-hover','true');
          element.onpointerleave=()=>element.removeAttribute('data-hover');
        }
        document.getElementById('hint').onpointerenter=()=>document.getElementById('hint-popup').classList.add('shown');
        document.getElementById('hint').onpointerleave=()=>document.getElementById('hint-popup').classList.remove('shown');
      </script></body></html>`)
    return
  }
  if (request.url === "/filter-tabs") {
    response.setHeader("content-type", "text/html; charset=utf-8")
    response.end(`<!doctype html><html><body><section>
      <div role="tablist"><button id="filter-one" role="tab" class="active" aria-selected="true">One</button><button id="filter-two" role="tab" class="" aria-selected="false">Two</button></div>
      <article id="filter-panel-one"><p id="filter-copy">Editable panel</p></article><article id="filter-panel-two" hidden>Second panel</article>
      </section><b id="filter-log">0</b><script>
      let count=0;for(const [index,button]of [...document.querySelectorAll('[role="tab"]')].entries())button.onclick=()=>{
        for(const [i,tab]of [...document.querySelectorAll('[role="tab"]')].entries()){tab.classList.toggle('active',i===index);tab.setAttribute('aria-selected',String(i===index));document.getElementById(i?'filter-panel-two':'filter-panel-one').hidden=i!==index}
        document.getElementById('filter-log').textContent=++count;
      };</script></body></html>`)
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
  await source.goto(origin + "/compat")
  await source.evaluate(async () => {
    const modulePath = "/app.js"
    const m = await import(modulePath)
    ;(window as any).recordingModule = m
    m.controlDesignInteractionRecording("start")
  })
  for (const [index, selector] of ["#combo", "#compat-option", "#modal-open", "#modal-close"].entries()) {
    await source.click(selector)
    await source.waitForTimeout(450)
    assert.equal(await source.evaluate(() =>
      (window as any).recordingModule.controlDesignInteractionRecording("status").count
    ), index + 1, `must record ${selector}`)
  }
  const compat = await source.evaluate(() =>
    (window as any).recordingModule.extractDesignPageSnapshot()
  )
  const compatHtml = installSnapshotRuntime(compat.html)
  const compatPreview = await browser.newPage()
  await compatPreview.setContent(compatHtml)
  await compatPreview.click("#combo")
  assert.equal(await compatPreview.locator("#compat-menu").isVisible(), true)
  assert.equal(await compatPreview.locator("#compat-menu").evaluate(node => getComputedStyle(node).backgroundColor), "rgb(12, 34, 56)")
  await compatPreview.click("#compat-option")
  assert.equal(await compatPreview.locator("#choice").textContent(), "Selected")
  assert.equal(await compatPreview.locator("#compat-menu").count(), 0)
  await compatPreview.click("#modal-open")
  await compatPreview.waitForTimeout(250)
  assert.equal(await compatPreview.locator("#modal").evaluate(node => getComputedStyle(node).opacity), "1")
  await compatPreview.click("#modal-close")
  assert.equal(await compatPreview.locator("#modal").isVisible(), false)
  await compatPreview.close()
  await source.goto(origin + "/hover-noise")
  await source.evaluate(async () => {
    const modulePath = "/app.js"
    const m = await import(modulePath)
    ;(window as any).recordingModule = m
    m.controlDesignInteractionRecording("start")
  })
  for (const [index, selector] of ["#open", "#cancel"].entries()) {
    await source.click(selector)
    await source.waitForTimeout(400)
    const status = await source.evaluate(() =>
      (window as any).recordingModule.controlDesignInteractionRecording("status")
    )
    assert.equal(status.count, index + 1, "hover attributes and colors must not inflate click counts")
    assert.equal(status.recording, true)
  }
  await source.hover("#open")
  await source.waitForTimeout(400)
  assert.equal(await source.evaluate(() =>
    (window as any).recordingModule.controlDesignInteractionRecording("status").count
  ), 2, "moving back to the page must not consume another recording slot")
  const noiseSnapshot = await source.evaluate(() =>
    (window as any).recordingModule.extractDesignPageSnapshot()
  )
  assert.doesNotMatch(noiseSnapshot.html, /data-sites-widget|Edit website/,
    "site authoring overlays must not be captured or serialized in recorded states")
  assert.equal(noiseSnapshot.warnings.some((warning: any) => warning.code === "shadow_dom"), false,
    "excluded authoring widgets must not be flattened as business shadow components")
  const noisePreview = await browser.newPage()
  await noisePreview.setContent(installSnapshotRuntime(noiseSnapshot.html))
  await noisePreview.locator("#untouched").evaluate(node => node.textContent = "User edited")
  for (let round = 0; round < 2; round++) {
    await noisePreview.click("#open")
    assert.equal(await noisePreview.locator("#modal").isVisible(), true)
    await noisePreview.click("#cancel")
    assert.equal(await noisePreview.locator("#modal").isVisible(), false)
    assert.equal(await noisePreview.locator("#modal").evaluate(node => node.matches(":modal")), false,
      "closing must release the native top layer so the page remains clickable")
    assert.equal(await noisePreview.evaluate(() => document.body.style.overflow), "",
      "the delayed native close handler must remain part of the recorded click")
    assert.equal(await noisePreview.locator("#untouched").textContent(), "User edited")
  }
  await noisePreview.close()
  const legacyWidgetPreview = await browser.newPage()
  const legacyWidgetHtml = noiseSnapshot.html.replace("</body>",
    '<div data-sites-widget="editor-composer" popover="manual" data-design-capture-popover>Old editor overlay</div><div id="saved-business-popover" popover="manual" data-design-capture-popover>Business overlay</div></body>')
  await legacyWidgetPreview.setContent(installSnapshotRuntime(legacyWidgetHtml))
  assert.equal(await legacyWidgetPreview.locator("[data-sites-widget]").count(), 0,
    "old captures must also discard the authoring popover instead of displaying a black border")
  assert.equal(await legacyWidgetPreview.locator("#saved-business-popover").evaluate(node => node.matches(":popover-open")), true,
    "actual business popovers must still be restored")
  await legacyWidgetPreview.close()
  await source.evaluate(() =>
    (window as any).recordingModule.controlDesignInteractionRecording("start")
  )
  await source.hover("#hint")
  await source.waitForTimeout(400)
  await source.mouse.move(900, 700)
  await source.waitForTimeout(400)
  assert.equal(await source.evaluate(() =>
    (window as any).recordingModule.controlDesignInteractionRecording("status").count
  ), 2, "class-driven tooltip visibility changes must still be recorded")
  const hintSnapshot = await source.evaluate(() =>
    (window as any).recordingModule.extractDesignPageSnapshot()
  )
  const hintPreview = await browser.newPage()
  await hintPreview.setContent(installSnapshotRuntime(hintSnapshot.html))
  await hintPreview.hover("#hint")
  assert.equal(await hintPreview.locator("#hint-popup").isVisible(), true)
  await hintPreview.mouse.move(900, 700)
  assert.equal(await hintPreview.locator("#hint-popup").isVisible(), false)
  await hintPreview.close()
  await source.goto(origin + "/filter-tabs")
  await source.evaluate(async () => {
    const modulePath = "/app.js"
    const m = await import(modulePath)
    ;(window as any).recordingModule = m
    m.controlDesignInteractionRecording("start")
  })
  for (const selector of ["#filter-two", "#filter-one"]) {
    await source.click(selector)
    await source.waitForTimeout(400)
  }
  const filterSnapshot = await source.evaluate(() =>
    (window as any).recordingModule.extractDesignPageSnapshot()
  )
  const filterPreview = await browser.newPage()
  await filterPreview.setContent(installSnapshotRuntime(filterSnapshot.html))
  await filterPreview.locator("#filter-copy").evaluate(node => node.textContent = "User edited panel")
  for (const name of ["two", "one", "two"]) {
    await filterPreview.click(`#filter-${name}`)
    assert.equal(await filterPreview.locator(`#filter-panel-${name}`).isVisible(), true)
    assert.equal(await filterPreview.locator(`#filter-panel-${name === "one" ? "two" : "one"}`).isVisible(), false)
    assert.equal(await filterPreview.locator("#filter-copy").textContent(), "User edited panel")
  }
  await filterPreview.close()
  const startEvents = async () => {
    await source.goto(origin + "/events")
    await source.evaluate(async () => {
      const modulePath = "/app.js"
      const m = await import(modulePath)
      ;(window as any).recordingModule = m
      m.controlDesignInteractionRecording("start")
    })
  }
  const eventsPreview = async () => {
    const snapshot = await source.evaluate(() =>
      (window as any).recordingModule.extractDesignPageSnapshot()
    )
    const preview = await browser.newPage()
    await preview.setContent(installSnapshotRuntime(snapshot.html))
    return preview
  }
  const settled = () => source.waitForTimeout(400)
  await startEvents()
  for (const selector of ['label[for="check"]', "#check", "#radio-b", "#radio-a"]) {
    await source.click(selector)
    await settled()
  }
  assert.equal(await source.evaluate(() =>
    (window as any).recordingModule.controlDesignInteractionRecording("status").count
  ), 4, "checkbox/radio changes must be recorded")
  const nativePreview = await eventsPreview()
  for (let round = 0; round < 2; round++) {
    await nativePreview.click('label[for="check"]')
    assert.equal(await nativePreview.locator("#check-result").isVisible(), true)
    await nativePreview.click("#check")
    assert.equal(await nativePreview.locator("#check-result").isVisible(), false)
    for (const name of ["b", "a"]) {
      await nativePreview.click(`#radio-${name}`)
      assert.equal(await nativePreview.locator("#radio-result").textContent(), name)
      assert.equal(await nativePreview.locator(`#radio-${name}`).isChecked(), true)
    }
  }
  await nativePreview.close()

  await startEvents()
  await source.locator("#select").focus()
  await source.locator("#select").press("ArrowDown")
  await settled()
  assert.equal(await source.locator("#select").inputValue(), "b", "source keyboard selection")
  await source.locator("#select").press("ArrowUp")
  await settled()
  await source.locator("#text").pressSequentially("x")
  await settled()
  await source.locator("#text").press("Backspace")
  await settled()
  await source.locator("#text-input").pressSequentially("x")
  await settled()
  await source.locator("#text-input").press("Backspace")
  await settled()
  const formPreview = await eventsPreview()
  for (let round = 0; round < 2; round++) {
    await formPreview.selectOption("#select", "b")
    assert.equal(await formPreview.locator("#select-result").textContent(), "b", "preview selection result")
    await formPreview.selectOption("#select", "a")
    assert.equal(await formPreview.locator("#select-result").textContent(), "a")
    await formPreview.locator("#text").pressSequentially("x")
    assert.equal(await formPreview.locator("#text-result").textContent(), "x")
    await formPreview.locator("#text").press("Backspace")
    assert.equal(await formPreview.locator("#text-result").textContent(), "")
    await formPreview.locator("#text-input").pressSequentially("x")
    assert.equal(await formPreview.locator("#input-result").textContent(), "x")
    await formPreview.locator("#text-input").press("Backspace")
    assert.equal(await formPreview.locator("#input-result").textContent(), "")
  }
  await formPreview.close()

  await startEvents()
  await source.hover("#hover")
  await settled()
  await source.hover("#double")
  await settled()
  await source.dblclick("#double")
  await settled()
  await source.click("#context", { button: "right" })
  await settled()
  await source.click("#context", { button: "right" })
  await settled()
  await source.locator("#keyboard").press("ArrowRight")
  await settled()
  await source.locator("#keyboard").press("n")
  await settled()
  const events = await eventsPreview()
  await events.evaluate(() => {
    document.getElementById("double-result")!.textContent = "initial"
    document.getElementById("key-result")!.textContent = "initial"
  })
  await events.hover("#hover span")
  assert.equal(await events.locator("#tooltip").isVisible(), true)
  await events.hover("#double")
  assert.equal(await events.locator("#tooltip").isVisible(), false)
  await events.click("#double")
  assert.equal(await events.locator("#double-result").textContent(), "initial", "single click must not replay double click")
  await events.dblclick("#double")
  assert.equal(await events.locator("#double-result").textContent(), "double")
  await events.click("#context", { button: "right" })
  assert.equal(await events.locator("#context-menu").isVisible(), true)
  await events.click("#context", { button: "right" })
  assert.equal(await events.locator("#context-menu").isVisible(), false)
  await events.locator("#keyboard").press("ArrowRight")
  assert.equal(await events.locator("#key-result").textContent(), "next")
  await events.locator("#keyboard").press("n")
  assert.equal(await events.locator("#key-result").textContent(), "letter")
  await events.close()

  await startEvents()
  await source.click("#escape-open")
  await settled()
  await source.keyboard.press("Escape")
  await settled()
  const escapePreview = await eventsPreview()
  await escapePreview.click("#escape-open")
  assert.equal(await escapePreview.locator("#escape-dialog").isVisible(), true)
  await escapePreview.keyboard.press("Escape")
  assert.equal(await escapePreview.locator("#escape-dialog").isVisible(), false)
  await escapePreview.close()
  await startEvents()
  await source.locator("#tab-a").focus()
  await source.keyboard.press("Tab")
  await settled()
  const focusPreview = await eventsPreview()
  await focusPreview.evaluate(() => {
    document.getElementById("blur-result")!.hidden = true
    document.getElementById("focus-result")!.hidden = true
    document.getElementById("tab-a")!.focus()
  })
  await focusPreview.keyboard.press("Tab")
  assert.equal(await focusPreview.locator("#blur-result").isVisible(), true)
  assert.equal(await focusPreview.locator("#focus-result").isVisible(), true)
  assert.equal(await focusPreview.evaluate(() => document.activeElement?.id), "tab-b")
  await focusPreview.close()
  await startEvents()
  for (let index = 0; index < 49; index++) {
    await source.click("#check")
    await settled()
  }
  await source.click("#late")
  await source.waitForTimeout(1050)
  const lastPreview = await eventsPreview()
  await lastPreview.locator("#late-result").evaluate(node => node.textContent = "initial")
  await lastPreview.click("#late")
  assert.equal(await lastPreview.locator("#late-result").textContent(), "complete", "the fiftieth action must retain its delayed result")
  await lastPreview.close()
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
      ?.message.includes("8"),
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
  const windowsPrepared = await source.evaluate(
    async ({ html, data }) =>
      (window as any).recordingModule.buildDesignHtmlPreviewDocument({
        html,
        htmlPath: "C:\\设计 空间\\capture\\index.html",
        readDataUrlFile: async (file: string) => data[file] ?? null
      }),
    { html, data: Object.fromEntries(localized.resources.map(resource => [
      `C:/设计 空间/capture/${resource.file.replace(/\\/g, "/")}`,
      data[path.join(directory, resource.file)]
    ])) }
  )
  const requestsAfterRecording = businessRequests
  for (const content of [html, prepared, windowsPrepared]) {
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
  for (let count = 1; count <= 50; count++) {
    await source.click("#toggle")
    await source.waitForFunction(
      (expected) =>
        (window as any).recordingModule.controlDesignInteractionRecording("status").count ===
        expected,
      count
    )
    if (count === 8 || count === 49) {
      assert.equal(await source.evaluate(() =>
        (window as any).recordingModule.controlDesignInteractionRecording("status").recording
      ), true, "recording must continue before the fiftieth action")
    }
  }
  const limited = await source.evaluate(() =>
    (window as any).recordingModule.controlDesignInteractionRecording("status")
  )
  assert.equal(limited.recording, false)
  assert.equal(limited.count, 50)
  assert.equal(limited.message, "已记录 50 次页面变化，请抓取或重新录制")
  await source.click("#toggle")
  assert.equal(await source.evaluate(() =>
    (window as any).recordingModule.controlDesignInteractionRecording("status").count
  ), 50, "the fifty-first action must not be recorded")
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
    "PASS native forms, input/reset, keyboard/Escape, hover, double/right click, delayed fiftieth action, input dropdowns, CSSOM, animated modals, Windows paths, Tab round trips, old captures, offline assets, unrelated edits, 50-action limit and navigation reset"
  )
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(directory, { recursive: true, force: true })
}
