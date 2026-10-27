/** Real memory controls with synthetic transport; never uses the user's Bots or model. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { build } from "esbuild"
import { chromium } from "playwright"
import type { BotDefinition, UpdateBotInput } from "../src/shared/bots/contracts"

type FixtureWindow = Window & {
  fixture: { bots: BotDefinition[]; updates: UpdateBotInput[]; fail: boolean }
}

async function main() {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {BotMemoryPanel} from "./src/renderer/src/components/bots/BotMemoryPanel";
const base={hostId:"local",threadId:"thread",name:"Synthetic Bot",instructions:"Synthetic role",modelRef:null,color:"#123456",archived:false,version:1,createdAt:1,updatedAt:1};
const f=window.fixture={bots:[{...base,id:"a"},{...base,id:"b",memoryMode:"disabled"}],updates:[],fail:false};
function App(){
  const [selected,select]=useState(0),[bots,setBots]=useState(f.bots);
  const [client]=useState(()=>({
    hostId:"local",
    listMemory:async id=>[{id:"fact",name:"Saved preference "+id,content:"Durable content "+id,version:"v1"}],
    subscribe:()=>()=>{},
    update:async input=>{
      f.updates.push(input);
      if(f.fail) {f.fail=false;throw new Error("请先停止当前任务，再修改 Bot")}
      const bot=f.bots.find(bot=>bot.id===input.id);
      if(bot.version!==input.expectedVersion) throw new Error("Bot 已被修改，请刷新后重试");
      const saved={...bot,...input,version:bot.version+1};
      f.bots=f.bots.map(bot=>bot.id===input.id?saved:bot);
      setBots(f.bots);
      return saved;
    }
  }));
  return <><button onClick={()=>select(selected===0?1:0)}>切换测试 Bot</button>
    <BotMemoryPanel key={bots[selected].id} bot={bots[selected]} client={client} peers={bots}/>
  </>;
}
createRoot(document.getElementById("root")).render(<App/>);
`
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": process.cwd() + "/src/renderer/src" },
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const browser = await chromium.launch({
    ...(!existsSync(chromium.executablePath()) ? { channel: "chrome" } : {}),
    headless: true
  })
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 760 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: result.outputFiles[0].text })
    const setting = page.getByRole("combobox", { name: "记忆配置", exact: true })
    await setting.waitFor()
    assert.equal(await setting.textContent(), "跟随全局")
    const change = async (label: string) => {
      await setting.click()
      await page.getByRole("option", { name: label, exact: true }).click()
    }
    await change("开启")
    await page.waitForFunction(
      () => (window as FixtureWindow).fixture.bots[0].memoryMode === "enabled"
    )
    assert.equal(await setting.textContent(), "开启")
    const saved = await page.evaluate(() => (window as FixtureWindow).fixture.updates[0])
    assert.equal(saved.id, "a")
    assert.equal(saved.expectedVersion, 1)
    assert.equal(saved.instructions, "Synthetic role")

    await page.getByRole("button", { name: "切换测试 Bot" }).click()
    await page.getByText("Saved preference b", { exact: true }).waitFor()
    assert.equal(await setting.textContent(), "关闭")
    await page.getByRole("button", { name: "编辑 Saved preference b" }).click()
    assert.equal(await page.locator("textarea").inputValue(), "Durable content b")
    await page.getByRole("button", { name: "取消", exact: true }).click()
    await page.getByRole("button", { name: "切换测试 Bot" }).click()
    await page.getByText("Saved preference a", { exact: true }).waitFor()
    assert.equal(await setting.textContent(), "开启")

    await page.evaluate(() => {
      ;(window as FixtureWindow).fixture.fail = true
    })
    await change("关闭")
    await page.getByRole("alert").filter({ hasText: "请先停止当前任务" }).waitFor()
    assert.equal(await setting.textContent(), "开启")
    await change("关闭")
    await page.waitForFunction(
      () => (window as FixtureWindow).fixture.bots[0].memoryMode === "disabled"
    )
    assert.equal(await setting.textContent(), "关闭")
    assert.equal(await page.getByText("Saved preference a", { exact: true }).count(), 1)
    await change("跟随全局")
    await page.waitForFunction(
      () => (window as FixtureWindow).fixture.bots[0].memoryMode === "inherit"
    )
    assert.equal(await setting.textContent(), "跟随全局")
    assert.deepEqual(errors, [])
    console.log(
      "Bot memory settings: override, persistence, isolation, retained entries and failed save passed"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
