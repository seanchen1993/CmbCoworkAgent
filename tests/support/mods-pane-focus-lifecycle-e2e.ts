import assert from "node:assert/strict"
import { build } from "esbuild"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import type { Page } from "playwright"

export async function verifyPaneFocusLifecycle(
  page: Page,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const root = resolve(__dirname, "../..")
  const require = createRequire(join(root, "package.json"))
  const react = JSON.stringify(require.resolve("react"))
  const component = JSON.stringify(join(root, "src/renderer/src/components/chat/FunctionPanes.tsx"))
  const result = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
        import {createRoot} from "react-dom/client";
        import {FunctionPanes} from ${component};
        const refs=new Set(), listeners=new Set(), rows=new Map(), held=new Set();
        const pending=[], calls=[], reads=[];
        window.__paneFocusRefs=refs;
        Object.defineProperty(window,"api",{value:{mods:{
          panes:async id=>{
            reads.push(id);
            if(held.has(id))await new Promise(resolve=>pending.push({id,resolve}));
            return rows.get(id)||[];
          },
          paneAct:async(id,action)=>{calls.push({id,request:action.value?.request});return {focused:false}},
          onCardsChanged:fn=>{listeners.add(fn);return ()=>listeners.delete(fn)},
          onConfigurationChanged:()=>()=>{},
          focusAck:async()=>{},scrollAck:async()=>{}
        }}});
        const host=createRoot(document.getElementById("root"));
        let current="thread-a";
        window.__paneFocusFixture={
          set(ids,requestedPending=true){
            rows.set(current,ids.map(id=>({
              key:id,id,plugin:"lifecycle",title:id,generation:"generation",rows:2,
              closeOnEscape:false,tree:{type:"Box",props:{},children:[]},
              focusRequest:{id,pending:requestedPending}
            })));
            for(const listener of listeners)listener({threadId:current});
          },
          switch(id){held.add(id);current=id;host.render(<FunctionPanes threadId={current}/>);},
          release(){held.delete(current);for(const row of pending.splice(0))row.resolve();},
          snapshot(){return {
            calls:[...calls],reads:[...reads],retained:[...refs].flatMap(ref=>[...ref.current]),
            panes:document.querySelectorAll("[data-function-pane]").length
          }},
          close(){host.unmount()}
        };
        host.render(<FunctionPanes threadId={current}/>);
      `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    target: "chrome130",
    alias: { "@": join(root, "src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "observe-pane-ref-lifetimes",
        setup(api) {
          api.onResolve({ filter: /^react$/ }, (args) =>
            args.importer.endsWith("FunctionPanes.tsx")
              ? { path: "pane-react", namespace: "pane-lifecycle" }
              : undefined
          )
          api.onLoad({ filter: /.*/, namespace: "pane-lifecycle" }, () => ({
            resolveDir: root,
            loader: "js",
            contents: `export * from ${react};import {useRef as nativeRef} from ${react};
            export function useRef(value){const ref=nativeRef(value);
              if(value instanceof Set)window.__paneFocusRefs.add(ref);return ref;}`
          }))
          // These leaves do not render in the Box-only fixture; isolate unrelated stores/workers.
          api.onResolve({ filter: /^\.\/(FunctionCode|FunctionSvg|FunctionClient)$/ }, (args) =>
            args.importer.endsWith("FunctionPanes.tsx")
              ? { path: args.path.slice(2), namespace: "pane-leaf" }
              : undefined
          )
          api.onLoad({ filter: /.*/, namespace: "pane-leaf" }, (args) => ({
            loader: "js",
            contents: `export const ${args.path}=()=>null;`
          }))
        }
      }
    ]
  })
  await page.evaluate(() => {
    const frame = document.createElement("iframe")
    frame.name = "mods-pane-lifecycle-fixture"
    frame.id = frame.name
    frame.srcdoc = '<html><body><div id="root"></div></body></html>'
    document.body.append(frame)
  })
  await until(
    async () => Boolean(page.frame("mods-pane-lifecycle-fixture")),
    "isolated renderer fixture attaches"
  )
  const frame = page.frame("mods-pane-lifecycle-fixture")!
  assert(frame)
  await frame.locator("#root").waitFor({ state: "attached" })
  try {
    await frame.evaluate(result.outputFiles[0].text)
    const snapshot = () =>
      frame.evaluate("window.__paneFocusFixture.snapshot()") as Promise<{
        calls: Array<{ id: string; request?: string }>
        reads: string[]
        retained: string[]
        panes: number
      }>
    const set = (ids: string[]) =>
      frame.evaluate(`window.__paneFocusFixture.set(${JSON.stringify(ids)})`)
    await until(
      async () => (await snapshot()).reads.includes("thread-a"),
      "real Pane effect mounts"
    )
    for (let n = 0; n < 32; n++) {
      const id = `focus-request-${n}`
      await set([id])
      await until(
        async () => (await snapshot()).calls.some((call) => call.request === id),
        "focus request attempted"
      )
      await set([id])
      await frame.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      )
      assert.equal((await snapshot()).calls.filter((call) => call.request === id).length, 1)
      await set([])
      await until(async () => (await snapshot()).panes === 0, "closed Pane leaves actual DOM")
      await frame.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      )
      assert.deepEqual(
        (await snapshot()).retained,
        [],
        "closed focus requests must leave mounted renderer collections"
      )
    }
    pass("actual Pane renderer forgets closed focus requests and deduplicates current requests")
    await set(["settled-request"])
    await until(
      async () => (await snapshot()).calls.some((call) => call.request === "settled-request"),
      "settled request was attempted"
    )
    await frame.evaluate('window.__paneFocusFixture.set(["settled-request"],false)')
    await frame.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    await set(["settled-request"])
    await frame.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    assert.equal(
      (await snapshot()).calls.filter((call) => call.request === "settled-request").length,
      1,
      "a stale pending redraw must not replay an already settled request"
    )
    await set(["scope-a"])
    await until(
      async () => (await snapshot()).calls.some((call) => call.request === "scope-a"),
      "old scope request settles"
    )
    await frame.evaluate('window.__paneFocusFixture.switch("thread-b")')
    await until(
      async () => (await snapshot()).reads.includes("thread-b"),
      "new scope waits for its snapshot"
    )
    await frame.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    assert(!(await snapshot()).calls.some((call) => call.id === "thread-b"))
    await frame.evaluate("window.__paneFocusFixture.release()")
    await until(async () => (await snapshot()).panes === 0, "new empty scope is current")
    await set(["scope-b"])
    await until(
      async () =>
        (await snapshot()).calls.some(
          (call) => call.id === "thread-b" && call.request === "scope-b"
        ),
      "new scope request"
    )
    assert(!(await snapshot()).retained.includes("scope-a"))
    pass("actual Pane effects never submit old drawing focus against a newly selected thread")
    await frame.evaluate("window.__paneFocusFixture.close()")
    assert.deepEqual((await snapshot()).retained, [], "unmount clears focus bookkeeping")
  } finally {
    await frame.evaluate("window.__paneFocusFixture?.close()")
    await page.evaluate(() => document.getElementById("mods-pane-lifecycle-fixture")?.remove())
  }
}
