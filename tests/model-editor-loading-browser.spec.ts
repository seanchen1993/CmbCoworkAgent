/** Real model editor with deliberately delayed/failed storage reads. */
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main(): Promise<void> {
  const bundle = await build({
    stdin: {
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{CustomModelDialog}from'./src/renderer/src/components/chat/CustomModelDialog';
      window.api={models:{getTokenLimits:window.fixtureLimits,getBuiltinConfigs:async()=>[],getCustomConfigs:async()=>[],getDefault:async()=>''}};
      function Fixture(){const[open,setOpen]=useState(false);return <><button onClick={()=>setOpen(true)}>打开模型设置</button><CustomModelDialog open={open} onOpenChange={setOpen}/></>}
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  let release: (() => void) | undefined
  let fail = false
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.exposeFunction("fixtureLimits", async () => {
      if (fail) throw new Error("fixture: cannot read model configuration")
      await new Promise<void>((done) => {
        release = done
      })
      return {
        defaultMaxTokens: 128000,
        minMaxTokens: 32000,
        maxMaxTokens: 1000000,
        defaultMaxOutputTokens: 8192,
        minMaxOutputTokens: 1,
        maxMaxOutputTokens: 100000,
        defaultTemperature: 0.1,
        maxTemperature: 2,
        defaultTopP: 0.95,
        maxTopP: 1,
        defaultTopK: 40,
        minTopK: 0,
        maxTopK: 1000
      }
    })
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByRole("button", { name: "打开模型设置", exact: true }).click()
    await page.getByRole("dialog").waitFor()
    assert.equal(
      await page.getByPlaceholder("例如：DeepSeek Chat（生产）").isVisible(),
      false,
      "The editor must not accept a draft before its configuration is loaded"
    )
    await page.getByRole("status").getByText("正在读取模型配置…").waitFor()
    assert.ok(release)
    release()
    const name = page.getByPlaceholder("例如：DeepSeek Chat（生产）")
    await name.fill("保留的草稿")
    await page.keyboard.press("Escape")
    await page.getByRole("dialog").waitFor({ state: "hidden" })

    fail = true
    await page.getByRole("button", { name: "打开模型设置", exact: true }).click()
    await page.getByRole("alert").getByText("读取模型配置失败，请重试。").waitFor()
    assert.equal(
      await name.isVisible(),
      false,
      "A failed read must not enable stale configuration edits"
    )
    fail = false
    release = undefined
    await page.getByRole("button", { name: "重试", exact: true }).click()
    await page.getByRole("status").waitFor()
    assert.ok(release)
    release()
    await name.waitFor()
    assert.equal(await name.inputValue(), "")
    await name.fill("重试后可编辑")
    assert.deepEqual(errors, [])
    console.log("PASS model configuration waits for loading and recovers from a failed read")
  } finally {
    release?.()
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
