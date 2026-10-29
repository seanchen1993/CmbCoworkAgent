import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { expect, it } from "vitest"
import type { PluginFlowDefinition } from "../../src/shared/plugin-flow-definition"

it("previews installed definitions without bindings or execution APIs and discards outdated reads", async () => {
  const native: PluginFlowDefinition = {
    source: { pluginId: "installed", name: "Installed package", version: "1", enabled: false },
    status: "ready",
    format: "native",
    declarationPath: "devclaw.project-runtime.json",
    diagnostics: [],
    templates: [
      {
        id: "flow",
        title: "Package route",
        description: "",
        kind: "fixed",
        nodeIds: ["draft"],
        requiredNodeIds: []
      }
    ],
    nodes: [
      {
        id: "draft",
        title: "Installed native draft",
        description: "",
        inputs: [],
        outputs: ["draft.md"],
        checks: [],
        approval: "human"
      }
    ]
  }
  const legacy: PluginFlowDefinition = {
    ...native,
    format: "legacy",
    source: { ...native.source, version: "2" },
    declarationPath: "board_core/board_config.json",
    templates: [
      {
        id: "profile",
        title: "Installed legacy template",
        description: "",
        kind: "profile",
        requiredNodeIds: []
      }
    ],
    nodes: [
      {
        id: "legacy",
        title: "Installed legacy node",
        description: "",
        inputs: [],
        outputs: [],
        checks: []
      }
    ]
  }
  const bundle = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [
      {
        name: "isolated-store",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/store$/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "js",
            contents: `
        export const useAppStore=selector=>selector({pluginVersion:0,accountRevision:0});
      `
          }))
        }
      }
    ],
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
      import React,{useState}from'react';import{createRoot}from'react-dom/client';
      import{InstalledPluginFlowDefinition}from'./src/renderer/src/components/customize/InstalledPluginFlowDefinition';
      window.api={plugins:{flowDefinition:input=>window.readDefinition(input)}};
      function Fixture(){const[version,setVersion]=useState('1');window.fixture={setVersion};
        return <InstalledPluginFlowDefinition pluginId="installed" name="Installed package" version={version}/>}
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const calls: unknown[] = []
  let mode: "native" | "legacy" | "pending" | "removed" = "native"
  let finish: ((value: PluginFlowDefinition) => void) | undefined
  try {
    const page = await browser.newPage()
    await page.exposeFunction("readDefinition", async (input: unknown) => {
      calls.push(input)
      if (mode === "pending")
        return new Promise<PluginFlowDefinition>((done) => {
          finish = done
        })
      if (mode === "removed") throw Error("插件已卸载，请刷新插件目录。")
      return mode === "native" ? native : legacy
    })
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByText("Installed native draft", { exact: true }).first().waitFor()
    expect(await page.getByText("draft", { exact: true }).isVisible()).toBe(false)
    expect(
      await page.getByText("定义来源：devclaw.project-runtime.json", { exact: true }).isVisible()
    ).toBe(false)
    await page.getByText("查看步骤详情", { exact: true }).click()
    expect(await page.getByText("draft", { exact: true }).isVisible()).toBe(true)
    expect(await page.getByText("产出：draft.md", { exact: true }).isVisible()).toBe(true)
    await page.getByText("查看步骤详情", { exact: true }).click()
    expect(calls).toEqual([
      { pluginId: "installed", expected: { name: "Installed package", version: "1" } }
    ])
    expect(await page.getByRole("checkbox").count()).toBe(0)
    expect(await page.getByRole("combobox").count()).toBe(0)
    expect(await page.getByRole("button", { name: /新建|执行|审批|启用/ }).count()).toBe(0)
    expect(
      await page.getByText("此插件已停用，仍可查看已安装版本的定义。", { exact: true }).count()
    ).toBe(1)
    mode = "pending"
    await page.getByRole("button", { name: "重新读取流程定义", exact: true }).click()
    await expect.poll(() => calls.length).toBe(2)
    expect(await page.getByText("Installed native draft", { exact: true }).count()).toBe(0)
    mode = "legacy"
    await page.evaluate("window.fixture.setVersion('2')")
    await page.getByText("Installed legacy node", { exact: true }).first().waitFor()
    finish?.(native)
    await page.getByText("此模板未声明固定步骤序列。", { exact: true }).waitFor()
    expect(await page.getByText("Installed native draft", { exact: true }).count()).toBe(0)
    mode = "removed"
    await page.getByRole("button", { name: "重新读取流程定义", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "插件已卸载" }).waitFor()
    expect(await page.getByText("Installed legacy node", { exact: true }).count()).toBe(0)
    mode = "legacy"
    await page.getByRole("button", { name: "重新读取流程定义", exact: true }).click()
    await page.getByText("Installed legacy node", { exact: true }).first().waitFor()
  } finally {
    await browser.close()
  }
}, 60000)

it("routes unscoped installed Host plugins without adding chat configuration steps or stale navigation", async () => {
  const bundle = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    loader: { ".md": "text", ".png": "dataurl" },
    define: { "process.env.NODE_ENV": '"test"', "import.meta.env": "{}" },
    plugins: [
      {
        name: "unscoped-installed-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /^\.\/[A-Z]/ }, (args) => {
            if (!args.importer.endsWith("ModsPanel.tsx")) return
            if (args.path === "./SparksOperationError") return
            return { path: args.path.slice(2), namespace: "fixture" }
          })
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "tsx",
            resolveDir: process.cwd(),
            contents:
              args.path === "store"
                ? `
            import{useSyncExternalStore}from'react';const listeners=new Set();
            const state={accountRevision:0,threads:[],currentThreadId:null,
              bumpPluginVersion:()=>window.fixture.calls.push(['bump']),
              setShowCustomizeView:(...args)=>window.fixture.calls.push(['settings',...args]),
              setShowHarnessBoardView:()=>window.fixture.calls.push(['project']),
              switchAccount:()=>{state.accountRevision++;for(const listener of listeners)listener()}};
            export const useAppStore=selector=>useSyncExternalStore(
              listener=>{listeners.add(listener);return()=>listeners.delete(listener)},()=>selector(state));
            useAppStore.getState=()=>state;useAppStore.subscribe=()=>()=>{};
          `
                : `export function ${args.path}(){return null}`
          }))
        }
      }
    ],
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
        import React,{useState}from'react';import{createRoot}from'react-dom/client';
        import{ModsSettings}from'./src/renderer/src/components/customize/ModsPanel';
        import{useAppStore}from'@/lib/store';
        import{readDerivedProjectIntent}from'./src/renderer/src/lib/derived-project-intent';
        let mode='pending',gate=true,finish=[];const calls=[];
        let plugins=['host','legacy','chat','disabled'].map(id=>({id,name:id,version:'1',
          enabled:id!=='disabled',hasProjectMode:id==='legacy',path:'C:/'+id,updatedAt:'one',
          skillCount:0,mcpServerCount:0}));
        const templates=()=>plugins.filter(p=>p.enabled&&['host','disabled'].includes(p.id))
          .map(p=>({installedPluginId:p.id,name:p.id+'-package',version:p.version,stages:['draft']}));
        window.api={plugins:{list:async()=>plugins.map(p=>({...p})),
          setEnabled:async(id,value)=>{calls.push(['enable',id,value]);plugins=plugins.map(p=>p.id===id?{...p,enabled:value}:p);return{success:true}}},
          mods:{globalEnabled:async()=>false,onConfigurationChanged:()=>()=>{}},
          featureGates:{isEnabled:async()=>({enabled:gate})},
          harnessBoard:{localProjects:{templates:async()=>{calls.push(['templates']);
            if(mode==='error')throw Error('Unavailable templates');
            if(mode==='pending')return new Promise(resolve=>finish.push(resolve));return templates()}}}};
        function Fixture(){const[key,setKey]=useState(0);window.fixture={calls,
          setMode:value=>{mode=value},pending:()=>finish.length,
          resolve:()=>{mode='ready';for(const resolve of finish.splice(0))resolve(templates())},
          refresh:()=>window.dispatchEvent(new Event('mods:configuration-changed')),
          mutate:()=>{plugins=plugins.map(p=>p.id==='host'?{...p,updatedAt:'changed'}:p)},
          switchAccount:()=>{plugins=plugins.map(p=>({...p,updatedAt:'account-two'}));useAppStore.getState().switchAccount()},
          setGate:value=>{gate=value;setKey(v=>v+1)},intent:readDerivedProjectIntent};
          return <ModsSettings key={key} threadId={null} active/>}
        createRoot(document.getElementById('root')).render(<Fixture/>);
      `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage()
    await page.route("https://installed-plugins.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<html><body><div id="root"></div></body></html>'
      })
    )
    await page.goto("https://installed-plugins.test/")
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const card = (id: string) => page.locator(`[data-installed-mod-id="${id}"]`)
    const navigationCount = () =>
      page.evaluate("window.fixture.calls.filter(c=>c[0]==='project').length")
    await card("chat").getByRole("button", { name: "配置", exact: true }).waitFor()
    expect(await card("host").getByRole("button", { name: "配置", exact: true }).count()).toBe(1)
    await expect.poll(() => page.evaluate("window.fixture.pending()")).toBe(1)
    await page.evaluate("window.fixture.resolve()")
    await card("host").getByRole("button", { name: "去使用", exact: true }).waitFor()
    expect(await card("host").getByText("支持项目模式", { exact: true }).count()).toBe(1)
    expect(await card("chat").getByRole("button", { name: "配置", exact: true }).count()).toBe(1)
    await card("host").getByRole("button", { name: "去使用", exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(`({
      navigation:window.fixture.calls.filter(c=>c[0]==='project').length,
      errors:[...document.querySelectorAll('[role="alert"]')].map(item=>item.textContent)
    })`)
      )
      .toEqual({ navigation: 1, errors: [] })
    expect(await page.evaluate("window.fixture.intent()")).toMatchObject({
      pluginId: "host",
      name: "host-package"
    })
    expect(await page.evaluate("window.fixture.intent().scope")).toBeUndefined()
    await card("legacy").getByRole("button", { name: "去使用", exact: true }).click()
    await expect.poll(navigationCount).toBe(2)
    expect(await page.evaluate("window.fixture.intent().name")).toBe("legacy")
    await card("disabled").getByRole("button", { name: "启用插件", exact: true }).click()
    await card("disabled").getByRole("button", { name: "去使用", exact: true }).waitFor()
    expect(await navigationCount()).toBe(2)
    expect(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='enable')")).toEqual([
      ["enable", "disabled", true]
    ])

    await page.evaluate("window.fixture.setMode('error');window.fixture.refresh()")
    await card("host").getByRole("button", { name: "配置", exact: true }).waitFor()
    expect(await card("chat").getByRole("button", { name: "配置", exact: true }).count()).toBe(1)
    expect(
      await card("chat")
        .getByRole("button", { name: /核对|重试/ })
        .count()
    ).toBe(0)
    expect(
      await card("legacy").getByRole("button", { name: "去使用", exact: true }).isEnabled()
    ).toBe(true)
    await card("host").getByRole("button", { name: "管理", exact: true }).click()
    await card("host").getByRole("button", { name: "重新核对项目入口", exact: true }).waitFor()
    await page.evaluate("window.fixture.setMode('pending')")
    await card("host").getByRole("button", { name: "重新核对项目入口", exact: true }).click()
    await expect.poll(() => page.evaluate("window.fixture.pending()")).toBe(1)
    expect(await card("chat").getByRole("button", { name: "配置", exact: true }).count()).toBe(1)
    await page.evaluate("window.fixture.resolve()")
    await card("host").getByRole("button", { name: "去使用", exact: true }).waitFor()

    await page.evaluate("window.fixture.setMode('pending')")
    await card("host").getByRole("button", { name: "去使用", exact: true }).click()
    await expect.poll(() => page.evaluate("window.fixture.pending()")).toBe(1)
    await page.evaluate("window.fixture.mutate();window.fixture.resolve()")
    await page.getByRole("alert").filter({ hasText: "插件版本或状态已变化" }).waitFor()
    expect(await navigationCount()).toBe(2)
    await page.evaluate("window.fixture.refresh()")
    await card("host").getByRole("button", { name: "去使用", exact: true }).waitFor()

    await page.evaluate("window.fixture.setMode('pending')")
    await card("host").getByRole("button", { name: "去使用", exact: true }).click()
    await expect.poll(() => page.evaluate("window.fixture.pending()")).toBe(1)
    await page.evaluate("window.fixture.switchAccount()")
    await expect.poll(() => page.evaluate("window.fixture.pending()")).toBe(2)
    await page.evaluate("window.fixture.resolve()")
    await card("host").getByRole("button", { name: "去使用", exact: true }).waitFor()
    expect(await navigationCount()).toBe(2)

    await page.evaluate("window.fixture.setGate(false)")
    await card("legacy").getByRole("button", { name: "去使用", exact: true }).waitFor()
    await expect
      .poll(() => card("legacy").getByRole("button", { name: "去使用", exact: true }).isDisabled())
      .toBe(true)
    const templateReads = await page.evaluate(
      "window.fixture.calls.filter(c=>c[0]==='templates').length"
    )
    await page.evaluate("window.fixture.refresh()")
    await card("chat").getByRole("button", { name: "配置", exact: true }).waitFor()
    expect(
      await card("chat")
        .getByRole("button", { name: /核对|重试/ })
        .count()
    ).toBe(0)
    expect(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='templates').length")).toBe(
      templateReads
    )
    expect(await navigationCount()).toBe(2)
  } finally {
    await browser.close()
  }
}, 60000)

it("opens static definitions from both ordinary parent panels without an enabled plugin or binding", async () => {
  const bundle = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    loader: { ".md": "text", ".png": "dataurl" },
    define: { "process.env.NODE_ENV": '"test"', "import.meta.env": "{}" },
    plugins: [
      {
        name: "bounded-panel-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /^\.\/[A-Z]/ }, (args) => {
            if (!args.importer.endsWith("ModsPanel.tsx")) return
            const name = args.path.slice(2)
            if (name === "InstalledPluginFlowDefinition") return
            return { path: name, namespace: "fixture" }
          })
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "tsx",
            contents:
              args.path === "store"
                ? `
          const state={pluginVersion:0,accountRevision:0,threads:[],currentThreadId:null};
          export const useAppStore=selector=>selector(state);
          useAppStore.getState=()=>state;useAppStore.subscribe=()=>()=>{};
        `
                : `export function ${args.path}(){return null}`
          }))
        }
      }
    ],
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
      import React,{useState}from'react';import{createRoot}from'react-dom/client';
      import{ModsSettings}from'./src/renderer/src/components/customize/ModsPanel';
      import{NativePluginCapabilities}from'./src/renderer/src/components/customize/NativePluginCapabilities';
      const calls=[],forbidden=[],plugin={id:'host',name:'Host installed',version:'1',enabled:false,
        hasProjectMode:false,skillCount:0,mcpServerCount:0};
      const blocked=new Proxy({},{get:(_,key)=>{forbidden.push(String(key));throw Error('NO_PROJECT_ACCESS')}});
      window.api={plugins:{list:async()=>[plugin],flowDefinition:async input=>{calls.push(input);return{
        source:{pluginId:'host',name:plugin.name,version:'1',enabled:false},status:'ready',format:'native',
        diagnostics:[],templates:[],nodes:[{id:'actual',title:'Actual installed definition',description:'',inputs:[],outputs:[],checks:[]}]}}},
        mods:{globalEnabled:async()=>false,onConfigurationChanged:()=>()=>{}},
        featureGates:{isEnabled:async()=>({enabled:false})},skills:{listPlugins:async()=>[]},
        nodeComposition:blocked,harnessBoard:blocked};
      function Fixture(){const[panel,setPanel]=useState('settings');window.fixture={calls,forbidden,setPanel};
        return panel==='settings'?<ModsSettings threadId={null} active/>:
          <NativePluginCapabilities threadId="" workspace="" functionPluginIds={[]}/>}
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage()
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByRole("button", { name: "管理", exact: true }).click()
    await page.getByRole("button", { name: "查看流程定义", exact: true }).click()
    await page.getByText("Actual installed definition", { exact: true }).first().waitFor()
    await page.evaluate("window.fixture.setPanel('capabilities')")
    await page.getByRole("button", { name: "查看流程定义", exact: true }).click()
    await page.getByText("Actual installed definition", { exact: true }).first().waitFor()
    expect(await page.evaluate("window.fixture.calls")).toEqual([
      { pluginId: "host", expected: { name: "Host installed", version: "1" } },
      { pluginId: "host", expected: { name: "Host installed", version: "1" } }
    ])
    expect(await page.evaluate("window.fixture.forbidden")).toEqual([])
  } finally {
    await browser.close()
  }
}, 60000)
