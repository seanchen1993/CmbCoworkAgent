import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { chromium } from "playwright"

// Direct installed bundles; no runtime rewriting or test-only native method injection.
const contents = `
import React,{useState,useLayoutEffect,useRef}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{Virtuoso,TableVirtuoso}from'react-virtuoso';
const config=window.boundaryConfig,axis=config.horizontal?'width':'height',position=config.horizontal?'scrollLeft':'scrollTop';
let viewport,handle,currentRange,extra=0,logs=[],measures=[],active=false,currentKey=0,currentItemFn;
const data=Array.from({length:100},(_,index)=>({id:index})),heights=new Map([[23,2400]]),widths=new Map();
const readSize=(element,field)=>{const value=Math.round(element.getBoundingClientRect()[axis])+extra;if(active)measures.push({index:element.dataset.index,field,value});return value};
function snapshot(kind){let state;handle?.getState(value=>state=value);const bounds=viewport.getBoundingClientRect();const list=viewport.querySelector('[data-testid="virtuoso-item-list"]');const entry={kind,at:performance.now(),physical:viewport[position],width:viewport.clientWidth,height:viewport.clientHeight,range:currentRange,state,listStyle:list?.getAttribute('style'),rows:[...viewport.querySelectorAll('[data-index]')].map(item=>{const rect=item.getBoundingClientRect();return{index:+item.dataset.index,id:item.querySelector('[data-row]')?.dataset.row,known:+item.dataset.knownSize,actual:Math.round(rect[axis]),offset:config.horizontal?rect.left-bounds.left:rect.top-bounds.top}})};logs.push(entry);return entry}
function App(){const[parent,setParent]=useState(null),[key,setKey]=useState(0),[show,setShow]=useState(true),[revision,setRevision]=useState(0),ref=useRef(null);
 useLayoutEffect(()=>{viewport=ref.current;setParent(viewport)},[]);
 window.reconfigure=()=>{extra=23;flushSync(()=>setRevision(n=>n+1))};window.unmountList=()=>flushSync(()=>setShow(false));window.mountList=()=>flushSync(()=>{setKey(n=>n+1);setShow(true)});
 const itemSize=revision===0?readSize:(el,field)=>{const value=readSize(el,field)+17;if(active)measures.at(-1).value=value;return value};currentItemFn=itemSize;
 const Component=config.table?TableVirtuoso:Virtuoso;
 return <div ref={ref} style={{height:400,width:650,overflow:'auto',overflowAnchor:'none'}}>{parent&&show&&<Component key={key} ref={h=>handle=h} data={data} customScrollParent={parent} firstItemIndex={10000} initialTopMostItemIndex={{index:20,align:'start'}} horizontalDirection={config.horizontal} itemSize={itemSize} skipAnimationFrameInResizeObserver increaseViewportBy={{top:1200,bottom:1200}} followOutput={false} rangeChanged={range=>{currentRange=range;if(active)snapshot('range')}} computeItemKey={(_,row)=>row.id} itemContent={(_index,row)=>config.table?<td style={{padding:0}}><div data-row={row.id} style={{height:heights.get(row.id)??100}}>{row.id}</div></td>:<div data-row={row.id} style={{width:widths.get(row.id)??(config.horizontal?140:'100%'),height:heights.get(row.id)??100}}>{row.id}</div>}/>}</div>
}
const settle=async()=>{for(let i=0;i<3;i++)await new Promise(done=>requestAnimationFrame(()=>setTimeout(done,0)))};
createRoot(document.getElementById('root')).render(<App/>);
window.fixture={async prepare(){await settle();handle.scrollToIndex({index:20,align:'start',behavior:'auto'});await new Promise(done=>setTimeout(done,180));handle.cancelScrollToIndex();await settle()},async run(kind){logs=[];measures=[];active=true;const owner={};handle.setExternalScrollAnchor({owner,active:true});snapshot('before');
 if(kind==='custom'||kind==='horizontal'||kind==='table'){
  const row=viewport.querySelector('[data-row="20"]')??viewport.querySelector('[data-row]');const changedIndex=Number(row.dataset.row);extra=11;if(config.horizontal){widths.set(changedIndex,205);row.style.width='205px'}else{heights.set(changedIndex,175);row.style.height='175px'};
  if(config.horizontal)viewport.scrollLeft=130;snapshot('mutated');handle.refreshItemSizes();snapshot('returned');await settle();snapshot('settled');
 }else if(kind==='balanced'){
  const anchor=viewport.querySelector('[data-row="20"]'); const offset=anchor.getBoundingClientRect().top-viewport.getBoundingClientRect().top;
  for(const [id,height] of [[19,2300],[23,200]]){heights.set(id,height);viewport.querySelector('[data-row="'+id+'"]').style.height=height+'px'}
  snapshot('mutated');handle.refreshItemSizes();handle.cancelScrollToIndex();
  viewport.scrollTop+=anchor.getBoundingClientRect().top-viewport.getBoundingClientRect().top-offset;
  snapshot('returned');await settle();snapshot('settled');
 }else if(kind==='resize-scroll'){
  viewport.style.height='650px';viewport.style.width='420px';const row=viewport.querySelector('[data-row="19"]');heights.set(19,180);row.style.height='180px';viewport.scrollTop+=130;
  snapshot('mutated');handle.refreshItemSizes();snapshot('returned');await settle();snapshot('settled');
 }else if(kind==='lifecycle'){
  const old=handle;window.reconfigure();measures=[];old.refreshItemSizes();snapshot('updated-callback');const afterUpdate=[...measures];window.unmountList();measures=[];old.refreshItemSizes();const afterUnmount=[...measures];window.mountList();await settle();await settle();const replacement=handle;replacement.cancelScrollToIndex();await settle();measures=[];old.refreshItemSizes();const afterRemountOld=[...measures];replacement.refreshItemSizes();snapshot('new-handle');return{kind,logs,afterUpdate,afterUnmount,afterRemountOld,newMeasures:measures};
 }active=false;handle?.setExternalScrollAnchor({owner,active:false});return{kind,logs,measures};}}`

export async function runNativeRefreshBrowserRegression() {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const bundle = await build({
    stdin: { contents, resolveDir: repository, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    for (const kind of [
      "custom",
      "horizontal",
      "balanced",
      "resize-scroll",
      "lifecycle",
      "table"
    ]) {
      const page = await browser.newPage()
      try {
        const errors = []
        page.on("pageerror", (error) => errors.push(String(error)))
        await page.setContent('<html><style>body{margin:0}</style><div id="root"></div></html>')
        await page.evaluate(
          (config) => {
            window.boundaryConfig = config
          },
          {
            horizontal: kind === "horizontal",
            table: kind === "table"
          }
        )
        await page.addScriptTag({ content: bundle.outputFiles[0].text })
        await page.waitForFunction('window.fixture && document.querySelector("[data-index]")')
        await page.evaluate("window.fixture.prepare()")
        const result = await page.evaluate((kind) => window.fixture.run(kind), kind)
        assert.deepEqual(errors, [], `${kind}: no browser errors`)
        if (kind === "lifecycle") {
          assert(
            result.afterUpdate.some((entry) => entry.value === 140),
            "Old handle uses the current itemSize callback"
          )
          assert.deepEqual(result.afterUnmount, [])
          assert.deepEqual(
            result.afterRemountOld,
            [],
            "Old unmounted handle cannot measure the replacement"
          )
          assert(result.newMeasures.length > 0)
          continue
        }
        const before = result.logs.find((entry) => entry.kind === "before")
        const returned = result.logs.find((entry) => entry.kind === "returned")
        const settled = result.logs.find((entry) => entry.kind === "settled")
        if (kind === "resize-scroll" || kind === "horizontal")
          assert.equal(
            returned.state.scrollTop,
            returned.physical,
            `${kind}: refresh reads current scroll state`
          )
        if (kind === "balanced") {
          assert.equal(settled.height, before.height, "Balanced changes retain total list height")
          const oldRow = before.rows.find((row) => row.id === "20")
          const nextRow = settled.rows.find((row) => row.id === "20")
          assert(nextRow, "Balanced changes must not recycle the preserved readable row")
          assert(Math.abs(nextRow.offset - oldRow.offset) <= 2)
        } else if (kind !== "resize-scroll") {
          const expected = kind === "horizontal" ? 216 : 186
          const sample = result.measures.find((entry) => entry.value === expected)
          assert(sample, `${kind}: native itemSize measures the changed mounted row`)
          const index = Number(sample.index)
          const row = before.rows.find((row) => row.index === index)
          assert(row)
          assert.equal(
            row.index,
            Number(row.id),
            "Measurement indices stay data-relative with firstItemIndex=10000"
          )
          const measured = returned.state.ranges.find(
            (range) => range.startIndex <= index && range.endIndex >= index
          )
          assert(measured, `${kind}: refreshed size is present in the native snapshot`)
          assert.equal(
            measured.size,
            expected,
            `${kind}: current native custom itemSize is respected`
          )
          assert(
            result.measures.some(
              (entry) => entry.field === (kind === "horizontal" ? "offsetWidth" : "offsetHeight")
            )
          )
        }
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
}
