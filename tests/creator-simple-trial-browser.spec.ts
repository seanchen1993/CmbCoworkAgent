/** Real trial UI; bounded IPC verifies preparation never starts a business run or grants access. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/creator-simple-trial-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React from "react"; import {createRoot} from "react-dom/client";
      import {BusinessCreatorTrialDialog} from "./src/renderer/src/components/customize/BusinessCreatorTrialDialog";
      const root=createRoot(document.getElementById("root")),calls=[];
      const review={planId:"plan",name:"独立审查插件",version:"1.0.0",digest:"a".repeat(64),
        copyId:"independent",phase:"needs-approval",canConfirm:true,steps:[],diagnostics:[]};
      let trial,mode="normal",epoch=0,open=true,release;
      const status=()=>({threadId:"creator",workspace:"C:/creator",mode:"creator",enabled:true,
        drafts:[],trials:[],business:{drafts:[],review,trial:trial&&structuredClone(trial)}});
      const seed=()=>({id:"native-trial",planId:"plan",name:review.name,digest:review.digest,version:1,
        phase:"needs-confirmation",goal:"核对知识和产物",canPrepare:true,canStart:false,canRefresh:false,
        canStop:false,diagnostics:[]});
      const api={request:async input=>{calls.push(["request",input]);trial=seed();
          if(mode==="host")return {...status(),business:{drafts:[],review},projectTrial:{id:"host"}};
          if(mode==="wrong-scope")return {...status(),workspace:"C:/another"};
          if(mode==="lost"){trial.phase="unknown";trial.canPrepare=false;throw Error("PREPARATION_UNKNOWN")}
          if(mode==="delayed")await new Promise(resolve=>release=resolve);
          else {render();await new Promise(resolve=>requestAnimationFrame(resolve))}
          return status()},
        prepare:async input=>{calls.push(["prepare",input]);
          if(input.trialId!==trial.id||input.digest!==trial.digest||input.expectedVersion!==1)throw Error("WRONG_SCOPE");
          trial={...trial,version:2,phase:"needs-configuration",canPrepare:false};return status()},
        start:async()=>{calls.push(["forbidden-start"]);throw Error("NO_IMPLICIT_EXECUTION")},
        refresh:async()=>status(),source:{read:async id=>({projectId:id,projectVersion:2,packageDigest:"b".repeat(64),
          workspace:"C:/isolated",source:{name:"required-config",digest:"c".repeat(64),state:"ready",
            capabilities:[],configurationOnly:true,configurationReady:false}}),
          approve:async()=>{calls.push(["forbidden-approval"]);throw Error("NO_IMPLICIT_APPROVAL")}}};
      window.api={mods:{development:{status:async()=>{calls.push(["read-status"]);return status()}}}};
      const render=()=>root.render(<BusinessCreatorTrialDialog key={epoch} open={open} onOpenChange={value=>{open=value;render()}}
        threadId="creator" workspace="C:/creator" review={review} trial={trial} api={api}
        onStatus={value=>{trial=value.business?.trial;render()}}/>);
      window.fixture={calls,reset:value=>{mode=value;epoch++;trial=undefined;open=true;render()},
        close:()=>{open=false;render()},release:()=>release()};render();
    `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    plugins: [browserWorkerPlugin()],
    loader: { ".md": "text", ".png": "dataurl" },
    define: {
      "import.meta.env": "{}",
      "import.meta.hot": "undefined",
      "import.meta.url": '"http://trial.fixture/bundle.js"'
    },
    logLevel: "error"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const checks: string[] = [],
    errors: string[] = []
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const dialog = page.getByRole("dialog", { name: "插件试用与整轮验收", exact: true })
    const start = dialog.getByRole("button", { name: "开始试用", exact: true })
    const count = (kind: string) =>
      page.evaluate(
        (kind) =>
          window.eval(
            "window.fixture.calls.filter(call=>call[0]===" + JSON.stringify(kind) + ").length"
          ),
        kind
      )
    await dialog.getByRole("textbox", { name: "本次试用目标", exact: true }).fill("核对知识和产物")
    await start.evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    await dialog.getByRole("heading", { name: "项目设置", exact: true }).waitFor()
    assert.equal(await count("request"), 1)
    assert.equal(await count("prepare"), 1)
    assert.equal(
      await dialog.getByRole("button", { name: "开始执行", exact: true }).isDisabled(),
      true
    )
    assert.equal(await dialog.getByRole("checkbox").count(), 0)
    assert.deepEqual(
      await page.evaluate("window.fixture.calls.find(call=>call[0]==='prepare')[1]"),
      {
        threadId: "creator",
        expectedWorkspace: "C:/creator",
        trialId: "native-trial",
        digest: "a".repeat(64),
        expectedVersion: 1
      }
    )
    checks.push("one trial action survives early native status delivery and prepares exactly once")
    checks.push("required configuration still blocks execution; preparation grants no access")
    for (const mode of ["wrong-scope", "lost", "host"]) {
      await page.evaluate(
        (mode) => window.eval("window.fixture.reset(" + JSON.stringify(mode) + ")"),
        mode
      )
      await dialog.getByRole("textbox", { name: "本次试用目标", exact: true }).fill("验证准确来源")
      const before = await count("prepare")
      const requests = await count("request")
      await start.click()
      await page.waitForFunction(
        (before) =>
          window.eval("window.fixture.calls.filter(call=>call[0]==='request').length") ===
          before + 1,
        requests
      )
      if (mode !== "host") await dialog.getByRole("alert").last().waitFor()
      else await start.waitFor()
      assert.equal(await count("prepare"), before)
      checks.push(`${mode}: no preparation is replayed or sent to the wrong runtime`)
    }
    await page.evaluate("window.fixture.reset('delayed')")
    await dialog
      .getByRole("textbox", { name: "本次试用目标", exact: true })
      .fill("关闭时不继续操作")
    const before = await count("prepare")
    await start.click()
    await dialog.getByRole("button", { name: "Close", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    await page.evaluate("window.fixture.release()")
    assert.equal(await count("prepare"), before)
    assert.equal(await count("forbidden-start"), 0)
    assert.equal(await count("forbidden-approval"), 0)
    assert.deepEqual(errors, [])
    checks.push("closing a pending trial prevents its dependent preparation")
    writeFileSync(resolve(output, "report.json"), JSON.stringify({ passed: true, checks }, null, 2))
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }))
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
