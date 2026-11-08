import assert from "node:assert/strict"
import { build } from "esbuild"
import type { Browser } from "playwright"

export async function verifySessionSaveAnchor(browser: Browser): Promise<void> {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import {selectChatSessionSaveAnchor} from './src/renderer/src/components/chat/chat-session-save-anchor';
      import {createChatSessionRestorePosition} from './src/renderer/src/components/chat/chat-session-restore-position';
      const viewport=document.querySelector('#viewport');
      window.selectAnchor=()=>selectChatSessionSaveAnchor(viewport);
      const position=createChatSessionRestorePosition();
      window.correctSession=()=>{
        const target=document.querySelector('#cold')??undefined;
        const destination=position.resolve(viewport,target,-10);
        if(!destination)return null;
        viewport.scrollTop+=destination.element.getBoundingClientRect().top-
          viewport.getBoundingClientRect().top-destination.offset;
        return {temporary:destination.temporary,id:destination.element.dataset.chatMessageId,
          offset:destination.element.getBoundingClientRect().top-viewport.getBoundingClientRect().top};
      };
      window.legacyAnchor=()=>[...viewport.querySelectorAll('[data-chat-message-id]')]
        .map(row=>({messageId:row.dataset.chatMessageId,
          offsetFromViewportTop:row.getBoundingClientRect().top-viewport.getBoundingClientRect().top}))
        .sort((a,b)=>Math.abs(a.offsetFromViewportTop)-Math.abs(b.offsetFromViewportTop))[0];
      window.restore=anchor=>{
        document.querySelector('#cold').style.height='467px';
        const target=viewport.querySelector('[data-chat-message-id="'+anchor.messageId+'"]');
        viewport.scrollTop+=target.getBoundingClientRect().top-viewport.getBoundingClientRect().top-
          anchor.offsetFromViewportTop;
        return document.querySelector('#body').getBoundingClientRect().top-viewport.getBoundingClientRect().top;
      };
    ` }, bundle: true, write: false, format: "iife", platform: "browser"
  })
  const page = await browser.newPage()
  try {
    const reset = async () => {
      await page.setContent(`<div id="viewport" style="height:200px;width:400px;overflow:auto;overflow-anchor:none">
        <div style="height:90px"></div>
        <div id="cold" data-chat-message-id="cold" style="height:40px"><div data-function-site="AssistantMessage"><i data-function-site-pending></i></div></div>
        <div id="body" data-chat-message-id="body" style="height:300px"><div data-function-site="AssistantMessage">Readable answer</div></div>
        <div style="height:600px"></div></div>`)
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      await page.evaluate("document.querySelector('#viewport').scrollTop=100")
    }
    await page.evaluate("window.originalCheckVisibility=Element.prototype.checkVisibility")
    for (const fallback of [false, true]) {
      await page.evaluate(`Element.prototype.checkVisibility=${fallback ? "undefined" : "window.originalCheckVisibility"}`)
      await reset()
      await page.evaluate("document.querySelector('#viewport').dataset.chatInitialPresentation='pending'")
      assert.deepEqual(await page.evaluate("window.correctSession()"),
        { temporary: true, id: "body", offset: 30 },
        "A readiness hint cannot reject an actually visible temporary reading anchor")
      await page.evaluate("document.querySelector('#cold').style.height='467px'")
      assert.deepEqual(await page.evaluate("window.correctSession()"),
        { temporary: true, id: "body", offset: 30 },
        "Visible text stays anchored during cold-row expansion even before the readiness hint settles")
      for (const hidden of ["visibility", "display", "opacity", "aria-hidden", "inert"]) {
        await reset()
        await page.evaluate(`{
          document.querySelector('#viewport').dataset.chatInitialPresentation='pending';
          const body=document.querySelector('#body');
          if('${hidden}'==='visibility')body.style.visibility='hidden';
          else if('${hidden}'==='display')body.style.display='none';
          else if('${hidden}'==='opacity')body.style.opacity='0';
          else body.setAttribute('${hidden}','true');
        }`)
        assert.equal(await page.evaluate("window.correctSession()"), null,
          `Actual ${hidden} text is rejected with native/fallback visibility (${fallback})`)
      }
    }
    await page.evaluate("Element.prototype.checkVisibility=window.originalCheckVisibility")
    for (const fallback of [false, true]) {
      await page.evaluate(`Element.prototype.checkVisibility=${fallback ? "undefined" : "window.originalCheckVisibility"}`)
      for (const markup of [
        '<div style="display:contents"><p style="margin:0">Visible paragraph</p></div>',
        'Direct visible text',
        '<div style="display:contents">Direct nested visible text</div>',
        '<div data-function-site-cached inert aria-disabled="true"><p style="margin:0">Verified cached answer</p></div>'
      ]) {
        await reset()
        await page.evaluate(markup => {
          const site = document.querySelector<HTMLElement>('#body [data-function-site]')!
          site.style.display = 'contents'
          site.innerHTML = markup
        }, markup)
        assert.equal(await page.evaluate("window.selectAnchor().messageId"), "body")
        assert.deepEqual(await page.evaluate("window.correctSession()"),
          { temporary: true, id: "body", offset: 30 })
        await page.evaluate("document.querySelector('#cold').style.height='467px'")
        assert.deepEqual(await page.evaluate("window.correctSession()"),
          { temporary: true, id: "body", offset: 30 }, "Contents text remains anchored while cold geometry expands")
        for (const hidden of ["visibility", "display", "opacity", "aria-hidden"]) {
          await page.evaluate(hidden => {
            const site = document.querySelector<HTMLElement>('#body [data-function-site]')!
            if (hidden === 'aria-hidden') site.setAttribute(hidden, 'true')
            else site.style[hidden as 'visibility' | 'display' | 'opacity'] = hidden === 'display' ? 'none' : hidden === 'opacity' ? '0' : 'hidden'
          }, hidden)
          assert.equal(await page.evaluate("window.correctSession()"), null)
          await page.evaluate("document.querySelector('#body [data-function-site]').style.cssText='display:contents';document.querySelector('#body [data-function-site]').removeAttribute('aria-hidden')")
        }
        await page.evaluate("document.querySelector('#body [data-function-site]').replaceChildren()")
        assert.equal(await page.evaluate("window.correctSession()"), null,
          "A removed cached receipt presentation cannot remain a readable anchor")
      }
    }
    await page.evaluate("Element.prototype.checkVisibility=window.originalCheckVisibility")
    await reset()
    assert.deepEqual(await page.evaluate(() => {
      const site = document.querySelector<HTMLElement>('#body [data-function-site]')!
      site.style.display = 'contents'
      site.innerHTML = '<p style="margin:0">Visible native text</p>'
      const original = window.getComputedStyle
      let reads = 0
      window.getComputedStyle = (...args) => { reads++; return original(...args) }
      try {
        const anchor = (window as unknown as { selectAnchor(): { messageId: string } }).selectAnchor()
        return { id: anchor.messageId, reads }
      } finally { window.getComputedStyle = original }
    }), { id: "body", reads: 0 }, "Visible native text needs no explicit computed-style walk")
    await reset()
    assert.deepEqual(await page.evaluate("window.correctSession()"),
      { temporary: true, id: "body", offset: 30 })
    await page.evaluate("document.querySelector('#cold').style.height='467px'")
    assert.deepEqual(await page.evaluate("window.correctSession()"),
      { temporary: true, id: "body", offset: 30 },
      "A mounted cold target cannot push the temporary readable anchor away")
    await page.evaluate(`document.querySelector('#cold [data-function-site]').innerHTML=
      '<span aria-busy="true">Cached target answer</span>'`)
    assert.deepEqual(await page.evaluate("window.correctSession()"),
      { temporary: false, id: "cold", offset: -10 },
      "A ready target resumes its original saved offset, including busy cached content")
    await reset()
    await page.evaluate("window.correctSession();document.querySelector('#cold').remove()")
    assert.equal(await page.evaluate("window.correctSession()"), null,
      "A recycled target yields to the existing bounded index reveal rather than pinning its neighbor")
    await reset()
    await page.evaluate("document.querySelector('#body').style.marginTop='500px'")
    assert.equal(await page.evaluate("window.correctSession()"), null,
      "An offscreen readable save fallback cannot become the temporary reading anchor")
    await reset()
    assert.deepEqual(await page.evaluate("window.legacyAnchor()"),
      { messageId: "cold", offsetFromViewportTop: -10 })
    assert.deepEqual(await page.evaluate("window.selectAnchor()"),
      { messageId: "body", offsetFromViewportTop: 30 })
    assert((await page.evaluate("window.restore(window.legacyAnchor())") as number) >= 200,
      "Control reproduces a saved cold row pushing the readable neighbor out")
    await reset()
    assert(Math.abs((await page.evaluate("window.restore(window.selectAnchor())") as number) - 30) <= 2,
      "Saving the visible text preserves its offset when the earlier placeholder grows")
    await reset()
    await page.evaluate("document.querySelector('#body [data-function-site]').setAttribute('aria-busy','true')")
    assert.equal(await page.evaluate("window.selectAnchor().messageId"), "body")
    await page.evaluate("document.querySelector('#body').insertAdjacentHTML('beforeend','<i data-function-site-pending></i>')")
    assert.deepEqual(await page.evaluate("window.selectAnchor()"), await page.evaluate("window.legacyAnchor()"),
      "All-pending views retain the original fallback")
    await reset()
    await page.evaluate("document.querySelector('#body [data-function-site]').textContent=''")
    assert.deepEqual(await page.evaluate("window.selectAnchor()"), await page.evaluate("window.legacyAnchor()"),
      "An empty visible FunctionSite wrapper is not readable text")
    await reset()
    await page.evaluate(`{
      const site=document.querySelector('#body [data-function-site]');
      site.style.display='contents';
      site.replaceChildren(document.createTextNode('Readable '+ 'x'.repeat(1000000)));
      for(const name of ['innerText','textContent'])Object.defineProperty(site,name,{
        configurable:true,get(){throw new Error('Unbounded body getter '+name)}});
    }`)
    assert.equal(await page.evaluate("window.selectAnchor().messageId"), "body",
      "A long body is selected without reading its whole innerText or textContent")
    await reset()
    await page.evaluate(`document.querySelector('#body [data-function-site]').innerHTML=
      '<span hidden>Hidden text</span><script>not readable</script><style>body{color:inherit}</style>'`)
    assert.equal(await page.evaluate("window.selectAnchor().messageId"), "cold",
      "Hidden and script/style text cannot qualify a visible wrapper")
    await reset()
    await page.evaluate(`document.querySelector('#body [data-function-site]').style.display='contents';document.querySelector('#body [data-function-site]').replaceChildren(
      ...Array.from({length:64},()=>document.createElement('span')),document.createTextNode('Late body'))`)
    assert.equal(await page.evaluate("window.selectAnchor().messageId"), "cold",
      "Exhausting the bounded node probe retains the original fallback")
    for (const hiddenMarkup of [
      '<div aria-hidden="true"><p>Hidden ancestor text</p></div>',
      '<div style="content-visibility:hidden"><p>Skipped content</p></div>',
      '<div style="display:contents;opacity:0">Transparent direct text</div>'
    ]) {
      await reset()
      await page.evaluate(markup => {
        const site = document.querySelector<HTMLElement>('#body [data-function-site]')!
        site.style.display = 'contents'
        site.innerHTML = markup
      }, hiddenMarkup)
      assert.equal(await page.evaluate("window.correctSession()"), null)
    }
    await reset()
    await page.evaluate("document.querySelectorAll('[data-function-site]').forEach(site=>site.removeAttribute('data-function-site'))")
    assert.deepEqual(await page.evaluate("window.selectAnchor()"), await page.evaluate("window.legacyAnchor()"),
      "Native-only system views retain the original fallback")
    await reset()
    await page.evaluate("document.querySelector('#cold').style.height='3px';document.querySelector('#viewport').scrollTop=95")
    assert.equal(await page.evaluate("window.legacyAnchor().messageId"), "body")
    await page.evaluate("document.querySelector('#cold').style.height='3px';document.querySelector('#body').style.marginTop='40px'")
    assert.equal(await page.evaluate("window.legacyAnchor().messageId"), "cold")
    assert.equal(await page.evaluate("window.selectAnchor().messageId"), "body",
      "A short row entirely above the viewport cannot displace visible text")
    await reset()
    await page.evaluate("document.querySelector('#viewport').scrollTop=170")
    assert.deepEqual(await page.evaluate("window.selectAnchor()"),
      { messageId: "body", offsetFromViewportTop: -40 })
    console.log("PASS session save DOM: cold-row control displaces body; readable anchor preserves " +
      "30px offset; busy, empty, offscreen, negative offset and legacy fallback cases")
  } finally { await page.close() }
}
