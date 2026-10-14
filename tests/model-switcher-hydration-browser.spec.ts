/** Real component regression: metadata writes may lag behind local model selection. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

const root = resolve(__dirname, "..")
const renderer = join(root, "src/renderer/src")

async function main() {
  const result = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
        import {useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {ModelSwitcher} from ${JSON.stringify(join(renderer, "components/chat/ModelSwitcher.tsx"))};
        import {ScrollArea} from ${JSON.stringify(join(renderer, "components/ui/scroll-area.tsx"))};
        import {fixture} from 'fixture';
        function App(){const [id,setId]=useState('a');window.setThread=setId;return <><ScrollArea style={{height:100}}>history</ScrollArea><ModelSwitcher threadId={id}/></>}
        window.fixture=fixture;createRoot(document.getElementById('root')).render(<App/>);
      `
    },
    bundle: true,
    write: false,
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "fixture",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^fixture$|^@\/lib\/(store|thread-context|model-catalog-cache)$|^\.\/CustomModelDialog$/
            },
            (args) => ({ path: args.path, namespace: "fixture" })
          )
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => {
            if (args.path === "./CustomModelDialog")
              return { contents: "export const CustomModelDialog=()=>null" }
            if (args.path !== "fixture") return { contents: "export * from 'fixture'" }
            return {
              loader: "tsx",
              resolveDir: root,
              contents: `
            import {useSyncExternalStore} from 'react';
            const listeners=new Set();const emit=()=>{for(const fn of listeners)fn()};const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
            const models=[{id:'custom:valid',name:'Valid',model:'valid',available:true},{id:'custom:other',name:'Other',model:'other',available:true}];
            let state={models,threads:[{thread_id:'a',metadata:{model:'custom:removed'}},{thread_id:'b',metadata:{model:'custom:other'}}],loadModels:()=>{}};
            let states={a:{currentModel:''},b:{currentModel:''}};const calls=[];
            const actions=Object.fromEntries(['a','b'].map(id=>[id,{restoreCurrentModel:value=>{calls.push(['restore',id,value]);states={...states,[id]:{currentModel:value}};emit()},setCurrentModel:value=>{calls.push(['set',id,value]);states={...states,[id]:{currentModel:value}};emit()}}]));
            export const useAppStore=selector=>selector(useSyncExternalStore(subscribe,()=>state));
            export const useThreadStateSelector=(id,selector)=>selector(useSyncExternalStore(subscribe,()=>states[id]));
            export const useThreadActions=id=>actions[id];
            const catalog={routingMode:'pinned',defaultModelId:'custom:valid'};
            export const subscribeModelCatalog=subscribe,readModelCatalogCache=()=>catalog;
            export const invalidateModelCatalogCache=()=>{},updateCachedRoutingMode=()=>{};
            export const fixture={calls,current:id=>states[id].currentModel,select:(id,value)=>actions[id].setCurrentModel(value),metadata:(id,model)=>{state={...state,threads:state.threads.map(t=>t.thread_id===id?{...t,metadata:{model}}:t)};emit()}};
          `
            }
          })
          builder.onResolve({ filter: /^@\// }, (args) => ({
            path:
              resolve(renderer, args.path.slice(2)) +
              (/\.[jt]sx?$/.test(args.path)
                ? ""
                : existsSync(resolve(renderer, args.path.slice(2)) + ".tsx")
                  ? ".tsx"
                  : ".ts")
          }))
        }
      }
    ]
  })
  const browser = await chromium.launch({
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }),
    headless: true
  })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: result.outputFiles[0].text })
    await page.waitForTimeout(500)
    assert.deepEqual(errors, [], "Hydration must settle while metadata persistence is delayed")
    assert.equal(await page.evaluate("fixture.current('a')"), "custom:valid")
    assert.deepEqual(await page.evaluate("fixture.calls"), [
      ["restore", "a", "custom:removed"],
      ["set", "a", "custom:valid"]
    ])
    await page.evaluate("fixture.select('a','custom:other')")
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate("fixture.current('a')"), "custom:other")
    await page.evaluate("fixture.metadata('a','custom:valid')")
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate("fixture.current('a')"), "custom:valid")
    await page.evaluate("window.setThread('b')")
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate("fixture.current('b')"), "custom:other")
    await page.evaluate("fixture.select('a','custom:other');window.setThread('a')")
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate("fixture.current('a')"), "custom:valid")
    assert.deepEqual(errors, [])
    console.log(
      "PASS missing model fallback, delayed metadata, manual selection, metadata changes and A→B→A hydration"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
