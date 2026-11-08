/** Actual decoration component: idle cost, layout-phase alignment and subscription lifecycle. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

interface Snapshot {
  reads: Array<{ phase: string; top: number }>
  listeners: number
  top: number
  transform: string | null
  present: boolean
}

async function main() {
  const bundle = await build({
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
      import React,{useCallback,useLayoutEffect,useRef,useState} from 'react';
      import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
      import {PromptDecorations} from '@/components/chat/PromptDecorations';
      const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');
      const reads=[],listeners=new Set();let phase='before-layout',node,setEnabled;
      const text=Array.from({length:100},(_,index)=>'line '+index).join('\\n');
      const snapshot=()=>({reads:[...reads],listeners:listeners.size,
        top:descriptor.get.call(node),present:!!document.querySelector('[data-prompt-decorations]'),
        transform:document.querySelector('[data-prompt-decorations] pre')?.style.transform??null});
      function Fixture(){
        const textarea=useRef(null),[enabled,enable]=useState(!!window.initialDecorations);setEnabled=enable;
        const attach=useCallback(element=>{
          textarea.current=element;node=element;if(!element)return;
          Object.defineProperty(element,'scrollTop',{configurable:true,
            get(){const top=descriptor.get.call(this);reads.push({phase,top});return top},
            set(value){descriptor.set.call(this,value)}});
          const add=element.addEventListener.bind(element),remove=element.removeEventListener.bind(element);
          element.addEventListener=(type,listener,options)=>{
            if(type==='scroll')listeners.add(listener);return add(type,listener,options)};
          element.removeEventListener=(type,listener,options)=>{
            if(type==='scroll')listeners.delete(listener);return remove(type,listener,options)};
          descriptor.set.call(element,window.initialTop??0);
        },[]);
        // Child layout effects run before this parent. A passive scroll read is too late.
        useLayoutEffect(()=>{phase='after-layout'},[enabled]);
        return <div><PromptDecorations text={text} decorations={enabled?[{start:0,end:4,bold:true}]:[]}
            textarea={textarea} className='fixture-decoration'/>
          <textarea ref={attach} defaultValue={text}
            style={{height:60,width:300,lineHeight:'20px',overflow:'auto'}}/></div>
      }
      window.fixture={snapshot,position(value,dispatch=false){descriptor.set.call(node,value);
        if(dispatch)flushSync(()=>node.dispatchEvent(new Event('scroll')));return snapshot()},
        async enable(value){reads.length=0;phase='before-layout';flushSync(()=>setEnabled(value));
          const committed=snapshot();const firstFrame=await new Promise(done=>requestAnimationFrame(()=>done(snapshot())));
          return {committed,firstFrame}},
        frame:()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))};
      flushSync(()=>createRoot(document.getElementById('root')).render(<Fixture/>));
    `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"development"' }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const snapshot = () => page.evaluate("window.fixture.snapshot()") as Promise<Snapshot>
    assert.deepEqual((await snapshot()).reads, [])
    assert.equal((await snapshot()).listeners, 0)
    await page.evaluate("window.fixture.position(140,true)")
    await page.evaluate("window.fixture.frame()")
    assert.deepEqual((await snapshot()).reads, [], "Empty decorations must not read scrollTop")
    assert.equal((await snapshot()).present, false)

    const enabled = (await page.evaluate("window.fixture.enable(true)")) as {
      committed: Snapshot
      firstFrame: Snapshot
    }
    assert(enabled.committed.top > 0)
    assert.equal(enabled.committed.listeners, 1)
    assert.equal(
      enabled.committed.reads[0]?.phase,
      "before-layout",
      "Enabling must read scrollTop in the child layout effect, before parent layout completes"
    )
    for (const value of [enabled.committed, enabled.firstFrame]) {
      assert.equal(
        value.transform,
        `translateY(-${value.top}px)`,
        "The committed overlay and first frame must already align with the scrolled textarea"
      )
    }
    const scrolled = (await page.evaluate("window.fixture.position(220,true)")) as Snapshot
    assert.equal(scrolled.transform, `translateY(-${scrolled.top}px)`)
    assert(scrolled.reads.length > enabled.committed.reads.length)

    const disabled = (await page.evaluate("window.fixture.enable(false)")) as {
      committed: Snapshot
      firstFrame: Snapshot
    }
    assert.equal(disabled.firstFrame.listeners, 0, "Clearing must release the scroll listener")
    assert.equal(disabled.committed.present, false)
    assert.deepEqual(disabled.committed.reads, [])
    await page.evaluate("window.fixture.position(360,true)")
    await page.evaluate("window.fixture.frame()")
    assert.deepEqual(
      (await snapshot()).reads,
      [],
      "Cleared decorations remain inert while scrolling"
    )
    const restored = (await page.evaluate("window.fixture.enable(true)")) as {
      committed: Snapshot
      firstFrame: Snapshot
    }
    assert.equal(restored.committed.listeners, 1)
    assert.equal(restored.committed.reads[0]?.phase, "before-layout")
    assert.equal(restored.committed.transform, `translateY(-${restored.committed.top}px)`)
    assert.equal(restored.firstFrame.transform, `translateY(-${restored.firstFrame.top}px)`)
    assert.notEqual(restored.firstFrame.top, enabled.firstFrame.top)

    // Match production sibling order: the decoration layout effect precedes textarea ref attach.
    await page.goto("about:blank")
    await page.setContent('<div id="root"></div>')
    await page.evaluate("window.initialDecorations=true;window.initialTop=100")
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.evaluate("window.fixture.frame()")
    const initial = await snapshot()
    assert.equal(
      initial.listeners,
      1,
      "Initially non-empty decorations must subscribe when the sibling textarea attaches later"
    )
    assert.equal(initial.transform, `translateY(-${initial.top}px)`)
    const initialScrolled = (await page.evaluate("window.fixture.position(180,true)")) as Snapshot
    assert.equal(initialScrolled.transform, `translateY(-${initialScrolled.top}px)`)
    assert.deepEqual(errors, [])
    console.log(
      "PASS decoration idle cost, pre-paint alignment, cleanup, reactivation and scrolling"
    )
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
