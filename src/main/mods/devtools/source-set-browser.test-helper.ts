import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "../../../../tests/support/browser-worker-plugin.mjs"

/** Actual creator parent/cards/store; Electron transport bridges to the caller's native services. */
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
    define: {
      "process.env.NODE_ENV": '"development"',
      "import.meta.env": "{}",
      "import.meta.hot": "undefined",
      "import.meta.url": '"http://localhost/source-set-fixture.js"'
    },
    plugins: [browserWorkerPlugin()],
    alias: { "@": resolve("src/renderer/src") },
    loader: { ".png": "dataurl", ".md": "text" },
    stdin: {
      loader: "tsx",
      resolveDir: resolve("."),
      contents: `
      import React from "react";import{createRoot}from"react-dom/client";
      import{ModsDevelopmentPanel}from"./src/renderer/src/components/customize/ModsDevelopmentPanel";
      import{useAppStore}from"./src/renderer/src/lib/store";
      import{readHostPluginStartUseIntent}from"./src/renderer/src/lib/plugin-start-use-intent";
      const listeners=new Set(),developmentListeners=new Set(),accepted=[],calls=[];
      let scope=window.fixtureSeed,pushedStatus;
      const call=(method,input)=>{
        const record={method,input,pending:true};calls.push(record);
        if(method!=='status')pushedStatus=undefined;
        return window.sourceSetNative(method,input).then(value=>{
          if(value?.threadId&&value?.workspace)accepted.push(value);return value;
        }).finally(()=>{record.pending=false});
      };
      const api=Object.fromEntries(["importSourceSet","advanceSourceSet","cancelSourceSet",
        "installSourceSetDependency","reconcileSourceSetDependency","installProjectDelivery",
        "reconcileProjectDelivery"].map(method=>[method,input=>call(method,input)]));
      api.status=input=>pushedStatus?Promise.resolve(pushedStatus):call('status',input);
      api.onChanged=listener=>{developmentListeners.add(listener);return()=>developmentListeners.delete(listener)};
      window.electron={process:{platform:"win32"}};
      window.api={mods:{onConfigurationChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
        development:api,
        clawView:threadId=>call("clawView",{threadId}),
        clawChange:(threadId,mutation)=>call("clawChange",{threadId,mutation}),
        status:threadId=>call("modsStatus",{threadId}),globalEnabled:()=>call("modsGlobal",{}),
        approveFunction:(threadId,pluginId,digest,expectedWorkspace)=>call("approveFunction",{threadId,pluginId,digest,expectedWorkspace})},
        plugins:{prepareStartUse:input=>call("prepareStartUse",input),enableStartUse:input=>call("enableStartUse",input)},
        featureGates:{isEnabled:async()=>({enabled:true})}};
      const root=createRoot(document.getElementById("root"));
      const changed=()=>{for(const listener of developmentListeners)listener({threadId:scope.threadId})};
      const render=()=>root.render(<ModsDevelopmentPanel threadId={scope.threadId}
        workspaceHint={scope.workspace} api={api} mode="entry"/>);
      const activate=()=>useAppStore.setState({currentThreadId:scope.threadId,showCustomizeView:false,
        threads:[{thread_id:scope.threadId,title:"Source set",metadata:{workspacePath:scope.workspace}}]});
      window.fixture={accepted,calls,notify:()=>{for(const listener of listeners)listener();changed()},
        pendingStartUse:()=>calls.some(call=>call.pending&&["prepareStartUse","enableStartUse"].includes(call.method)),
        startUseIntent:()=>readHostPluginStartUseIntent(),
        setStatus:next=>{pushedStatus=next;changed()},
        switchTarget:next=>{scope=next;pushedStatus={...scope,drafts:[],trials:[],enabled:true};activate();render()},
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
