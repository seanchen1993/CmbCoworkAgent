/** A restored oversized estimate must be measured before its first visible paint. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium, type Page } from "playwright"
import type { StateSnapshot, VirtuosoHandle } from "react-virtuoso"

interface RowSample { index: number; known: number; top: number; bottom: number; height: number }
interface Sample { label: string; at: number; top: number; visible: number; rows: RowSample[] }
type FixtureWindow = typeof window & {
  config: { restore: StateSnapshot; controlledCheckpoint: boolean; aggregate: boolean }
  readonly layout?: { readonly rangeTask?: object | null }
  fixture: { handle: { current: VirtuosoHandle | null }; viewport(): HTMLElement; releaseCheckpoint(): void }
  samples: Sample[]
  stopSamples: boolean
  stats: { arm: boolean; qualifiers: { oldFirst: number | null; newFirst: number | null;
    retained: number[]; visible: number }[]; commits: number; refreshes: number; held: number; released: number; wheels: { pending: boolean; at: number }[] }
}
const output = resolve(process.env.CHAT_VIRTUAL_RANGE_COMMIT_OUTPUT_DIR ??
  "output/chat-virtual-range-commit-browser")
const source = `
import React,{useState,useLayoutEffect,useRef}from'react';
import{createRoot}from'react-dom/client';
import{Virtuoso}from'react-virtuoso';
import{CHAT_VIRTUAL_OVERSCAN}from'./src/renderer/src/components/chat/chat-virtual-overscan';
import{ChatVirtualPrependLayout}from'./src/renderer/src/components/chat/chat-virtual-prepend-layout';
class TraceList extends ChatVirtualPrependLayout{
 constructor(props){super(props);window.layout=this}
 getSnapshotBeforeUpdate(previous){
  const snapshot=super.getSnapshotBeforeUpdate(previous);
  if(window.config.aggregate&&window.stats.arm&&!window.stats.qualifiers.length){
   const pairs=props=>React.Children.toArray(props.children).map(child=>({key:child.key,index:child.props?.['data-index']}));
   const old=pairs(previous),next=pairs(this.props);
   if(old.length!==next.length||old.some((item,i)=>item.key!==next[i]?.key||item.index!==next[i]?.index)){
    const retained=old.filter(a=>next.some(b=>a.key===b.key&&a.index===b.index));
    const bounds=window.fixture.viewport().getBoundingClientRect();
    const visible=[...this.root.querySelectorAll('[data-chat-search-text]')].filter(body=>{
     const range=document.createRange();range.selectNodeContents(body);const rect=range.getBoundingClientRect();
     return rect.height>0&&rect.bottom>bounds.top&&rect.top<bounds.bottom&&rect.right>bounds.left&&rect.left<bounds.right;
    }).length;
    window.stats.qualifiers.push({oldFirst:old[0]?.index??null,newFirst:next[0]?.index??null,retained:retained.map(x=>x.index),visible});
   }
  }
  return snapshot;
 }
 componentDidUpdate(...args){window.stats.commits++;super.componentDidUpdate(...args)}
}
window.addEventListener('wheel',()=>window.stats.wheels.push({pending:!!window.layout?.rangeTask,at:performance.now()}),{capture:true});
// This case deliberately delays only the exact class checkpoint, never native RO or other RAFs.
let releaseCheckpoint=()=>{};
if(window.config.controlledCheckpoint){
 const request=window.requestAnimationFrame;let held=null,used=false;
 window.requestAnimationFrame=function(callback){
  const task=window.layout?.rangeTask;let id;
  id=request.call(window,function(timestamp){
   if(!used&&task&&task===window.layout?.rangeTask&&task.frame===id){
    used=true;held={callback,timestamp};window.stats.held++;return;
   }
   callback.call(window,timestamp);
  });return id;
 };
 releaseCheckpoint=()=>{const original=held;held=null;
  try{if(original){window.stats.released++;original.callback.call(window,original.timestamp)}}
  finally{window.requestAnimationFrame=request}
 };
}
const List=React.forwardRef((props,ref)=><TraceList {...props} forwardedRef={ref}/>),components={List};
function Fixture(){const[parent,setParent]=useState(null),handle=useRef(null),root=useRef(null);
 useLayoutEffect(()=>setParent(root.current),[]);
 window.fixture={handle,viewport:()=>root.current,releaseCheckpoint};
 return <div ref={root} style={{height:420,width:500,overflow:'auto',overflowAnchor:'none'}}>
 {parent&&<Virtuoso ref={handle} data={Array.from({length:44},(_,i)=>i)}
 alignToBottom initialTopMostItemIndex={{index:2,align:'start',offset:1437.65625}}
 restoreStateFrom={window.config.restore} followOutput={false}
 skipAnimationFrameInResizeObserver={false} increaseViewportBy={CHAT_VIRTUAL_OVERSCAN}
 itemSize={(element,field)=>element.getBoundingClientRect()[field==='offsetWidth'?'width':'height']}
 customScrollParent={parent} components={components}
 context={{windowKey:'controlled-cache-remount',firstItemIndex:0,scrollParent:parent,virtuosoRef:handle}}
 itemContent={i=><div data-chat-message-row data-chat-message-id={'row-'+i}
 style={{height:i===43?23001.84375:i===0?360.5:i%2?391.75:387.890625}}>
 <span data-chat-search-text>Readable row {i}</span></div>}/>}
 </div>
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`
async function main(): Promise<void> {
mkdirSync(output, { recursive: true })
const bundle = await build({ stdin: { contents: source, loader: "tsx", resolveDir: process.cwd() },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' } })
const browser = await chromium.launch({ headless: true,
  ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
const errors: string[] = [], evidence: Record<string, unknown> = {}
let cleanupPage: Page | undefined
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } })
  cleanupPage = page
  page.on("pageerror", error => errors.push(error.message))
  for (const mode of ["single", "controlled", "aggregate"] as const) {
  const doubleWheel = mode === "controlled", aggregate = mode === "aggregate"
  const multipleWheels = doubleWheel || aggregate
  await page.goto("about:blank")
  await page.addScriptTag({ content: "window.__name = value => value" })
  await page.setContent('<style>body{margin:0}</style><div id="root"></div>')
  // Each size comes from actual DOM. Only row 1 retains the real tall probe's estimate.
  // This public restore-cache precondition is not a claim about first-ever mounting.
  const sizes = await page.evaluate(() => {
    const element = document.createElement("div")
    document.body.append(element)
    try { return Array.from({ length: 44 }, (_, i) => {
      element.style.height = (i === 43 ? 23001.84375 : i === 0 ? 360.5 :
        i % 2 ? 391.75 : 387.890625) + "px"
      return element.getBoundingClientRect().height
    }) } finally { element.remove() }
  })
  const restore: StateSnapshot = { scrollTop: 24800,
    ranges: sizes.map((size, index) => ({ startIndex: index, endIndex: index,
      size: index === 1 ? sizes[43] : size })) }
  await page.evaluate(config => {
    const fixture = window as FixtureWindow
    fixture.config = config
    fixture.stats = { commits: 0, refreshes: 0, held: 0, released: 0, wheels: [], arm: false, qualifiers: [] }
  }, { restore, controlledCheckpoint: doubleWheel, aggregate })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.waitForFunction(() => Boolean((window as FixtureWindow).fixture?.handle.current))
  await page.evaluate(async () => {
    for (let i = 0; i < 8; i++) await new Promise<void>(done => requestAnimationFrame(() => done()))
    const fixture = window as FixtureWindow
    fixture.fixture.handle.current!.cancelScrollToIndex()
    const handle = fixture.fixture.handle.current!, refresh = handle.refreshItemSizes.bind(handle)
    handle.refreshItemSizes = () => { fixture.stats.refreshes++; refresh() }
  })
  const before = await page.evaluate(async () => {
    const { fixture } = window as FixtureWindow, viewport = fixture.viewport()
    const rows = [...viewport.querySelectorAll<HTMLElement>("[data-known-size]")].map(element => ({
      index: Number(element.dataset.index), known: Number(element.dataset.knownSize) }))
    const state = await new Promise<StateSnapshot>(done => fixture.handle.current!.getState(done))
    const observed = window as FixtureWindow
    return { top: viewport.scrollTop, rows, state, phase: {
      held: observed.stats.held, refreshes: observed.stats.refreshes,
      pending: Boolean(observed.layout?.rangeTask) } }
  })
  evidence[aggregate ? "aggregateBefore" : doubleWheel ? "doubleBefore" : "before"] = before
  // Refresh instrumentation starts after priming; this is the observation-window baseline.
  assert.deepEqual(before.phase, { held: 0, refreshes: 0, pending: false })
  assert.equal(before.top, 24800)
  assert.deepEqual([before.rows[0]?.index, before.rows.at(-1)?.index], [2, 9])
  assert(!before.rows.some(row => row.index === 1))
  assert(before.state.ranges.some(range => range.startIndex <= 1 && range.endIndex >= 1 &&
    range.size === 23001.84375))
  assert.equal(sizes[1], 391.75)
  await page.evaluate(() => {
    const fixture = window as FixtureWindow
    fixture.stats.arm = true
    fixture.samples = []
    fixture.stopSamples = false
    const read = (label: string) => {
      const viewport = fixture.fixture.viewport(), bounds = viewport.getBoundingClientRect()
      const rows = [...viewport.querySelectorAll<HTMLElement>("[data-known-size]")].map(element => {
        const rect = element.getBoundingClientRect()
        return { index: Number(element.dataset.index), known: Number(element.dataset.knownSize),
          top: rect.top - bounds.top, bottom: rect.bottom - bounds.top, height: rect.height }
      })
      const visible = [...viewport.querySelectorAll<HTMLElement>("[data-chat-search-text]")]
        .filter(element => { const range = document.createRange(); range.selectNodeContents(element)
          const rect = range.getBoundingClientRect()
          return rect.bottom > bounds.top && rect.top < bounds.bottom }).length
      fixture.samples.push({ label, at: performance.now(), top: viewport.scrollTop, rows, visible })
    }
    fixture.fixture.viewport().addEventListener("scroll", () => read("scroll"))
    let count = 0
    const paint = () => { read("paint-" + count++)
      if (!fixture.stopSamples) requestAnimationFrame(() => setTimeout(paint, 0)) }
    requestAnimationFrame(() => setTimeout(paint, 0))
  })
  await page.mouse.move(240, 200)
  if (aggregate) {
    const session = await page.context().newCDPSession(page)
    try { await Promise.all([0, 1].map(() => session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: 240, y: 200, deltaX: 0, deltaY: -1050 })))
    } finally { await session.detach() }
  } else await page.mouse.wheel(0, -1050)
  if (doubleWheel) {
    // Controlled late-checkpoint coverage, independent of the natural single-wheel case.
    // The first wheel's actual post-paint sample must exist before the next real input.
    await page.waitForFunction(() => {
      const fixture = window as FixtureWindow, first = fixture.stats.wheels[0]
      return fixture.stats.held === 1 && first && fixture.samples.some(sample =>
        sample.label.startsWith("paint-") && sample.at > first.at && sample.top === 1140 &&
        sample.visible > 0)
    })
    const session = await page.context().newCDPSession(page)
    try { await session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: 240, y: 200, deltaX: 0, deltaY: -1050 })
    } finally { await session.detach() }
  }
  await page.evaluate(async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>(done => requestAnimationFrame(() => done()))
    ;(window as FixtureWindow).stopSamples = true
  })
  const result = await page.evaluate(() => {
    const fixture = window as FixtureWindow
    return { samples: fixture.samples, stats: fixture.stats }
  })
  evidence[aggregate ? "aggregateResult" : doubleWheel ? "doubleResult" : "result"] = result
  if (doubleWheel) {
    assert.equal(result.stats.wheels.length, 2)
    assert(result.stats.wheels[1].pending,
      "the second real wheel must arrive before the first transaction checkpoint")
  }
  if (aggregate) {
    assert.equal(result.stats.wheels.length, 2)
    const qualification = result.stats.qualifiers[0]
    assert(qualification && qualification.newFirst !== null && qualification.oldFirst !== null &&
      qualification.newFirst < qualification.oldFirst && qualification.retained.length > 0,
    "aggregated real inputs must materialize a leading retained-pair range")
    assert.equal(qualification.visible, 0,
      "the first range commit must have no precommit visible text")
  }
  assert(result.samples.every(sample => sample.visible > 0),
    "cached oversized range must preserve readable text immediately and at its first paint")
  assert.equal(result.stats.refreshes, 1)
  const final = result.samples.at(-1)!
  assert(final.top > 0, "a jump to the first item cannot qualify as preserving the reader")
  const anchor = final.rows.find(row => row.index === 3)
  assert(anchor && Math.abs(anchor.top - (multipleWheels ? 1050.234375 : 0.234375)) <= 0.5, "the same row must retain its wheel target")
  if (aggregate) assert.equal(final.top, 90)
  assert.equal(errors.length, 0)
    if (doubleWheel) {
    const released = await page.evaluate(() => {
      const fixture = window as FixtureWindow
      fixture.fixture.releaseCheckpoint()
      return fixture.stats.released
    })
    assert.equal(released, 1)
  }
  console.log("PASS restored range commit: first paint readable, one refresh, same row and offset",
    { scope: aggregate ? "natural aggregated two real wheels" :
      doubleWheel ? "controlled late checkpoint with two real wheels" : "natural single wheel" })
  }
} finally {
  try {
    if (cleanupPage) evidence.cleanup = await cleanupPage.evaluate(() => {
      const fixture = window as FixtureWindow
      fixture.fixture?.releaseCheckpoint()
      return fixture.stats
    })
  } finally {
    try { writeFileSync(resolve(output, "evidence.json"), JSON.stringify({ evidence, errors }, null, 2))
    } finally { await browser.close() }
  }
}

}
main().catch(error => { console.error(error); process.exitCode = 1 })
