import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { chromium, type Page } from "playwright"
import { expect, it } from "vitest"

type FixtureControl = {
  calls: unknown[]
  mode: string
  readDelay?: number
  mount(): void
  cards(): void
  close(): void
  version(version: number): void
  epoch(epoch: string): void
  host(id: string): void
  corrupt(): void
  report(status: "satisfied" | "missing" | "unverified", expired?: boolean, weak?: boolean): void
}
const fixture = (page: Page) =>
  page.evaluate(() => (window as unknown as { fixture: FixtureControl }).fixture.calls)
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-skill-dependency-ui-"))
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  try {
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: "tsx",
        contents: `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BotSkillDependencyCheck} from './src/renderer/src/components/bots/BotSkillDependencyCheck';
import {BotSkillCard} from './src/renderer/src/components/bots/BotSkillCard';
import {useBotWorkspaceStore} from './src/renderer/src/lib/bot-workspace-store';
let update;
const base={botId:'bot',id:'skill',version:1,name:'依赖检查',instructions:'Steps',enabled:true,verified:false,createdAt:0,scope:'bot'};
const declaration={source:'cmbdevclaw',state:'structured',checks:[{id:'node',kind:'executable',name:'node',minimumVersion:'22.16.0'}]};
const state=window.fixture={calls:[],mode:'normal',cards(){state.calls=[];state.readDelay=25;update(value=>({...value,cards:true}))},mount(){update(value=>({...value,open:true,key:value.key+1}))},close(){update(value=>({...value,open:false}))},version(version){update(value=>({...value,version}))},epoch(epoch){useBotWorkspaceStore.setState({snapshot:{...useBotWorkspaceStore.getState().snapshot,dataEpoch:epoch}})},host(hostId){useBotWorkspaceStore.setState({host:{...useBotWorkspaceStore.getState().host,hostId}})},corrupt(){localStorage.setItem('bot-skill-dependency-pending:bot:skill','broken')},report(status,expired=false,weak=false){state.history=[{receipt:{runId:'report',messageId:'message',skill:{...origin()}},status:'succeeded',createdAt:Date.now(),current:!expired,reason:expired?'expired':undefined,report:{format:1,skill:origin(),environment:{target:{id:'a'.repeat(64),label:'当前电脑',platform:'darwin'},dataEpoch:'epoch',authoritySha256:'b'.repeat(64),workspaceSha256:'c'.repeat(64),policyRevision:0,commandRulesRevision:0,reviewRevision:0,botRevision:1,buildId:'fixture'},runId:'report',checkedAt:Date.now(),expiresAt:Date.now()+600000,status,checks:[{id:'node',status,reason:status==='satisfied'?'observed':status==='missing'?'not_found':weak?'command_exit_unconfirmed':'unsupported',...((status==='satisfied'||weak)?{observedVersion:'22.23.3'}:{})}]}}];state.host('host-'+Date.now())}};
function origin(version=1){return {botId:'bot',id:'skill',version,name:base.name,scope:'bot',sha256:'d'.repeat(64)}}
window.api={bots:{async skillDependencies(selection){state.calls.push({kind:'read',...selection});if(state.readDelay)await new Promise(resolve=>setTimeout(resolve,state.readDelay));if(state.mode==='refresh-fails')throw new Error('读取暂不可用');return {skill:origin(selection.version),declaration,history:state.history??[]}},async checkSkillDependencies(input){state.calls.push({kind:'check',input});if(state.mode==='unknown')throw new Error('连接已断开');if(state.mode==='reject')return {botFailure:{code:'skill_changed',message:'技能已有新版本'}};const receipt={runId:'run',messageId:'message',skill:origin(input.skill.version)};state.history=[{receipt,status:'queued',createdAt:Date.now(),report:null,current:false,reason:'not_checked'}];if(state.mode==='ack-refresh-fails')state.mode='refresh-fails';return receipt}}};
useBotWorkspaceStore.setState({host:{hostId:'host',capabilities:['skill-dependencies','mutation-data-epoch-v2']},snapshot:{dataEpoch:'epoch',cursor:0,bots:[],conversations:[],runs:[],interactions:[]}});
function Fixture(){const [value,setValue]=useState({open:true,key:0,version:1,cards:false});update=setValue;return value.cards?<div>{Array.from({length:9},(_,index)=><BotSkillCard key={index} skill={{...base,id:'skill'+index,name:'依赖检查'+index}} trials={[]} reload={async()=>{}}/>)}</div>:value.open?<BotSkillDependencyCheck key={value.key} skill={{...base,version:value.version}}/>:<p>closed</p>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`
      },
      alias: { "@": resolve("src/renderer/src") },
      bundle: true,
      outfile: join(directory, "fixture.js"),
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
      logLevel: "silent"
    })
    await writeFile(
      join(directory, "index.html"),
      '<meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>'
    )
    const page = await browser.newPage()
    await page.goto(pathToFileURL(join(directory, "index.html")).href)
    await page.getByRole("button", { name: "检查依赖", exact: true }).waitFor()
    return {
      page,
      close: async () => {
        await browser.close()
        await rm(directory, { recursive: true, force: true })
      }
    }
  } catch (error) {
    await browser.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
it.skipIf(process.env.CMB_BOT_BROWSER_TEST !== "1")(
  "real card keeps exact unknown request/version across reopen and persists confirmed ACK across refresh failure",
  async () => {
    const f = await setup(),
      page = f.page
    try {
      await page.evaluate(() => {
        ;(window as unknown as { fixture: FixtureControl }).fixture.mode = "unknown"
      })
      await page.getByRole("button", { name: "检查依赖", exact: true }).click()
      await page.getByRole("button", { name: "核对原检查", exact: true }).waitFor()
      const first = await fixture(page)
      const submitted = (
        first.find((value) => (value as { kind: string }).kind === "check") as { input: unknown }
      ).input
      await page.evaluate(() => {
        const f = (window as unknown as { fixture: FixtureControl }).fixture
        f.close()
        f.version(2)
      })
      await page.evaluate(() => (window as unknown as { fixture: FixtureControl }).fixture.mount())
      await page.getByText("使用版本 1。", { exact: false }).waitFor()
      await page.getByRole("button", { name: "核对原检查", exact: true }).click()
      await expect
        .poll(
          async () =>
            (await fixture(page)).filter((value) => (value as { kind: string }).kind === "check")
              .length
        )
        .toBe(2)
      const calls = await fixture(page)
      expect(
        (
          calls.filter((value) => (value as { kind: string }).kind === "check")[1] as {
            input: unknown
          }
        ).input
      ).toEqual(submitted)
      await page.evaluate(() => {
        ;(window as unknown as { fixture: FixtureControl }).fixture.mode = "ack-refresh-fails"
      })
      await page.getByRole("button", { name: "核对原检查", exact: true }).click()
      await page.getByText("后台已收到检查，同步时只读取原任务。", { exact: false }).waitFor()
      const beforeClose = await fixture(page)
      await page.evaluate(() => (window as unknown as { fixture: FixtureControl }).fixture.close())
      await page.evaluate(() => (window as unknown as { fixture: FixtureControl }).fixture.mount())
      await page.getByRole("button", { name: "同步检查结果", exact: true }).click()
      expect(
        (await fixture(page)).filter((value) => (value as { kind: string }).kind === "check")
      ).toEqual(beforeClose.filter((value) => (value as { kind: string }).kind === "check"))
      await page.evaluate(() => {
        ;(window as unknown as { fixture: FixtureControl }).fixture.mode = "normal"
      })
      await page.getByRole("button", { name: "同步检查结果", exact: true }).click()
      await expect
        .poll(() =>
          page.evaluate(() => localStorage.getItem("bot-skill-dependency-pending:bot:skill"))
        )
        .toBeNull()
    } finally {
      await f.close()
    }
  },
  20000
)
it.skipIf(process.env.CMB_BOT_BROWSER_TEST !== "1")(
  "real card renders actual report states and refuses retired/corrupt request replay",
  async () => {
    const f = await setup(),
      page = f.page
    try {
      await page.evaluate(() =>
        (window as unknown as { fixture: FixtureControl }).fixture.report("satisfied")
      )
      await page.getByText("已满足", { exact: true }).waitFor()
      await page.getByText("1 项声明", { exact: true }).click()
      expect(await page.getByText("已确认 · 22.23.3", { exact: true }).count()).toBe(1)
      await page.evaluate(() =>
        (window as unknown as { fixture: FixtureControl }).fixture.report("missing")
      )
      await page.getByText("有缺失", { exact: true }).waitFor()
      await page.evaluate(() =>
        (window as unknown as { fixture: FixtureControl }).fixture.report("unverified", false, true)
      )
      await page.getByText("1 项声明", { exact: true }).click()
      await page.getByText("命令退出待确认 · 22.23.3", { exact: true }).waitFor()
      await page.getByText("未核验", { exact: true }).first().waitFor()
      await page.evaluate(() =>
        (window as unknown as { fixture: FixtureControl }).fixture.report("satisfied", true)
      )
      await page.getByText("未核验", { exact: true }).first().waitFor()
      await page.getByText("检查记录已过期；原检查记录保留。", { exact: true }).waitFor()
      await page.evaluate(() => {
        const f = (window as unknown as { fixture: FixtureControl }).fixture
        f.mode = "unknown"
        f.report("unverified")
      })
      await page.getByRole("button", { name: "检查依赖", exact: true }).click()
      await page.getByRole("button", { name: "核对原检查", exact: true }).waitFor()
      const before = await fixture(page)
      await page.evaluate(() =>
        (window as unknown as { fixture: FixtureControl }).fixture.epoch("restored")
      )
      expect(await page.getByRole("button", { name: "核对原检查", exact: true }).isDisabled()).toBe(
        true
      )
      expect(
        (await fixture(page)).filter((value) => (value as { kind: string }).kind === "check")
      ).toEqual(before.filter((value) => (value as { kind: string }).kind === "check"))
      await page.evaluate(() => {
        const f = (window as unknown as { fixture: FixtureControl }).fixture
        f.close()
        f.corrupt()
      })
      await page.evaluate(() => (window as unknown as { fixture: FixtureControl }).fixture.mount())
      await page.getByText("本机依赖检查记录无法读取", { exact: true }).waitFor()
      expect(await page.getByRole("button", { name: "检查依赖", exact: true }).isDisabled()).toBe(
        true
      )
    } finally {
      await f.close()
    }
  },
  20000
)

it.skipIf(process.env.CMB_BOT_BROWSER_TEST !== "1")(
  "a mounted current result remains idle without a self-triggered read loop",
  async () => {
    const f = await setup()
    try {
      await f.page.evaluate(() => {
        const fixture = (window as unknown as { fixture: FixtureControl }).fixture
        fixture.readDelay = 25
        fixture.report("satisfied")
      })
      await f.page.getByText("已满足", { exact: true }).waitFor()
      await f.page.waitForTimeout(50)
      const first = (await fixture(f.page)).filter(
        (value) => (value as { kind: string }).kind === "read"
      ).length
      await f.page.waitForTimeout(200)
      const second = (await fixture(f.page)).filter(
        (value) => (value as { kind: string }).kind === "read"
      ).length
      expect(second - first).toBeLessThanOrEqual(1)
    } finally {
      await f.close()
    }
  },
  15000
)

it.skipIf(process.env.CMB_BOT_BROWSER_TEST !== "1")(
  "library cards do not fan out dependency reads before the user opens a selected version",
  async () => {
    const f = await setup()
    try {
      await f.page.evaluate(() =>
        (window as unknown as { fixture: FixtureControl }).fixture.cards()
      )
      await expect.poll(() => f.page.locator("article").count()).toBe(9)
      await f.page.waitForTimeout(100)
      expect(
        (await fixture(f.page)).filter((value) => (value as { kind: string }).kind === "read")
      ).toHaveLength(0)
      await f.page.locator("article").nth(3).getByText("查看技能步骤", { exact: true }).click()
      await f.page.getByRole("button", { name: "检查依赖", exact: true }).waitFor()
      await expect
        .poll(
          async () =>
            (await fixture(f.page)).filter((value) => (value as { kind: string }).kind === "read")
              .length
        )
        .toBe(1)
      await f.page.waitForTimeout(100)
      expect(
        (await fixture(f.page)).filter((value) => (value as { kind: string }).kind === "read")
      ).toHaveLength(1)
    } finally {
      await f.close()
    }
  },
  15000
)
