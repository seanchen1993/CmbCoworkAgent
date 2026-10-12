/** Actual React panels and stores; controlled slow IPC and document lifecycle.
 * Native window hiding is separately covered by bot-desktop-e2e. */
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main(): Promise<void> {
  const bundle = await build({
    stdin: {
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';
      import{useAppStore}from'./src/renderer/src/lib/store';
      import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';
      import{BotResources}from'./src/renderer/src/components/bots/BotResources';
      import{BotMemoryPanel}from'./src/renderer/src/components/bots/BotMemoryPanel';
      import{BotSharedMemoryPanel}from'./src/renderer/src/components/bots/BotSharedMemoryPanel';
      import{BotInstalledSkills}from'./src/renderer/src/components/bots/BotInstalledSkills';
      import{BotAsyncTasks}from'./src/renderer/src/components/bots/BotAsyncTasks';
      import{BotRoutineHistory}from'./src/renderer/src/components/bots/BotRoutineHistory';
      import{BotRunHistory}from'./src/renderer/src/components/bots/BotRunHistory';
      import{BotShellJob}from'./src/renderer/src/components/bots/BotShellJob';
      import{BotEffectDetails}from'./src/renderer/src/components/bots/BotEffectDetails';
      import{BotInteractionDetails}from'./src/renderer/src/components/bots/BotInteractionDetails';
      import{BotBackupSchedule}from'./src/renderer/src/components/bots/BotBackupSchedule';
      import{BotApprovalRules}from'./src/renderer/src/components/bots/BotApprovalRules';
      import{BotWebhook}from'./src/renderer/src/components/bots/BotWebhook';
      import{BotPluginPanes}from'./src/renderer/src/components/bots/BotPluginPanes';
      const noop=()=>{};const reload=async()=>{};const pending=[];
      window.counts={};window.api={bots:new Proxy({}, {get:(_,name)=>()=>{
        window.counts[name]=(window.counts[name]||0)+1;
        return new Promise((resolve,reject)=>pending.push({name,resolve,reject}));
      }})};
      window.release=()=>pending.splice(0).forEach(({reject})=>reject(new Error('LATE_FIXTURE_FAILURE')));
      window.showDocument=visible=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:visible?'visible':'hidden'});document.dispatchEvent(new Event('visibilitychange'))};
      window.cover=showCustomizeView=>useAppStore.setState({showCustomizeView});
      useBotWorkspaceStore.setState({host:{capabilities:['memory-synthesis']}});
      const bot={id:'bot',name:'Lifecycle',revision:1,status:'active',workspacePath:'/project'};
      const routine={id:'routine',botId:'bot',name:'Routine',timezone:'UTC',revision:1};
      const address={conversationId:'conversation',runId:'run',jobId:'job'};
      const panels={
        routines:<BotResources bot={bot} tab="routines" close={noop}/>,
        skills:<BotResources bot={bot} tab="skills" close={noop}/>,
        memory:<BotMemoryPanel botId="bot" memories={[]} reload={reload} close={noop}/>,
        shared:<BotSharedMemoryPanel bot={bot} scope="user" close={noop}/>,
        installed:<BotInstalledSkills botId="bot" trials={[]} reload={reload}/>,
        tasks:<BotAsyncTasks bot={bot} close={noop}/>,
        routinesHistory:<BotRoutineHistory routine={routine} close={noop} openMessage={noop}/>,
        runHistory:<BotRunHistory address={address} close={noop}/>,
        shell:<BotShellJob address={address} close={noop} back={noop}/>,
        effects:<BotEffectDetails address={address} effectId="effect"/>,
        interactions:<BotInteractionDetails address={address} interactionId="interaction"/>,
        backups:<BotBackupSchedule disabled={false} onBackup={noop}/>,
        rules:<BotApprovalRules bot={bot} close={noop}/>,
        webhook:<BotWebhook routine={routine} close={noop}/>,
        plugins:<BotPluginPanes address={{...address,botId:'bot'}} dataEpoch="initial"/>
      };
      function Fixture(){const[kind,setKind]=useState(null);window.mountPanel=setKind;return <div data-testid="fixture" data-kind={kind||'none'} key={kind}>{panels[kind]}</div>}
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
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" }
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("http://localhost/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<html><body><div id="root"></div></body></html>'
      })
    )
    await page.goto("http://localhost/")
    await page.clock.install()
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByTestId("fixture").waitFor({ state: "attached" })
    const cases = [
      ["routines", "routines"],
      ["skills", "skills"],
      ["memory", "memoryPolicy"],
      ["shared", "sharedMemories"],
      ["installed", "installedSkills"],
      ["tasks", "asyncTasks"],
      ["routinesHistory", "routineHistory"],
      ["runHistory", "runHistory"],
      ["shell", "shellJob"],
      ["effects", "effectDetail"],
      ["interactions", "interactionDetail"],
      ["backups", "backupSchedule"],
      ["rules", "approvalRules"],
      ["webhook", "webhook"],
      ["plugins", "pluginPanes"]
    ]
    for (const [kind, method] of cases) {
      await page.evaluate(
        ({ kind }) => {
          const fixture = window as unknown as {
            showDocument(value: boolean): void
            mountPanel(value: string | null): void
            counts: Record<string, number>
          }
          fixture.showDocument(false)
          fixture.counts = {}
          fixture.mountPanel(kind)
        },
        { kind }
      )
      await page.clock.runFor(100)
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as { counts: object }).counts),
        {},
        `${kind}: hidden mount must not read`
      )
      await page.evaluate(() =>
        (window as unknown as { showDocument(value: boolean): void }).showDocument(true)
      )
      await page.clock.runFor(100)
      const count = () =>
        page.evaluate(
          (method) => (window as unknown as { counts: Record<string, number> }).counts[method] || 0,
          method
        )
      assert.equal(await count(), 1, `${kind}: visible viewer must read`)
      await page.clock.runFor(12_000)
      assert.equal(await count(), 1, `${kind}: slow read must not overlap its next poll`)
      await page.evaluate(() => (window as unknown as { cover(value: boolean): void }).cover(true))
      await page.clock.runFor(100)
      await page.evaluate(() => (window as unknown as { release(): void }).release())
      await page.clock.runFor(12_000)
      assert.equal(await count(), 1, `${kind}: settings-covered viewer must stop`)
      assert.equal(
        await page.getByText("LATE_FIXTURE_FAILURE", { exact: true }).count(),
        0,
        `${kind}: late failure cannot overwrite hidden state`
      )
      await page.evaluate(() => (window as unknown as { cover(value: boolean): void }).cover(false))
      await page.clock.runFor(100)
      assert.equal(await count(), 2, `${kind}: reopening must refresh`)
      await page.evaluate(() =>
        (window as unknown as { showDocument(value: boolean): void }).showDocument(false)
      )
      await page.clock.runFor(100)
      await page.evaluate(() => (window as unknown as { release(): void }).release())
      await page.clock.runFor(12_000)
      assert.equal(await count(), 2, `${kind}: hidden window must stop`)
      await page.evaluate(() =>
        (window as unknown as { mountPanel(value: null): void }).mountPanel(null)
      )
      await page.clock.runFor(100)
      console.log(`PASS ${kind}: hidden/covered/unmounted, resume and slow read`)
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
