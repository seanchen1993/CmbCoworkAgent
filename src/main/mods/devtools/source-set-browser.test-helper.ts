import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

/** Actual React cards/store; only the Electron transport is bridged to the caller's native services. */
export async function sourceSetBrowser(
  seed: { threadId: string; workspace: string },
  dispatch: (method: string, input: Record<string, string>) => Promise<unknown>
) {
  const compiled = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    stdin: {
      loader: "tsx",
      resolveDir: resolve("."),
      contents: `
      import React from "react";import{createRoot}from"react-dom/client";
      import{CreatorSourceSetCard}from"./src/renderer/src/components/customize/CreatorSourceSetCard";
      import{CreatorProjectDeliveryCard}from"./src/renderer/src/components/customize/CreatorProjectDeliveryCard";
      import{useAppStore}from"./src/renderer/src/lib/store";
      import{readHostPluginStartUseIntent}from"./src/renderer/src/lib/plugin-start-use-intent";
      const listeners=new Set(),accepted=[],calls=[];
      const call=(method,input)=>{calls.push({method,input});return window.sourceSetNative(method,input)};
      const api=Object.fromEntries(["status","importSourceSet","advanceSourceSet","cancelSourceSet",
        "installSourceSetDependency","reconcileSourceSetDependency","installProjectDelivery",
        "reconcileProjectDelivery"].map(method=>[method,input=>call(method,input)]));
      window.electron={process:{platform:"win32"}};
      window.api={mods:{onConfigurationChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
        status:threadId=>call("modsStatus",{threadId}),globalEnabled:()=>call("modsGlobal",{}),
        approveFunction:(threadId,pluginId,digest,expectedWorkspace)=>call("approveFunction",{threadId,pluginId,digest,expectedWorkspace})},
        plugins:{prepareStartUse:input=>call("prepareStartUse",input),enableStartUse:input=>call("enableStartUse",input)}};
      let scope=window.fixtureSeed,status={...scope,drafts:[],trials:[],enabled:true};
      const root=createRoot(document.getElementById("root"));
      const onStatus=next=>{accepted.push(next);status=next;render()};
      const render=()=>root.render(<><CreatorSourceSetCard {...scope} status={status.sourceSet} api={api} onStatus={onStatus}/>
        {status.projectDelivery&&<CreatorProjectDeliveryCard {...scope} request={status.sourceSet?.phase==="ready"?status.projectRequest:undefined}
          delivery={status.projectDelivery} preparedBySourceSet={status.sourceSet?.phase==="ready"} api={api} onStatus={onStatus}/>}</>);
      const activate=()=>useAppStore.setState({currentThreadId:scope.threadId,showCustomizeView:false,
        threads:[{thread_id:scope.threadId,title:"Source set",metadata:{workspacePath:scope.workspace}}]});
      window.fixture={accepted,calls,notify:()=>{for(const listener of listeners)listener()},
        startUseIntent:()=>readHostPluginStartUseIntent(),
        setStatus:next=>{status=next;render()},
        switchTarget:next=>{scope=next;status={...scope,drafts:[],trials:[],enabled:true};activate();render()},
        changeAccount:()=>useAppStore.setState({accountRevision:useAppStore.getState().accountRevision+1})};
      activate();render();
    `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.exposeFunction("sourceSetNative", dispatch)
    await page.route("http://localhost/source-set", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div>'
      })
    )
    await page.goto("http://localhost/source-set")
    await page.evaluate((value) => {
      Object.assign(window, { fixtureSeed: value })
    }, seed)
    await page.addScriptTag({ content: compiled.outputFiles[0].text })
    return { browser, page, errors }
  } catch (error) {
    await browser.close()
    throw error
  }
}
