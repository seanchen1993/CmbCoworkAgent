import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

type BuiltinInstructionsFixtureWindow = Window & {
  show(kind: string): void
  submits(): number
}

async function main() {
  const output = resolve("output/builtin-instructions-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {BuiltinInstructionsView} from './src/renderer/src/components/chat/BuiltinInstructionsView';
      const root=createRoot(document.getElementById('root')); let submits=0;
      const entries=['injected','truncated','omitted','unknown'].map((delivery,i)=>({path:'C:/项目/规范-'+i+'.md',layer:'project',scope:'C:/项目',workspace:'C:/项目',delivery,reason:'原始原因 '+i}));
      window.show=(kind='normal')=>{
        const snapshot={origin:'host',entries,limitations:['技术限制原文'],finalRequests:[]};
        if(kind==='empty')snapshot.entries=[];
        if(kind==='disabled'){snapshot.origin='disabled';snapshot.entries=[];}
        if(kind==='changed')snapshot.finalRequests=[{requestId:'r',observedAt:1,result:'modified',reason:'提示处理改变了内容'}];
        if(kind==='confirmed')snapshot.finalRequests=[{requestId:'r',observedAt:1,result:'confirmed',reason:'发送前原文检查通过'}];
        if(kind==='empty-changed'){snapshot.entries=[];snapshot.finalRequests=[{requestId:'r',observedAt:1,result:'modified',reason:'提示处理改变了内容'}];}
        root.render(<form onSubmit={e=>{e.preventDefault();submits++}}><BuiltinInstructionsView key={kind} open value={{status:kind==='unknown'?'unknown':'observed',message:'记录宿主装配时的规范来源',...(kind==='unknown'?{}:{snapshot})}}/><button type='submit'>测试提交</button></form>);
      };window.submits=()=>submits;window.show();
    `
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    platform: "browser",
    format: "iife",
    define: { "process.env.NODE_ENV": '"test"' }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent(
      "<html><meta charset='utf-8'><body style='padding:12px'><div id='root'></div></body></html>"
    )
    for (const file of readdirSync("out/renderer/assets").filter((name) => name.endsWith(".css")))
      await page.addStyleTag({ path: resolve("out/renderer/assets", file) })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const show = (kind: string) => page.evaluate((kind) => (window as BuiltinInstructionsFixtureWindow).show(kind), kind)
    await page.getByText("本次记录 4 个来源", { exact: true }).waitFor()
    for (const text of [
      "已加入本次上下文",
      "仅加入部分内容",
      "本次未加入",
      "加载情况待核对",
      "内容冲突需人工核对。",
      "发送情况待核对。"
    ])
      assert(await page.getByText(text, { exact: true }).isVisible())
    assert.equal(await page.getByText("记录宿主装配时的规范来源", { exact: true }).count(), 0)
    assert.equal(await page.getByText("原始原因 0", { exact: true }).isVisible(), false)
    const help = page.getByRole("button", { name: "如何理解规范记录", exact: true })
    await help.hover()
    await page.getByRole("dialog", { name: "如何理解规范记录" }).waitFor()
    await page.getByText("记录详情", { exact: true }).click()
    assert(await page.getByText("记录宿主装配时的规范来源", { exact: true }).isVisible())
    await page.keyboard.press("Escape")
    await page.getByRole("dialog", { name: "如何理解规范记录" }).waitFor({ state: "hidden" })
    await page.mouse.move(370, 800)
    await help.focus()
    await page.keyboard.press("Enter")
    await page.getByRole("dialog", { name: "如何理解规范记录" }).waitFor()
    await page.keyboard.press("Escape")
    assert.equal(await page.evaluate(() => (window as BuiltinInstructionsFixtureWindow).submits()), 0)
    await help.click()
    await page.getByRole("dialog", { name: "如何理解规范记录" }).waitFor()
    await page.keyboard.press("Escape")
    await page.getByText("来源详情", { exact: true }).first().click()
    await page.getByText("原始原因 0", { exact: true }).waitFor()
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: join(output, "sources-375.png"), fullPage: true })
    await show("changed")
    await page.getByText("发送内容有变化，需核对。", { exact: true }).waitFor()
    assert.equal(await page.getByText("提示处理改变了内容", { exact: true }).isVisible(), false)
    await page.getByText("查看发送前检查记录", { exact: true }).click()
    await page.getByText(/提示处理改变了内容/).waitFor()
    await show("confirmed")
    await page.getByText("已记录发送前检查。", { exact: true }).waitFor()
    assert.equal(await page.getByText(/模型已执行|模型已遵守/).count(), 0)
    for (const kind of ["empty", "unknown"]) {
      await show(kind)
      await page.getByText("尚未记录规范来源", { exact: true }).waitFor()
      assert.equal(await page.getByText("已加入本次上下文", { exact: true }).count(), 0)
    }
    await page.screenshot({ path: join(output, "empty-375.png"), fullPage: true })
    await show("disabled")
    await page.getByText("本次未开启规范加载", { exact: true }).waitFor()
    await show("empty-changed")
    await page.getByText("发送内容有变化，需核对。", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify(
        {
          errors,
          checks: [
            "four actual delivery states",
            "help hover click keyboard Escape no form submit",
            "empty and disabled truthful",
            "modified evidence remains visible",
            "confirmed does not claim compliance",
            "375px no overflow"
          ]
        },
        null,
        2
      )
    )
    console.log(`PASS builtin instructions: ${output}`)
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
