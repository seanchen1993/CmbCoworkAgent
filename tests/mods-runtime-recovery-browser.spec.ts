import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(
      page,
      `
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      const notifications=new Set();let stopped=true,reads=0,reloads=0;
      window.api.mods.onCardsChanged=fn=>{notifications.add(fn);return()=>notifications.delete(fn)};
      window.api.mods.siteMountOutcome=async()=>({state:'mounted',owner:'owned'});
      window.api.mods.siteUnmount=async()=>{};
      window.api.mods.siteRender=async()=>{reads++;if(stopped)throw Error("Error invoking remote method 'mods:function-site-mount-outcome': ModFunctionError: MODS_CONFIG_RELOAD_STOPPED: 当前组件已停止；请查看恢复选项，核对未完成操作后明确重新加载。");return {key:'engine:owned',id:'owned',plugin:'engine',generation:'fresh',tree:{type:'engine',ref:0},nativeContent:{component:'AssistantMessage',entries:[{ref:0,props:{text:'Recovered display',isFirstOfReply:true}}],nativeUnchanged:false},title:'history',rows:1,closeOnEscape:false}};
      window.api.mods.userConfig=async(threadId,pluginId)=>({workspace:threadId,pluginId,plugin:'Demo',digest:'a'.repeat(64),savedRevision:0,state:stopped?'stopped':'applied',fields:[]});
      window.api.mods.reloadUserConfig=async(threadId,view)=>{reloads++;stopped=false;for(const fn of notifications)fn({threadId,scope:'source-replaced:99'});return {...view,state:'applied'}};
      window.recoveryFixture={reads:()=>reads,reloads:()=>reloads,open:()=>openClawSidebar('configuration')};
      function RecoveryFixture(){return <><ChatFixture id='a'/><ModsChatScope.Provider value={{threadId:'a',enabled:true,ready:true}}><FunctionSite threadId='a' component='AssistantMessage' facts={{text:'old',isFirstOfReply:true}} renderNative={safe=><p>{safe.text}</p>}/></ModsChatScope.Provider></>}
      host.render(<RecoveryFixture/>);
    `,
      [browserWorkerPlugin()]
    )
    await page.getByRole("button", { name: "查看恢复选项" }).waitFor()
    assert.equal(await page.locator('details').getByText("MODS_CONFIG_RELOAD_STOPPED", { exact: true }).isVisible(), false)
    assert.equal(await page.locator('[role="alert"] > span').innerText(),
      "组件运行已停止或响应超时。未完成操作的结果需要核对；请查看恢复选项，明确重新加载组件。")
    await page.waitForTimeout(450)
    assert.equal(await page.evaluate("window.recoveryFixture.reads()"), 1)
    assert.equal(await page.evaluate("window.recoveryFixture.reloads()"), 0)
    await page.getByRole("button", { name: "查看恢复选项" }).click()
    await page.getByText("插件参数", { exact: true }).click()
    await page.getByRole("button", { name: "重新加载当前组合", exact: true }).waitFor()
    assert.equal(await page.getByText(/初始化操作可能再次执行/).count(), 1)
    assert.equal(await page.evaluate("window.recoveryFixture.reloads()"), 0)
    await page.getByRole("button", { name: "重新加载当前组合", exact: true }).click()
    await page.getByText("Recovered display", { exact: true }).waitFor()
    assert.equal(await page.evaluate("window.recoveryFixture.reloads()"), 1)
    await page.getByRole("button", { name: "收起当前助手", exact: true }).click()
    await page.evaluate("window.recoveryFixture.open()")
    assert.equal(await page.getByText("插件参数", { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
    console.log(
      "PASS stopped display never auto-restarts; trusted user can reach zero-field plugin recovery and explicitly reload once; closing clears recovery view"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
