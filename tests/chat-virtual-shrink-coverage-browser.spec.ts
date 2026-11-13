/** Native vertical alignment must never turn stale sizes into an offscreen list. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium, type Page } from "playwright"
import type { VirtuosoHandle } from "react-virtuoso"

interface FixtureConfiguration {
  mode: "element" | "window" | "custom"
  short?: boolean
  count?: number
  align?: boolean
  header?: number
  footer?: number
  table?: boolean
  horizontal?: boolean
  height?: number
}

interface ShortResizeResult {
  marginTop: string
  heights: number[]
  known: number[]
}

type FixtureWindow = typeof window & {
  config: FixtureConfiguration
  fixture: {
    handle: { current: Pick<VirtuosoHandle,
      "refreshItemSizes" | "cancelScrollToIndex" | "setExternalScrollAnchor"> | null }
    height(value: number): void
    shrink(): void
    own(active: boolean): void
    shortHeight(value: number): ShortResizeResult
    viewport(): HTMLElement
  }
}

interface ViewportBounds {
  top: number
  bottom: number
  left: number
  right: number
  toJSON?(): ViewportBounds
}

interface BodyRect {
  id: string | null
  top: number
  bottom: number
  left: number
  right: number
}

interface LayoutSample {
  label: string
  top: number
  viewport: ViewportBounds
  visible: number
  bodies: BodyRect[]
  style: string | null | undefined
  marginTop: string | null
  inlineMarginTop: string | undefined
  inlineMarginStart: string | undefined
  listTop: number | undefined
}

const output = resolve(process.env.CHAT_VIRTUAL_SHRINK_OUTPUT_DIR ??
  "output/chat-virtual-shrink-coverage-browser")
const source = `
import React,{useState,useLayoutEffect,useRef}from'react';
import{createRoot}from'react-dom/client';
import{flushSync}from'react-dom';
import{Virtuoso,TableVirtuoso}from'react-virtuoso';
import{CHAT_VIRTUAL_OVERSCAN}from'./src/renderer/src/components/chat/chat-virtual-overscan';
const config=window.config,owner={},data=Array.from({length:config.count??30},(_,i)=>i);
const Header=()=>config.header?<div data-header style={{height:config.header,width:config.horizontal?80:'100%'}}>Header</div>:null;
const Footer=()=>config.footer?<div data-footer style={{height:config.footer,width:config.horizontal?80:'100%'}}>Footer</div>:null;
const components={Header,Footer};
function Fixture(){const[parent,setParent]=useState(null),[height,setHeight]=useState(config.height??500),handle=useRef(null),root=useRef(null);
 useLayoutEffect(()=>{setParent(root.current)},[]);
 window.fixture={handle,height:setHeight,shrink:()=>root.current.style.setProperty('--giant','391.75px'),
   own:active=>handle.current.setExternalScrollAnchor({owner,active}),
   shortHeight:value=>{root.current.style.setProperty('--short-height',value+'px');
     flushSync(()=>handle.current.refreshItemSizes());
     const list=document.querySelector('[data-testid="virtuoso-item-list"]');
     return {marginTop:list.style.marginTop,heights:[...root.current.querySelectorAll('[data-body]')].map(el=>el.getBoundingClientRect().height),
       known:[...root.current.querySelectorAll('[data-known-size]')].map(el=>Number(el.dataset.knownSize))}},
   viewport:()=>config.mode==='window'?document.scrollingElement:config.mode==='element'?document.querySelector('[data-virtuoso-scroller]'):root.current};
 const body=i=><div data-body={i} style={config.horizontal?{height:80,width:100}:{height:config.short?'var(--short-height)':i===3?'var(--giant)':'391.75px'}}>Readable {i}</div>;
 const props={ref:handle,data,alignToBottom:config.align!==false,initialTopMostItemIndex:{index:0,align:'start'},
   followOutput:false,skipAnimationFrameInResizeObserver:false,increaseViewportBy:CHAT_VIRTUAL_OVERSCAN,
   itemSize:(element,field)=>element.getBoundingClientRect()[field==='offsetWidth'?'width':'height'],
   useWindowScroll:config.mode==='window',customScrollParent:config.mode==='custom'?parent:undefined,
   style:config.mode==='element'?{height,width:500}:undefined};
 return <div ref={root} data-outer style={{'--giant':'9751.21875px','--short-height':'80px',overflow:config.mode==='custom'?'auto':undefined,
   overflowAnchor:'none',height:config.mode==='custom'?height:undefined,width:500}}>
 {config.table?<TableVirtuoso {...props} fixedHeaderContent={()=> <tr><th style={{height:200}}>Fixed header</th></tr>}
   fixedFooterContent={()=> <tr><td style={{height:200}}>Fixed footer</td></tr>}
   itemContent={i=><td>{body(i)}</td>}/>:
   <Virtuoso {...props} components={components} horizontalDirection={!!config.horizontal} itemContent={body}/>}
 </div>
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`

const frames = (page: Page, count = 8) => page.evaluate(async n => {
  for (let i = 0; i < n; i++) await new Promise<void>(done => requestAnimationFrame(() => done()))
}, count)

async function sample(page: Page, count: number, shrink = false) {
  return page.evaluate(async ({ count, shrink }) => {
    const fixture = (window as FixtureWindow).fixture, samples: LayoutSample[] = []
    const read = (label: string) => {
      const viewport = fixture.viewport(), windowMode = (window as FixtureWindow).config.mode === "window"
      const rect: ViewportBounds = windowMode ? { top: 0, bottom: innerHeight, left: 0, right: innerWidth } :
        viewport.getBoundingClientRect()
      const list = document.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement
      const bodies = [...document.querySelectorAll("[data-body]")].map(node => {
        const r = node.getBoundingClientRect()
        return { id: node.getAttribute("data-body"), top: r.top, bottom: r.bottom, left: r.left, right: r.right }
      })
      samples.push({ label, top: viewport.scrollTop, viewport: rect.toJSON?.() ?? rect,
        visible: bodies.filter(r => r.bottom > rect.top && r.top < rect.bottom &&
          r.right > rect.left && r.left < rect.right).length,
        bodies, style: list?.getAttribute("style"), marginTop: list && getComputedStyle(list).marginTop,
        inlineMarginTop: list?.style.marginTop, inlineMarginStart: list?.style.marginInlineStart,
        listTop: list?.getBoundingClientRect().top })
    }
    if (shrink) { fixture.shrink(); read("immediate-shrink") }
    for (let i = 0; i < count; i++) {
      await new Promise<void>(done => requestAnimationFrame(() => setTimeout(done, 0)))
      read("paint-" + i)
    }
    return samples
  }, { count, shrink })
}

async function main() {
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } })
  const evidence: unknown[] = [], failures: string[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    for (const format of ["mjs", "cjs"]) {
      const bundle = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "tsx" },
        bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
        alias: { "react-virtuoso": resolve(`node_modules/react-virtuoso/dist/index.${format}`) },
        define: { "process.env.NODE_ENV": '"production"' } })
      const mount = async (config: FixtureConfiguration) => {
        await page.goto("about:blank")
        await page.setContent('<style>body{margin:0}table{border-spacing:0}td,th{padding:0}</style><div id="root"></div>')
        await page.evaluate(value => { (window as FixtureWindow).config = value }, config)
        await page.addScriptTag({ content: "window.__name=value=>value;" + bundle.outputFiles[0].text })
        await page.waitForFunction("!!window.fixture?.handle.current")
        await frames(page, 12)
        await page.evaluate("window.fixture.handle.current.cancelScrollToIndex?.()")
      }
      const check = async (name: string, run: () => Promise<void>) => {
        try { await run(); console.log(`PASS ${format} ${name}`) }
        catch (error) { failures.push(`${format} ${name}: ${String(error)}`) }
      }
      for (const align of [true, false]) await check(`short align=${align}`, async () => {
        await mount({ mode: "element", short: true, count: 2, align })
        const samples = await sample(page, 2), last = samples.at(-1)!
        evidence.push({ format, name: "short", align, samples })
        assert(last.visible > 0)
        if (align) assert(Math.abs(last.bodies.at(-1)!.bottom - last.viewport.bottom) < 1)
        else assert(Math.abs(last.bodies[0].top - last.viewport.top) < 1)
      })
      for (const height of [300, 250]) await check(`same-task short grows to total ${height * 2}`, async () => {
        await mount({ mode: "element", short: true, count: 2 })
        const before = (await sample(page, 1))[0]
        assert(Math.abs(before.bodies.at(-1)!.bottom - before.viewport.bottom) < 1)
        assert.equal(before.inlineMarginTop, "auto")
        const result = await page.evaluate(value => (window as FixtureWindow).fixture.shortHeight(value), height)
        evidence.push({ format, name: "same-task-short-growth", height, before, result })
        assert.deepEqual(result.heights, [height, height])
        assert.deepEqual(result.known, [height, height], "Public refresh synchronously publishes the actual body sizes")
        assert(["0", "0px"].includes(result.marginTop), "Overflow and exact equality must disable auto in the same task")
        assert((await sample(page, 1))[0].visible > 0)
      })
      for (const mode of ["custom", "window"] as const) await check(`short ${mode} original behavior`, async () => {
        await mount({ mode, short: true, count: 2 })
        const samples = await sample(page, 2)
        evidence.push({ format, name: "short-original-control", mode, samples })
        assert(samples.every(s => s.visible > 0 && s.inlineMarginTop === "auto"))
      })
      await check("header/footer overflow", async () => {
        await mount({ mode: "custom", short: true, count: 2, header: 210, footer: 210 })
        const samples = await sample(page, 2)
        evidence.push({ format, name: "header-footer", samples })
        assert(samples.every(s => s.visible > 0 && parseFloat(s.marginTop!) === 0))
      })
      await check("fixed table header/footer unchanged", async () => {
        await mount({ mode: "element", table: true, short: true, count: 2 })
        assert.equal(await page.locator("thead").count(), 1)
        assert.equal(await page.locator("tfoot").count(), 1)
        assert((await sample(page, 2)).every(s => s.visible > 0))
      })
      await check("zero viewport then resize short/overflow", async () => {
        await mount({ mode: "element", short: true, count: 2, height: 0 })
        await page.evaluate("window.fixture.height(500)"); await frames(page)
        let last = (await sample(page, 1))[0]
        assert(Math.abs(last.bodies.at(-1)!.bottom - last.viewport.bottom) < 1)
        await page.evaluate("window.fixture.height(100)"); await frames(page)
        last = (await sample(page, 1))[0]
        assert(last.visible > 0 && parseFloat(last.marginTop!) === 0)
        await page.evaluate("window.fixture.height(500)"); await frames(page)
        last = (await sample(page, 1))[0]
        assert(Math.abs(last.bodies.at(-1)!.bottom - last.viewport.bottom) < 1)
      })
      await check("horizontal high-header/footer keeps original auto alignment", async () => {
        await mount({ mode: "element", horizontal: true, short: true, count: 2, header: 400, footer: 400 })
        const samples = await sample(page, 2)
        evidence.push({ format, name: "horizontal-control", samples })
        assert(samples.every(s => s.inlineMarginStart === "auto"))
      })
      const assertMeasuredGiant = async () => {
        const actual = await page.locator('[data-body="3"]').evaluate(element => ({
          height: element.getBoundingClientRect().height,
          known: Number(element.closest("[data-known-size]")?.getAttribute("data-known-size"))
        }))
        assert(Math.abs(actual.height - 9751.21875) < 0.01, "The giant body is really mounted")
        assert(Math.abs(actual.known - 9751.21875) < 0.01, "The native size model has measured the giant")
      }
      for (const mode of ["element", "window", "custom"] as const) await check(`overflow shrink ${mode}`, async () => {
        await mount({ mode })
        await assertMeasuredGiant()
        const before = await sample(page, 1)
        assert(before[0].visible > 0)
        const samples = await sample(page, 8, true)
        assert(Math.abs(((samples[0].bodies.find((body: BodyRect) => body.id === "3")?.bottom as number) -
          (samples[0].bodies.find((body: BodyRect) => body.id === "3")?.top as number)) - 391.75) < 0.01)
        evidence.push({ format, name: "overflow-shrink", mode, before, samples })
        assert(samples.every(s => s.visible > 0), "Immediate and every painted sample must contain readable body")
      })
      await check("owned user position survives shrink", async () => {
        await mount({ mode: "custom" })
        await assertMeasuredGiant()
        await page.evaluate("window.fixture.own(true);window.fixture.viewport().scrollTop=120")
        await frames(page, 2)
        const samples = await sample(page, 8, true)
        evidence.push({ format, name: "owned-shrink", samples })
        assert(samples.every(s => s.visible > 0 && Math.abs(s.top - 120) < 1))
        await page.evaluate("window.fixture.own(false)")
        await frames(page, 2)
        assert.equal(await page.evaluate("window.fixture.viewport().scrollTop"), 120)
      })
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(failures, [])
  } finally {
    writeFileSync(resolve(output, "evidence.json"), JSON.stringify({ evidence, failures, errors }, null, 2))
    await browser.close()
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
