import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("http://127.0.0.1/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div>'
      })
    )
    await mount(
      page,
      `
      import {ChatPluginControls} from ${JSON.stringify(resolve("src/renderer/src/components/chat/ChatPluginControls.tsx"))};
      let enabled=false,fail=false,project=false,release,hold=false,functionMode=false;
      const mutations=[];
      const capabilities=[{pluginId:'chat',name:'debug-tools',digest:'b'.repeat(64),state:'ready',capabilities:[]},
        {pluginId:'other',name:'other',digest:'c'.repeat(64),state:'ready',capabilities:[]}];
      const original={id:'original',name:'Original',capabilities:capabilities.map(({state,capabilities,...item})=>item),
        models:{default:'model',roles:{}},skills:{mode:'selected',items:[]}};
      const selection={workspace:'a',enabled:true,applicable:true,usageContext:'chat',issues:[],
        revision:0,bindingRevision:0,capabilities,profiles:[original],active:structuredClone(original)};
      const plugins=()=>[{id:'chat',name:'调试工具',version:'1.0.0',enabled},
        {id:'legacy',name:'旧项目',hasProjectMode:true},
        {id:'host',name:'新项目',projectDependencyIds:['child']},
        {id:'child',name:'项目依赖'}, {id:'orphan',name:'独立依赖',dependencyOnly:true}];
      const report=()=>({identity:{pluginId:'chat',name:'调试工具',version:'1.0.0',digest:'a'.repeat(64)},
        kind:project?'host-project':'chat',canOpen:enabled,activationRequired:!enabled,issues:[],
        chat:{skills:enabled?[{id:'check',name:'check',description:'检查'}]:[],
          ...(functionMode?{functionMod:capabilities[0]}:{})}});
      window.api.plugins={prepareStartUse:async()=>{if(hold)await new Promise(r=>release=r);return report()},
        enableStartUse:async()=>{mutations.push('enable');enabled=true;return report()},
        setEnabled:async()=>{if(fail)return{success:false};mutations.push('disable');enabled=false;return{success:true}}};
      window.api.mods.status=async()=>({workspace:'a',enabled:true,outputPolicy:false,functionMods:functionMode?capabilities:[],mods:[],diagnostics:[]});
      window.api.mods.globalEnabled=async()=>true;
      window.api.mods.clawView=async()=>structuredClone(selection);
      window.api.mods.clawChange=async(_thread,change)=>{
        if(change.revision!==selection.revision)throw Error('STALE');
        if(change.kind==='save'){selection.profiles.push(change.profile);selection.revision++}
        else{if(change.bindingRevision!==selection.bindingRevision)throw Error('STALE');
          selection.active=structuredClone(selection.profiles.find(item=>item.id===change.id));
          selection.bindingRevision=++selection.revision}
        render();return structuredClone(selection);
      };
      const render=()=>host.render(<ChatPluginControls threadId='a' workspace='a'
        plugins={plugins()} sources={functionMode?capabilities:[]}
        activeIds={functionMode?selection.active.capabilities.map(item=>item.pluginId):enabled?['chat']:[]} disabled={false}/>);
      useAppStore.getState().bumpPluginVersion=render;
      window.controls={mutations,fail:value=>fail=value,project:value=>project=value,
        hold:()=>hold=true,release:()=>{hold=false;release()},
        switch:()=>useAppStore.getState().selectThread('b'),selection:()=>structuredClone(selection),
        mod:()=>{functionMode=true;enabled=true;useAppStore.getState().selectThread('a');render()}};
      render();
    `,
      [],
      true,
      "http://127.0.0.1/"
    )
    const styles = readdirSync(resolve("out/renderer/assets"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => readFileSync(resolve("out/renderer/assets", name), "utf8"))
      .join("\n")
    await page.addStyleTag({ content: styles })
    await page.addStyleTag({ content: "#root{width:360px;margin:24px}" })
    const panel = page.getByRole("region", { name: "聊天灵件" })
    await panel.getByRole("button", { name: "启用", exact: true }).waitFor()
    for (const name of ["旧项目", "新项目", "项目依赖", "独立依赖"])
      assert.equal(await panel.getByText(name, { exact: true }).count(), 0)
    await panel.getByRole("button", { name: "启用", exact: true }).click()
    await panel.getByRole("button", { name: "确认并进入使用", exact: true }).click()
    await panel.getByText("本聊天已启用", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.controls.mutations"), ["enable"])
    assert.deepEqual(await page.evaluate("window.fixture.navigation()"), [])
    mkdirSync(resolve("output/chat-plugin-controls"), { recursive: true })
    await page.screenshot({ path: resolve("output/chat-plugin-controls/controls.png") })

    await page.evaluate("window.controls.fail(true)")
    await panel.getByRole("button", { name: "停用", exact: true }).click()
    await panel.getByRole("alert").waitFor()
    assert.equal(await panel.getByText("本聊天已启用", { exact: true }).count(), 1)
    await page.evaluate("window.controls.fail(false)")
    await panel.getByRole("button", { name: "停用", exact: true }).click()
    await panel.getByRole("button", { name: "启用", exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.controls.mutations"), ["enable", "disable"])

    await page.evaluate("window.controls.project(true)")
    await panel.getByRole("button", { name: "启用", exact: true }).click()
    await panel.getByText("这是项目插件，请在项目模式中使用。", { exact: true }).waitFor()
    assert.equal(await panel.getByRole("button", { name: "确认并进入使用" }).count(), 0)
    await page.evaluate("window.controls.project(false);window.controls.hold()")
    await panel.getByRole("button", { name: "启用", exact: true }).click()
    await page.evaluate("window.controls.switch();window.controls.release()")
    await page.waitForFunction("!document.querySelector('[aria-label=聊天灵件] button').disabled")
    assert.equal(await panel.getByRole("button", { name: "确认并进入使用" }).count(), 0)
    assert.deepEqual(await page.evaluate("window.controls.mutations"), ["enable", "disable"])
    await page.evaluate("window.controls.mod()")
    await panel.getByRole("button", { name: "停用", exact: true }).click()
    await panel.getByRole("button", { name: "启用", exact: true }).waitFor()
    assert.deepEqual(
      await page.evaluate(
        "window.controls.selection().active.capabilities.map(item=>item.pluginId)"
      ),
      ["other"]
    )
    assert.deepEqual(await page.evaluate("window.controls.mutations"), ["enable", "disable"])
    await panel.getByRole("button", { name: "启用", exact: true }).click()
    await panel.getByText("本聊天已启用", { exact: true }).waitFor()
    assert.deepEqual(
      await page.evaluate(
        "window.controls.selection().active.capabilities.map(item=>item.pluginId).sort()"
      ),
      ["chat", "other"]
    )
    assert.deepEqual(await page.evaluate("window.controls.selection().active.models"), {
      default: "model",
      roles: {}
    })
    assert.deepEqual(await page.evaluate("window.controls.mutations"), ["enable", "disable"])
    assert.deepEqual(errors, [])
    mkdirSync(resolve("output/chat-plugin-controls"), { recursive: true })
    writeFileSync(
      resolve("output/chat-plugin-controls/result.json"),
      JSON.stringify(
        {
          passed: true,
          checks: [
            "project/dependency exclusion",
            "inline activation without navigation",
            "disable failure preserves state",
            "disable and re-enable",
            "native kind recheck",
            "late scope rejection",
            "chat-only Mod removal preserves other providers and models; reactivation reuses permission"
          ]
        },
        null,
        2
      )
    )
    console.log("PASS inline chat plugin controls, native recheck, failures and scope guards")
  } catch (error) {
    console.error(await page.locator("body").innerText())
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
