import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"

async function main() {
  const renderer = resolve("src/renderer/src")
  const output = resolve("output/model-input-budget-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const script = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {CustomModelDialog} from './src/renderer/src/components/chat/CustomModelDialog';
      const item={id:'fixture',name:'Budget fixture',model:'fixture',baseUrl:'https://example.invalid',
        hasApiKey:true,maxTokens:128000,maxOutputTokens:81920,temperature:0.1,topP:0.95,topK:40};
      window.saved=[];window.modelListeners=new Set();window.api={models:{
        onChanged:listener=>{window.modelListeners.add(listener);return()=>window.modelListeners.delete(listener)},
        getBuiltinConfigs:async()=>[],getCustomConfigs:async()=>[item],getDefault:async()=>'custom:fixture',
        getTokenLimits:async()=>({defaultMaxTokens:128000,minMaxTokens:32000,maxMaxTokens:1000000,
          defaultMaxOutputTokens:8192,minMaxOutputTokens:1,maxMaxOutputTokens:100000,
          defaultTemperature:0.1,maxTemperature:2,defaultTopP:0.95,maxTopP:1,
          defaultTopK:40,minTopK:0,maxTopK:1000}),
        upsertCustomConfig:async value=>{window.saved.push(value);Object.assign(item,value);return {id:'fixture'}},
        setDefault:async()=>{}
      }};
      const root=createRoot(document.getElementById('root'));
      window.closeModelFixture=()=>root.unmount();
      root.render(<CustomModelDialog open
        selectedModelId='custom:fixture' onOpenChange={()=>{}}/>);
    `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const cssPath = resolve(renderer, "index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency: () => undefined
  })
  const candidates = new Scanner({}).scanFiles([
    {
      content: readFileSync(resolve(renderer, "components/chat/CustomModelDialog.tsx"), "utf8"),
      extension: "tsx"
    },
    {
      content: readFileSync(resolve(renderer, "components/ui/dialog.tsx"), "utf8"),
      extension: "tsx"
    }
  ])
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent("<div id='root'></div>")
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.addScriptTag({ content: script.outputFiles[0].text })
    const budget = page.getByRole("status").filter({ hasText: "配置的上下文窗口" })
    await budget.waitFor()
    assert.match(await budget.innerText(), /128,000.*81,920.*1,000.*45,080/)
    assert.match(await budget.innerText(), /预留超过配置窗口的一半/)
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction(() => (window as unknown as { saved: unknown[] }).saved.length === 1)
    const saved = await page.evaluate(
      () => (window as unknown as { saved: Record<string, unknown>[] }).saved[0]
    )
    assert.equal(saved.maxTokens, 128000)
    assert.equal(saved.maxOutputTokens, 81920)
    const outputInput = page.locator('input[type="number"]').filter({ visible: true }).nth(1)
    await outputInput.fill("8192")
    await page.waitForFunction(() => document.body.textContent?.includes("118,808"))
    assert.doesNotMatch(await budget.innerText(), /预留超过配置窗口的一半/)
    assert.equal(
      await page.evaluate(() => (window as unknown as { saved: unknown[] }).saved.length),
      1
    )
    await budget.screenshot({ path: resolve(output, "budget-explanation.png") })
    assert.equal(await page.evaluate("window.modelListeners.size"), 1)
    await page.evaluate("window.closeModelFixture()")
    assert.equal(await page.evaluate("window.modelListeners.size"), 0)
    assert.deepEqual(errors, [])
    console.log("PASS model input budget explanation and unchanged explicit output", output)
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
