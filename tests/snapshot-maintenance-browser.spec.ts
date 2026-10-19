import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"

const root = resolve(__dirname, "..")
const output = resolve(root, "output/mods-iteration-20261015/snapshot-maintenance-browser")
const checks: string[] = []
const pass = (text: string) => {
  checks.push(text)
  console.log("PASS " + text)
}

async function main() {
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
      import React from "react";
      import {createRoot} from "react-dom/client";
      import {SnapshotMaintenance} from "./src/renderer/src/components/customize/SnapshotMaintenance";
      const host=createRoot(document.getElementById("root"));
      let props={active:true,scopeKey:"a"},hold=false,fail=false,sequence=0;
      const calls=[],waiting=new Map();
      const preview={previewId:"native-preview",groups:[
        {id:"host",published:64,protected:62,candidates:2,blockers:[]},
        {id:"legacy",published:1,protected:1,candidates:0,blockers:[]},
        {id:"composition",published:1,protected:0,candidates:0,blockers:["unknown reader"]},
        {id:"capabilities",published:0,protected:0,candidates:0,blockers:[]}]};
      function reply(kind,value){
        if(fail){fail=false;return Promise.reject(Error("native refusal"))}
        if(!hold)return Promise.resolve(structuredClone(value));
        return new Promise(resolve=>waiting.set(++sequence,{kind,resolve,value}));
      }
      window.api={mods:{
        previewSnapshotMaintenance:()=>{calls.push({kind:"inspect"});return reply("inspect",preview)},
        collectSnapshotGarbage:id=>{calls.push({kind:"collect",id});return reply("collect",
          {removed:1,remaining:65,blockers:["new reference"]})}
      }};
      const render=patch=>{props={...props,...patch};host.render(<SnapshotMaintenance {...props}/>)};
      window.fixture={render,hold:value=>hold=value,fail:()=>fail=true,calls:()=>structuredClone(calls),
        finish:()=>{for(const [id,item]of waiting){waiting.delete(id);item.resolve(structuredClone(item.value))}}};
      render({});
    `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve(root, "src/renderer/src") }
  })
  const cssPath = resolve(root, "src/renderer/src/index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency() {
      /* The fixture emits CSS in memory without writing dependency files. */
    }
  })
  const candidates = new Scanner({}).scanFiles(
    [
      "src/renderer/src/components/customize/SnapshotMaintenance.tsx",
      "src/renderer/src/components/ui/button.tsx"
    ].map((path) => ({ content: readFileSync(resolve(root, path), "utf8"), extension: "tsx" }))
  )
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 1000 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent(`<html><head><style>${compiler.build(candidates)}</style></head>
      <body><div id="root"></div></body></html>`)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const call = (code: string) => page.evaluate(code)
    const settle = () =>
      page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      )
    await page.locator("summary").waitFor()
    await page.locator("summary").click()
    assert.equal((await call("window.fixture.calls()").then((v) => v as unknown[])).length, 0)
    pass("mounting and expanding maintenance performs no reads or collection")
    await page.getByRole("button", { name: "检查可清理版本" }).click()
    await page.getByText("项目流程：64/64").waitFor()
    await page.getByRole("button", { name: "清理 2 个版本…" }).click()
    assert.equal(await page.getByRole("button", { name: "确认清理" }).count(), 1)
    await page.getByRole("button", { name: "取消", exact: true }).click()
    assert.equal(
      ((await call("window.fixture.calls().filter(x=>x.kind==='collect')")) as unknown[]).length,
      0
    )
    pass("native candidate counts are displayed and cancellation never collects")
    await page.getByRole("button", { name: "清理 2 个版本…" }).click()
    await page.getByRole("button", { name: "确认清理" }).click()
    await page.getByRole("status").waitFor()
    assert.match(await page.getByRole("status").innerText(), /已清理 1 个版本，保留 65 个/)
    assert.deepEqual(await call("window.fixture.calls().filter(x=>x.kind==='collect')"), [
      { kind: "collect", id: "native-preview" }
    ])
    assert.equal(await page.getByRole("button", { name: "确认清理" }).count(), 0)
    pass(
      "confirmation submits only the native preview token and reports re-audited partial results"
    )
    await call("window.fixture.hold(true)")
    await page.getByRole("button", { name: "检查可清理版本" }).click()
    await call("window.fixture.render({scopeKey:'b'})")
    await settle()
    await call("window.fixture.finish();window.fixture.hold(false)")
    await settle()
    assert.equal(await page.getByText("项目流程：64/64").count(), 0)
    pass("a delayed preview cannot restore candidates after switching chat scope")
    await page.getByRole("button", { name: "检查可清理版本" }).click()
    await page.getByRole("button", { name: "清理 2 个版本…" }).click()
    await call("window.fixture.hold(true)")
    await page.getByRole("button", { name: "确认清理" }).click()
    await call("window.fixture.render({active:false})")
    await settle()
    await call("window.fixture.finish();window.fixture.hold(false)")
    await settle()
    assert.equal(await page.getByRole("status").count(), 0)
    await call("window.fixture.render({active:true})")
    await settle()
    await call("window.fixture.fail()")
    await page.getByRole("button", { name: "检查可清理版本" }).click()
    await page.getByRole("alert").waitFor()
    assert.match(await page.getByRole("alert").innerText(), /native refusal/)
    await page.getByRole("button", { name: "检查可清理版本" }).click()
    await page.getByText("项目流程：64/64").waitFor()
    assert.equal(await page.getByRole("alert").count(), 0)
    pass("deactivation discards late controls and a fresh inspection recovers from native refusal")
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    await page.screenshot({
      path: resolve(output, "snapshot-maintenance-mobile.png"),
      fullPage: true
    })
    assert.deepEqual(errors, [])
    pass("375px maintenance layout has no horizontal overflow or browser exceptions")
    writeFileSync(resolve(output, "evidence.json"), JSON.stringify({ checks, errors }, null, 2))
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
