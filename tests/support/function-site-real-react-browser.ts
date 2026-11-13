import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import type { FunctionDisplaySnapshot } from "../../src/shared/mods/v2/display-snapshot"
import type { FunctionSiteReadOutcome } from "../../src/shared/mods/v2/sites"
import type { FunctionPaneSnapshot } from "../../src/shared/mods/v2/ui"
import { mount } from "../mods-flow-browser.spec"
import { browserWorkerPlugin } from "./browser-worker-plugin.mjs"

export interface FunctionSiteFixtureOptions {
  rows?: string[]
  cache?: boolean
  cacheFirst?: boolean
  cachedSnapshot?: FunctionDisplaySnapshot
  legacyMount?: boolean
  component?: "AssistantMessage" | "CommandOutput"
  facts?: {
    text: string
    isFirstOfReply?: boolean
    command?: string
    args?: string
    isErrored?: boolean
  }
  pane: FunctionPaneSnapshot
}

export interface FunctionSiteFixtureObservation {
  reads: unknown[][]
  mounts: unknown[][]
  renders: unknown[][]
  unmounts: unknown[][]
  physicalPending: number
  cachedCurrent: boolean | null
  admissionCurrent: boolean | null
  rows: Array<{ id: string; projected: string[]; owned: string[] }>
  mutations: Array<{
    type: string
    added: string[]
    removed: string[]
    oldValue: string | null
    value: string | null
  }>
  errors: string[]
}

const source = `
  import {flushSync} from 'react-dom';
  import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
  import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
  import {FunctionSitePresentationCache,functionSitePresentationKey} from ${JSON.stringify(resolve("src/renderer/src/lib/function-site-presentation.ts"))};
  const reads=[],mounts=[],renders=[],unmounts=[],pending=[],physical=new Set(),cards=new Set(),configurations=new Set();
  const captures=[],mutations=[];let config,cache,rerender;
  const root=document.getElementById('root');
  const record=records=>{for(const item of records)mutations.push({type:item.type,
    added:[...item.addedNodes].map(node=>node.textContent??''),
    removed:[...item.removedNodes].map(node=>node.textContent??''),
    oldValue:item.oldValue,value:item.type==='characterData'?item.target.nodeValue:null})};
  const observer=new MutationObserver(record);
  observer.observe(root,{subtree:true,childList:true,characterData:true,characterDataOldValue:true});
  const track=promise=>{physical.add(promise);promise.then(()=>physical.delete(promise),()=>physical.delete(promise));return promise};
  const keyFor=row=>functionSitePresentationKey('thread',config.component,row,JSON.stringify(config.facts),innerWidth);
  function Fixture(){const [revision,setRevision]=useState(0);
    rerender=()=>flushSync(()=>setRevision(value=>value+1));
    return <ModsChatScope.Provider value={{threadId:'thread',enabled:true,ready:true,presentationCache:cache}}>
      {config.rows.map(row=><article key={row} data-row={row} style={{width:640}}><FunctionSite threadId='thread'
        component={config.component} presentationId={config.legacyMount?undefined:row}
        facts={config.facts} className={'fixture-revision-'+revision}
        renderNative={props=><span data-protected>{props.text}</span>}/></article>)}
    </ModsChatScope.Provider>
  }
  window.functionSiteFixture={
    configure:options=>{
      config={rows:['row'],cacheFirst:true,component:'AssistantMessage',
        facts:{text:'input',isFirstOfReply:true},...options};
      if(config.cache){
        cache=new FunctionSitePresentationCache(()=>true);
        const capture=cache.capture;
        cache.capture=function(...args){const proof=Reflect.apply(capture,this,args);captures.push({key:args[1],proof});return proof};
        if(config.cachedSnapshot)cache.saveData(keyFor(config.rows[0]),config.cachedSnapshot.data,200,
          cache.capture(config.component),innerWidth,config.cachedSnapshot.key);
      }
      const mods={
        siteMountOutcome:(...args)=>{mounts.push(args);return track(Promise.resolve({state:'mounted',owner:'owner'}))},
        siteRender:(...args)=>{renders.push(args);return track(Promise.resolve(config.pane))},
        siteUnmount:(...args)=>{unmounts.push(args);return track(Promise.resolve())},
        onCardsChanged:callback=>{cards.add(callback);return()=>cards.delete(callback)},
        onConfigurationChanged:callback=>{configurations.add(callback);return()=>configurations.delete(callback)}
      };
      if(!config.legacyMount)mods.siteRead=(...args)=>{reads.push(args);return track(new Promise(resolve=>pending.push({resolve,done:false})))};
      window.api.mods=mods;
      flushSync(()=>host.render(<Fixture/>));
    },
    complete:(index,outcome)=>{const item=pending[index];if(!item||item.done)throw Error('READ_NOT_PENDING');item.done=true;item.resolve(outcome)},
    notify:scope=>{
      const invalidate=()=>{if(scope?.startsWith('site-projection:'))cache?.invalidateProjection(scope.slice('site-projection:'.length))};
      if(config.cacheFirst)invalidate();for(const callback of cards)callback({threadId:'thread',scope});
      if(!config.cacheFirst)invalidate();
    },
    notifyOther:scope=>{for(const callback of cards)callback({threadId:'other',scope})},
    reset:()=>{for(const callback of configurations)callback()},
    rerender:()=>rerender(),
    retire:()=>flushSync(()=>host.render(null)),
    snapshot:()=>{
      record(observer.takeRecords());
      const captured=[...captures].reverse().find(item=>item.key===keyFor(config.rows[0]));
      return {reads,mounts,renders,unmounts,physicalPending:physical.size,
        cachedCurrent:cache?Boolean(cache.read(keyFor(config.rows[0]))):null,
        admissionCurrent:captured?captured.proof():null,
        rows:[...root.querySelectorAll('[data-row]')].map(row=>({id:row.dataset.row,
          projected:[...row.querySelectorAll('[data-function-site-projected] [data-protected]')].map(node=>node.textContent),
          owned:[...row.querySelectorAll('[data-function-plugin]')].map(node=>node.textContent)})),mutations};
    },
    dispose:async()=>{
      flushSync(()=>host.render(null));
      for(const item of pending)if(!item.done){item.done=true;item.resolve({state:'inactive'})}
      await Promise.allSettled([...physical]);
      // Cleanup-only task boundary drains actual promise continuations, including late-owner release.
      await new Promise(done=>setTimeout(done,0));
      await Promise.allSettled([...physical]);
      record(observer.takeRecords());observer.disconnect();
      if(physical.size)throw Error('FIXTURE_PHYSICAL_READ_NOT_DRAINED');
    }
  };
`

/** Real React and DOM; the only controlled boundary is the same protected IPC fixture. */
export function functionSiteBrowser() {
  let browser: Browser | undefined, page: Page | undefined, compiled: string | undefined
  let errors: string[] = []
  const launchBrowser = () =>
    chromium.launch({
      headless: true,
      ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
    })
  const active = (): Page => {
    if (!page) throw Error("FUNCTION_SITE_FIXTURE_NOT_MOUNTED")
    return page
  }
  const closeCase = async (): Promise<void> => {
    const current = page
    const currentBrowser = browser
    try {
      if (current) {
        try {
          await current.evaluate("window.functionSiteFixture.dispose()")
        } finally {
          await current.close()
          if (page === current) page = undefined
        }
      }
    } finally {
      if (currentBrowser) {
        await currentBrowser.close()
        if (browser === currentBrowser) browser = undefined
        if (page === current) page = undefined
      }
    }
  }
  return {
    async open(): Promise<void> {
      browser = await launchBrowser()
      const compiler = await browser.newPage({ viewport: { width: 800, height: 600 } })
      try {
        // One fixed source and production defines, not a cache shared across different fixtures.
        compiled = await mount(compiler, source, [browserWorkerPlugin()], false)
      } finally {
        await compiler.close()
      }
    },
    async mount(options: FunctionSiteFixtureOptions): Promise<void> {
      if (compiled === undefined || page) throw Error("FUNCTION_SITE_FIXTURE_LIFECYCLE")
      if (!browser) browser = await launchBrowser()
      page = await browser.newPage({ viewport: { width: 800, height: 600 } })
      errors = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto("about:blank")
      await page.setContent('<div id="root"></div>')
      await page.addScriptTag({ content: compiled })
      await page.evaluate<void, unknown>((options) => {
        const fixture = (
          window as typeof window & {
            functionSiteFixture: { configure(value: FunctionSiteFixtureOptions): void }
          }
        ).functionSiteFixture
        fixture.configure(options as FunctionSiteFixtureOptions)
      }, options)
    },
    async complete(index: number, outcome: FunctionSiteReadOutcome): Promise<void> {
      await active().evaluate<void, { index: number; outcome: unknown }>(
        ({ index, outcome }) => {
          ;(
            window as typeof window & {
              functionSiteFixture: {
                complete(index: number, result: FunctionSiteReadOutcome): void
              }
            }
          ).functionSiteFixture.complete(index, outcome as FunctionSiteReadOutcome)
        },
        { index, outcome }
      )
    },
    async notify(scope?: string, otherThread = false): Promise<void> {
      await active().evaluate(
        ({ scope, otherThread }) => {
          const fixture = (
            window as typeof window & {
              functionSiteFixture: {
                notify(scope?: string): void
                notifyOther(scope?: string): void
              }
            }
          ).functionSiteFixture
          if (otherThread) fixture.notifyOther(scope)
          else fixture.notify(scope)
        },
        { scope, otherThread }
      )
    },
    async notifyMany(scopes: string[]): Promise<void> {
      await active().evaluate((scopes) => {
        const fixture = (
          window as typeof window & {
            functionSiteFixture: { notify(scope: string): void }
          }
        ).functionSiteFixture
        for (const scope of scopes) fixture.notify(scope)
      }, scopes)
    },
    async reset(): Promise<void> {
      await active().evaluate("window.functionSiteFixture.reset()")
    },
    async rerender(): Promise<void> {
      await active().evaluate("window.functionSiteFixture.rerender()")
    },
    async retire(): Promise<void> {
      await active().evaluate("window.functionSiteFixture.retire()")
    },
    async snapshot(): Promise<FunctionSiteFixtureObservation> {
      const state = await active().evaluate<Omit<FunctionSiteFixtureObservation, "errors">>(
        "window.functionSiteFixture.snapshot()"
      )
      return { ...state, errors: [...errors] }
    },
    async text(): Promise<string> {
      return (await active().locator("#root").textContent()) ?? ""
    },
    closeCase,
    close: closeCase
  }
}
