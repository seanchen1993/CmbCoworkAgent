/** Real project/session components and navigation intent; controlled local IPC, no model/profile. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const bundled = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    loader: { ".png": "dataurl", ".md": "text" },
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env": "{}" },
    plugins: [
      {
        name: "project-navigation-store",
        setup(builder) {
          builder.onResolve({ filter: /(?:^@\/lib\/store$|^\.\/store$|\/lib\/store$)/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents: `
        import {useSyncExternalStore} from 'react';
        const listeners=new Set(),thread={thread_id:'stage-thread',title:'原项目阶段会话',status:'idle',
          created_at:new Date(0),updated_at:new Date(0),metadata:{workspacePath:'C:/original',
            hostProjectRuntime:{projectId:'original-project',operationId:'old-operation',stageId:'review',pluginDigest:'a'.repeat(64)}}};
        const state={accountRevision:0,threads:[thread],showHarnessBoardView:false,
          threadDirectoryHasMore:false,threadDirectoryLoadingMore:false,
          setShowHarnessBoardView(value){state.showHarnessBoardView=value;emit()},
          addThreadSummary(value){state.threads=[value];emit()},
          async selectThread(){state.showHarnessBoardView=false;emit()}};
        function emit(){for(const listener of listeners)listener()}
        const subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener)};
        export const useAppStore=selector=>useSyncExternalStore(subscribe,()=>selector(state));
        useAppStore.getState=()=>state;useAppStore.subscribe=subscribe;
        export const isThreadDeletionPending=()=>false;
        window.fixtureState=state;window.fixtureThread=thread;
      `
          }))
        }
      },
      browserWorkerPlugin()
    ],
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
      import React from 'react';import{createRoot}from'react-dom/client';
      import{useAppStore}from'./src/renderer/src/lib/store';
      import{LocalProjectsPanel}from'./src/renderer/src/components/harness-board/LocalProjectsPanel';
      import{ProjectRunDetails}from'./src/renderer/src/components/chat/ProjectRunDetails';
      const calls=[];window.fixtureCalls=calls;
      let changedWorkspace=false;window.changeProjectWorkspace=value=>changedWorkspace=value;
      const project={projectId:'original-project',name:'原项目',workspace:'C:/original',goal:'复核历史',
        version:1,stageIndex:0,pluginDigest:'b'.repeat(64),packageVersion:'2.0.0',status:'active',
        manifest:{stages:[{id:'review',title:'原项目阶段',skill:'review',artifactIds:[],checkIds:[],approval:'none'}],
          artifacts:[],checks:[],actions:[],environment:[]}};
      const operation={operationId:'old-operation',expectedVersion:1,stageId:'review',pluginDigest:'a'.repeat(64),
        status:'failed',createdAt:1,updatedAt:2,startedAt:1,execution:{threadId:'stage-thread'},receipts:[]};
      window.api={threads:{get:async id=>{calls.push(['thread',id]);return structuredClone(window.fixtureThread)}},
        harnessBoard:{localProjects:{templates:async()=>[],list:async()=>[],
          get:async id=>{calls.push(['project',id]);return {project:{...project,
            workspace:changedWorkspace?'C:/foreign':project.workspace},operations:[operation]}},
          mods:{read:async()=>({projectId:'original-project',projectVersion:1,packageDigest:'b'.repeat(64),
            workspace:'C:/original',workspaceEnabled:true,globallyEnabled:true})},
          create:async()=>{throw Error('UNEXPECTED_CREATE')},command:async()=>{throw Error('UNEXPECTED_EXECUTION')}}}};
      function Fixture(){const board=useAppStore(state=>state.showHarnessBoardView);
        return board?<LocalProjectsPanel/>:<><p>原项目阶段会话 · 只读</p><ProjectRunDetails threadId='stage-thread' workspace='C:/original'/></>}
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
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("http://127.0.0.1:47779/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<html><body><div id="root"></div></body></html>'
      })
    )
    await page.goto("http://127.0.0.1:47779/")
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    await page.getByRole("button", { name: "返回项目任务", exact: true }).click()
    await page.getByText("当前：原项目阶段", { exact: true }).waitFor()
    assert(
      (await page.evaluate<Array<[string, string]>>("window.fixtureCalls")).some(
        ([kind, id]) => kind === "project" && id === "original-project"
      )
    )
    const openHistory = async () => {
      const summary = page.getByText("检查结果与历史", { exact: true })
      if (
        !(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open))
      )
        await summary.click()
    }
    await openHistory()
    await page.getByRole("button", { name: "查看本次会话", exact: true }).click()
    await page.getByText("原项目阶段会话 · 只读", { exact: true }).waitFor()
    await page.getByRole("button", { name: "返回项目任务", exact: true }).click()
    await page.getByText("当前：原项目阶段", { exact: true }).waitFor()
    await openHistory()
    await page.getByRole("button", { name: "查看本次会话", exact: true }).click()
    await page.evaluate("window.changeProjectWorkspace(true)")
    await page.getByRole("button", { name: "返回项目任务", exact: true }).click()
    await page
      .getByRole("alert")
      .getByText(/原阶段会话或项目目录已变化/)
      .waitFor()
    assert.equal(await page.getByText("当前：原项目阶段", { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
    console.log(
      "PASS Host stage session returns to its bound project across remounts and migrations"
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
