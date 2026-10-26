/** Real shared leaves/provider, with an explicitly mocked host transport. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

declare global {
  interface Window {
    reactionFixture: {
      calls: Array<{ scope: string; id: string; emoji: string; present: boolean }>
      reads: Array<{ scope: string; ids: string[] }>
      copiedTexts: string[]
      replies: string[]
      fail: boolean
      hold: boolean
      holdRead: boolean
      missingReady: boolean
      failRead: boolean
      activeReads: number
      maxActiveReads: number
      maxListeners: number
      readonly listenerCount: number
      release(): void
      releaseRead(): void
      unmount(): void
      render(
        scope: string,
        readOnly?: boolean,
        alternateClient?: boolean,
        enabled?: boolean,
        extra?: number
      ): void
      invalidate(scope?: string, hint?: boolean): void
      modelReaction(): void
    }
  }
}

async function main() {
  const bundle = await build({
    stdin: {
      resolveDir: resolve("."),
      loader: "tsx",
      contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {BotMessageActions} from './src/renderer/src/components/bots/BotMessageActions';
import {BotGroupMessageActions} from './src/renderer/src/components/bots/BotGroupMessageActions';
import {BotMessageReactionsProvider} from './src/renderer/src/components/bots/BotMessageReactions';
const root=createRoot(document.getElementById('root'));const id='provider:a/b::cmb-same-role-duplicate:assistant:2';
const listeners=new Set();const records=new Map();let revision=0;let release=()=>{};let releaseRead=()=>{};
const scopeOf=t=>JSON.stringify(t);const clone=x=>JSON.parse(JSON.stringify(x));
const methods={hostId:'host',subscribe(fn){listeners.add(fn);state.maxListeners=Math.max(state.maxListeners,listeners.size);return()=>listeners.delete(fn)},async messageReactions(target,ids){const scope=scopeOf(target),rev=revision;state.reads.push({scope,ids});if(state.failRead){state.failRead=false;throw new Error('host拒绝读取回应')}const items=ids.map(messageId=>({messageId,canReact:messageId!=='missing'||state.missingReady,reactions:clone(records.get(scope+messageId)||[])}));if(state.holdRead){state.holdRead=false;await new Promise(r=>releaseRead=r)}return {revision:rev,items}},async setMessageReaction(target,messageId,emoji,present){const scope=scopeOf(target);state.calls.push({scope,id:messageId,emoji,present});if(state.hold){state.hold=false;await new Promise(r=>release=r)}if(state.fail){state.fail=false;throw new Error('host拒绝保存回应')}const previous=records.get(scope+messageId)||[];const actors=previous.find(x=>x.emoji===emoji)?.actors||[];const items=previous.filter(x=>x.emoji!==emoji&&(!present||!x.mine));if(present||actors.length)items.push({emoji,count:actors.length+Number(present),mine:present,...(actors.length?{actors}:{})});records.set(scope+messageId,items);return {revision:++revision,item:{messageId,canReact:true,reactions:clone(items)}}}};
const readTransport=methods.messageReactions;methods.messageReactions=async(...args)=>{state.activeReads++;state.maxActiveReads=Math.max(state.maxActiveReads,state.activeReads);try{return await readTransport(...args)}finally{state.activeReads--}};
const alternate={...methods};
const state=window.reactionFixture={calls:[],reads:[],copiedTexts:[],replies:[],fail:false,hold:false,holdRead:false,missingReady:false,failRead:false,activeReads:0,maxActiveReads:0,maxListeners:0,get listenerCount(){return listeners.size},unmount(){root.render(null)},release(){release()},releaseRead(){releaseRead()},modelReaction(){const target={kind:'bot',botId:'BOT-AUTHOR',workId:'work'};records.set(scopeOf(target)+id,[{emoji:'👍',count:1,mine:false,actors:[{botId:'actual-bot',name:'验收 Bot'}]}]);revision++;this.invalidate('BOT-AUTHOR')},invalidate(scope='A',hint=true){const target=scope==='G'?{kind:'group',groupId:'g'}:{workId:'work',botId:scope,kind:'bot'};for(const listener of listeners)listener({hostId:'host',revision,...(hint?{reactionTarget:target}:{})})},render(scope='A',readOnly=false,other=false,enabled=true,extra=0){const target=scope==='G'?{kind:'group',groupId:'g'}:{kind:'bot',botId:scope,workId:'work'};root.render(<BotMessageReactionsProvider client={other?alternate:methods} target={target} messageIds={[id,'missing','file',...Array.from({length:extra},(_,i)=>'extra-'+i)]} readOnly={readOnly} enabled={enabled}><article data-row='middle'><BotMessageActions messageId={id} replyAction={<button aria-label='回复消息'>reply</button>} moreActions={<button aria-label='复制消息'>copy</button>}/></article><article data-row='missing'><BotMessageActions messageId='missing'/></article><article className='bot-group-message' data-row='file'><BotGroupMessageActions messageId='file' author='文件发送者' text='' onReply={()=>state.replies.push('file')} onError={()=>{}}/></article><article data-row='group-copy'><BotGroupMessageActions messageId='group-copy' author='群成员' text='群消息正文' onReply={()=>state.replies.push('group-copy')} onError={()=>{}}/></article><article data-row='empty-system'><BotGroupMessageActions messageId='empty-system' author='系统' text='' onError={()=>{}}/></article></BotMessageReactionsProvider>)}};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{state.copiedTexts.push(text)}}});state.render();`
    },
    bundle: true,
    write: false,
    splitting: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    outdir: "/reaction-fixture",
    entryNames: "entry",
    chunkNames: "chunks/[name]-[hash]",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' },
    metafile: true
  })
  const files = new Map(
    bundle.outputFiles.map((file) => [file.path.replace("/reaction-fixture", ""), file.text])
  )
  const requests: string[] = []
  const server = createServer((req, res) => {
    const path = req.url ?? "/"
    requests.push(path)
    if (path === "/") {
      res.setHeader("Content-Type", "text/html")
      res.end(
        '<meta charset="utf-8"><div id="root"></div><script type="module" src="/entry.js"></script>'
      )
      return
    }
    const text = files.get(path)
    res.statusCode = text ? 200 : 404
    res.setHeader("Content-Type", "text/javascript")
    res.end(text ?? "missing")
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const browser = await chromium.launch({
    ...(existsSync(chromium.executablePath())
      ? {}
      : { channel: process.platform === "win32" ? "msedge" : "chrome" }),
    headless: true
  })
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}`)
    const middle = page.locator('[data-row="middle"]')
    const smile = middle.getByRole("button", { name: "添加表情回应", exact: true })
    await smile.waitFor()
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>('[data-row="middle"] button')?.disabled
    )
    assert.equal(
      requests.some((path) => /compact|iamcal|emojibase|messages-/.test(path)),
      false,
      "catalog must not load on initial chat render"
    )
    const missing = page.locator('[data-row="missing"]')
    const missingSmile = missing.getByRole("button", { name: "添加表情回应", exact: true })
    await page.waitForFunction(
      () => window.reactionFixture.reads.length > 0 && window.reactionFixture.activeReads === 0
    )
    assert.equal(
      await missingSmile.isEnabled(),
      true,
      "an unconfirmed row can request confirmation"
    )
    await missingSmile.click()
    const unconfirmedChoice = page.getByRole("button", { name: "回应 👍", exact: true })
    await unconfirmedChoice.waitFor()
    await page.waitForFunction(() => window.reactionFixture.activeReads === 0)
    assert.equal(
      await unconfirmedChoice.isDisabled(),
      true,
      "an unavailable native row cannot mutate"
    )
    await unconfirmedChoice.evaluate((button) => (button as HTMLButtonElement).click())
    assert.equal(await page.evaluate(() => window.reactionFixture.calls.length), 0)
    await page.keyboard.press("Escape")

    await page.evaluate(() => {
      window.reactionFixture.failRead = true
    })
    await missingSmile.click()
    await missing.getByRole("alert").waitFor()
    assert.match(await missing.getByRole("alert").innerText(), /host拒绝读取/)
    assert.equal(
      await unconfirmedChoice.isDisabled(),
      true,
      "a rejected re-read grants no authority"
    )
    await page.keyboard.press("Escape")

    const beforeReadyRead = await page.evaluate(() => window.reactionFixture.reads.length)
    await page.evaluate(() => {
      window.reactionFixture.missingReady = true
      window.reactionFixture.holdRead = true
    })
    assert.equal(
      await page.evaluate(() => window.reactionFixture.reads.length),
      beforeReadyRead,
      "host readiness without an event does not manufacture a refresh"
    )
    await missingSmile.click()
    await page.waitForFunction(
      (count) =>
        window.reactionFixture.reads.length === count + 1 &&
        window.reactionFixture.activeReads === 1,
      beforeReadyRead
    )
    assert.equal(
      await unconfirmedChoice.isDisabled(),
      true,
      "the pending confirmation is not permission"
    )
    assert.equal(await page.evaluate(() => window.reactionFixture.calls.length), 0)
    await page.evaluate(() => window.reactionFixture.releaseRead())
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>('[aria-label="回应 👍"]')?.disabled
    )
    await unconfirmedChoice.click()
    await missing.getByRole("button", { name: "取消回应 👍，1 人", exact: true }).waitFor()
    assert.deepEqual(
      await page.evaluate(() =>
        window.reactionFixture.calls.map(({ id, emoji }) => ({ id, emoji }))
      ),
      [{ id: "missing", emoji: "👍" }],
      "a confirmed row writes exactly once to its selected identity"
    )
    const confirmedReads = await page.evaluate(() => window.reactionFixture.reads.length)
    await missingSmile.click()
    await page.locator('[aria-label="选择表情回应"]').waitFor()
    assert.equal(
      await page.evaluate(() => window.reactionFixture.reads.length),
      confirmedReads,
      "opening an already confirmed row never re-reads"
    )
    await page.keyboard.press("Escape")
    assert.equal(
      await page
        .locator('[data-row="file"]')
        .getByRole("button", { name: "添加表情回应" })
        .isEnabled(),
      true,
      "file-only genuine messages remain reactable"
    )
    await page
      .locator('[data-row="file"]')
      .getByRole("button", { name: "回复文件发送者的消息", exact: true })
      .click()
    await page
      .locator('[data-row="group-copy"]')
      .getByRole("button", { name: "回复群成员的消息", exact: true })
      .click()
    assert.deepEqual(await page.evaluate(() => window.reactionFixture.replies), [
      "file",
      "group-copy"
    ])
    assert.equal(
      await page.locator('[data-row="empty-system"]').getByRole("button", { name: /回复/ }).count(),
      0,
      "an empty system row without a reply action stays unavailable"
    )
    const groupMore = page
      .locator('[data-row="group-copy"]')
      .getByRole("button", { name: "更多消息操作", exact: true })
    await groupMore.click()
    await page.getByRole("button", { name: "复制群消息", exact: true }).click()
    await page.waitForFunction(() => window.reactionFixture.copiedTexts.length === 1)
    assert.deepEqual(await page.evaluate(() => window.reactionFixture.copiedTexts), ["群消息正文"])
    await page
      .getByRole("button", { name: "复制群消息", exact: true })
      .waitFor({ state: "detached" })
    await groupMore.click()
    await page.getByRole("button", { name: "复制群消息", exact: true }).waitFor({ timeout: 3000 })
    assert.equal(
      await page.getByRole("button", { name: "已复制消息", exact: true }).count(),
      0,
      "reopening group More clears the previous copy confirmation"
    )
    await page.keyboard.press("Escape")
    await smile.click()
    assert.deepEqual(
      await page
        .locator('[aria-label="选择表情回应"]')
        .getByRole("button")
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
      ["回应 👍", "回应 👎", "回应 ❤️", "回应 😂", "回应 🎉", "更多表情"],
      "the quick picker has exactly five official shortcuts and More"
    )
    await page.getByRole("button", { name: "回应 👍", exact: true }).click()
    const pill = middle.getByRole("button", { name: "取消回应 👍，1 人", exact: true })
    await pill.waitFor()
    assert.equal(await pill.innerText(), "👍", "the badge shows the emoji without a redundant count")
    await smile.click()
    await page.getByRole("button", { name: "回应 👎", exact: true }).click()
    await middle.getByRole("button", { name: "取消回应 👎，1 人", exact: true }).waitFor()
    assert.equal(await middle.locator("[data-message-reactions] button").count(), 1, "changing emoji replaces the previous choice")
    assert.equal(await pill.count(), 0)
    await smile.click()
    await page.getByRole("button", { name: "回应 👍", exact: true }).click()
    await pill.waitFor()
    assert.equal(
      (await page.evaluate(() => window.reactionFixture.calls)).at(-1)!.id,
      "provider:a/b::cmb-same-role-duplicate:assistant:2"
    )
    await page.evaluate(() => {
      window.reactionFixture.fail = true
    })
    await pill.click()
    await middle.getByRole("alert").waitFor()
    assert.equal(await pill.count(), 1, "failed cancellation must retain authoritative pills")
    assert.match(await middle.getByRole("alert").innerText(), /host拒绝保存/)
    await pill.click()
    await pill.waitFor({ state: "detached" })
    await smile.click()
    await page.getByRole("button", { name: "更多表情", exact: true }).click()
    const search = page.getByRole("textbox", { name: "搜索全部表情" })
    await search.waitFor()
    await search.fill("face with open mouth")
    await page.getByRole("button", { name: "face with open mouth", exact: true }).waitFor()
    await search.fill("waving hand: dark skin tone")
    const skin = page.getByRole("button", { name: "waving hand: dark skin tone", exact: true })
    await skin.waitFor()
    await skin.focus()
    await page.keyboard.press("Enter")
    await middle.getByRole("button", { name: "取消回应 👋🏿，1 人", exact: true }).waitFor()
    assert.equal(
      requests.some((path) => /compact/.test(path)),
      true,
      "More loads official full data"
    )
    await smile.click()
    await page.getByRole("button", { name: "更多表情", exact: true }).click()
    await search.waitFor()
    assert(
      (await page
        .getByRole("group", { name: "全部表情", exact: true })
        .getByRole("button")
        .count()) < 160,
      "full catalog DOM is virtualized"
    )
    await page.keyboard.press("Escape")
    await search.waitFor({ state: "detached" })
    // Radix restores trigger focus in its deferred FocusScope unmount callback.
    await page.waitForFunction(
      (trigger) => trigger === document.activeElement,
      await smile.elementHandle(),
      { timeout: 3000 }
    )
    assert.equal(
      await smile.evaluate((el) => el === document.activeElement),
      true,
      "Escape restores picker trigger focus"
    )
    await page.evaluate(() => {
      window.reactionFixture.holdRead = true
      window.reactionFixture.invalidate()
    })
    await smile.click()
    await page.getByRole("button", { name: "回应 🎉", exact: true }).click()
    await middle.getByRole("button", { name: "取消回应 🎉，1 人", exact: true }).waitFor()
    await page.evaluate(() => window.reactionFixture.releaseRead())
    await page.waitForTimeout(50)
    assert.equal(
      await middle.getByRole("button", { name: "取消回应 🎉，1 人", exact: true }).count(),
      1,
      "older batch response cannot erase successful mutation"
    )
    await page.evaluate(() => {
      window.reactionFixture.hold = true
    })
    await smile.click()
    await page.getByRole("button", { name: "回应 😂", exact: true }).click()
    await page.waitForFunction(() => window.reactionFixture.calls.some((x) => x.emoji === "😂"))
    assert.equal(await smile.isDisabled(), true, "an in-flight mutation disables another selection")
    const pendingReads = await page.evaluate(() => window.reactionFixture.reads.length)
    await smile.evaluate((button) => (button as HTMLButtonElement).click())
    assert.equal(
      await page.evaluate(() => window.reactionFixture.reads.length),
      pendingReads,
      "pending mutations cannot open a confirmation read"
    )
    assert.equal(
      (await page.evaluate(() => window.reactionFixture.calls)).filter(
        (call) => call.emoji === "😂"
      ).length,
      1,
      "disabled pending actions cannot create duplicate writes"
    )
    await page.evaluate(() => window.reactionFixture.render("B"))
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>('[data-row="middle"] button')?.disabled
    )
    assert.equal(
      await middle.locator("[data-message-reactions]").count(),
      0,
      "no cross-scope pills"
    )
    await page.evaluate(() => window.reactionFixture.release())
    await page.waitForTimeout(50)
    assert.equal(
      await middle.locator("[data-message-reactions]").count(),
      0,
      "old-scope mutation completion ignored"
    )
    const beforeReadOnlySwitch = await page.evaluate(() => window.reactionFixture.reads.length)
    await page.evaluate(() => window.reactionFixture.render("A", true, true))
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLButtonElement>('[data-row="middle"] button')?.disabled === true
    )
    await page.waitForFunction(
      (count) =>
        window.reactionFixture.reads.length > count && window.reactionFixture.activeReads === 0,
      beforeReadOnlySwitch
    )
    assert.equal(await smile.isDisabled(), true)
    const before = await page.evaluate(() => window.reactionFixture.reads.length)
    const readOnlyWrites = await page.evaluate(() => window.reactionFixture.calls.length)
    await smile.evaluate((button) => (button as HTMLButtonElement).click())
    assert.equal(await page.evaluate(() => window.reactionFixture.reads.length), before)
    assert.equal(await page.evaluate(() => window.reactionFixture.calls.length), readOnlyWrites)
    await page.evaluate(() => {
      window.reactionFixture.invalidate("B")
      window.reactionFixture.invalidate("A", false)
    })
    await page.waitForTimeout(50)
    assert.equal(
      await page.evaluate(() => window.reactionFixture.reads.length),
      before,
      "other scopes and ordinary changes never read reaction state"
    )
    await page.evaluate(() => window.reactionFixture.invalidate("A"))
    await page.waitForFunction((count) => window.reactionFixture.reads.length > count, before)
    await page.evaluate(() => window.reactionFixture.render("A", false, false, false))
    const disabledReads = await page.evaluate(() => window.reactionFixture.reads.length)
    await page.evaluate(() => window.reactionFixture.invalidate("A"))
    await page.waitForTimeout(50)
    assert.equal(
      await page.evaluate(() => window.reactionFixture.reads.length),
      disabledReads,
      "disabled source work never subscribes or reads"
    )
    assert.equal(await smile.isDisabled(), true)
    const withoutProviderWrites = await page.evaluate(() => window.reactionFixture.calls.length)
    await smile.evaluate((button) => (button as HTMLButtonElement).click())
    assert.equal(await page.evaluate(() => window.reactionFixture.reads.length), disabledReads)
    assert.equal(
      await page.evaluate(() => window.reactionFixture.calls.length),
      withoutProviderWrites
    )
    const thousandStart = await page.evaluate(() => window.reactionFixture.reads.length)
    await page.evaluate(() => window.reactionFixture.render("G", false, false, true, 997))
    await page.waitForFunction(
      (start) =>
        window.reactionFixture.reads.length === start + 10 &&
        window.reactionFixture.activeReads === 0,
      thousandStart
    )
    const thousandReads = await page.evaluate(
      (start) => window.reactionFixture.reads.slice(start),
      thousandStart
    )
    assert.equal(thousandReads.length, 10, "exactly 1000 loaded IDs need ten batches")
    assert(thousandReads.every((item) => item.ids.length === 100))
    assert.equal(new Set(thousandReads.flatMap((item) => item.ids)).size, 1000)
    for (const wake of ["hint", "focus"] as const) {
      const start = await page.evaluate(() => window.reactionFixture.reads.length)
      await page.evaluate((wake) => {
        if (wake === "hint") window.reactionFixture.invalidate("G")
        else window.dispatchEvent(new Event("focus"))
      }, wake)
      await page.waitForFunction(
        (start) =>
          window.reactionFixture.reads.length === start + 10 &&
          window.reactionFixture.activeReads === 0,
        start
      )
    }

    const catalogRequests = () =>
      requests.filter((path) => /compact|iamcal|emojibase|messages-/.test(path))
    const loadedCatalogRequests = catalogRequests()
    const writesBeforeCycles = await page.evaluate(() => window.reactionFixture.calls.length)
    await page.evaluate(() => window.reactionFixture.unmount())
    await page.waitForFunction(() => window.reactionFixture.listenerCount === 0)
    await page.evaluate(() => (window.reactionFixture.maxActiveReads = 0))
    for (let round = 0; round < 50; round++) {
      const scope = ["A", "B", "G"][round % 3]
      const start = await page.evaluate(() => window.reactionFixture.reads.length)
      await page.evaluate(
        (scope) => window.reactionFixture.render(scope, false, false, true, 997),
        scope
      )
      await page.waitForFunction(
        (start) =>
          window.reactionFixture.listenerCount === 1 &&
          window.reactionFixture.activeReads === 0 &&
          window.reactionFixture.reads.length === start + 10,
        start
      )
      await smile.click()
      await page.getByRole("button", { name: "更多表情", exact: true }).click()
      await search.waitFor()
      await page.getByRole("group", { name: "全部表情", exact: true }).waitFor()
      assert(
        (await page
          .getByRole("group", { name: "全部表情", exact: true })
          .getByRole("button")
          .count()) < 160
      )
      await page.keyboard.press("Escape")
      await search.waitFor({ state: "detached" })
      await page.evaluate(async (scope) => {
        window.reactionFixture.render(scope, false, false, true, 997)
        window.reactionFixture.invalidate(scope, false)
        window.reactionFixture.invalidate("unrelated")
        await new Promise<void>((done) => requestAnimationFrame(() => done()))
      }, scope)
      assert.equal(
        await page.evaluate(() => window.reactionFixture.reads.length),
        start + 10,
        "same IDs, ordinary events and other scopes must not reload 1000 reactions"
      )
      await page.evaluate(() => window.reactionFixture.unmount())
      await page.waitForFunction(
        () =>
          window.reactionFixture.listenerCount === 0 &&
          !document.querySelector("[data-message-actions]")
      )
    }
    assert.deepEqual(
      catalogRequests(),
      loadedCatalogRequests,
      "cached catalog imports are not refetched"
    )
    assert.equal(await page.evaluate(() => window.reactionFixture.maxActiveReads), 1)
    assert.equal(await page.evaluate(() => window.reactionFixture.maxListeners), 1)
    assert.equal(await page.evaluate(() => window.reactionFixture.calls.length), writesBeforeCycles)

    // The issued first batch may settle after unmount; the other nine must never start.
    await page.evaluate(() => window.reactionFixture.render("BOT-AUTHOR"))
    await page.waitForFunction(() => window.reactionFixture.activeReads === 0)
    await page.evaluate(() => window.reactionFixture.modelReaction())
    const botPill = middle.getByRole("button", {
      name: "添加回应 👍，1 人；验收 Bot 用 👍 回应了",
      exact: true
    })
    await botPill.waitFor()
    assert.equal(await botPill.getAttribute("aria-pressed"), "false")
    assert.equal(await botPill.getAttribute("title"), "验收 Bot 用 👍 回应了")
    await botPill.click()
    const combinedPill = middle.getByRole("button", {
      name: "取消回应 👍，2 人；验收 Bot 用 👍 回应了",
      exact: true
    })
    await combinedPill.waitFor()
    await combinedPill.click()
    await botPill.waitFor()
    assert.deepEqual(
      (await page.evaluate(() => window.reactionFixture.calls))
        .slice(-2)
        .map(({ present }) => present),
      [true, false]
    )
    console.log(
      "PASS Bot actor: author label remains after the user independently adds and removes the same emoji"
    )

    const lateStart = await page.evaluate(() => window.reactionFixture.reads.length)
    await page.evaluate(() => {
      window.reactionFixture.holdRead = true
      window.reactionFixture.render("late", false, false, true, 997)
    })
    await page.waitForFunction(() => window.reactionFixture.activeReads === 1)
    await page.evaluate(() => window.reactionFixture.unmount())
    await page.waitForFunction(() => window.reactionFixture.listenerCount === 0)
    await page.evaluate(() => window.reactionFixture.releaseRead())
    await page.waitForFunction(() => window.reactionFixture.activeReads === 0)
    await page.evaluate(() => {
      window.reactionFixture.invalidate("late")
      window.dispatchEvent(new Event("focus"))
    })
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate(() => window.reactionFixture.reads.length), lateStart + 1)
    assert.equal(await page.locator("[data-message-actions], [data-message-reactions]").count(), 0)
    console.log(
      "PASS resources: exact 1000 IDs/ten batches, 50 scope/picker/mount cycles, ordinary events cause no reads, one subscription/read at a time, cached lazy catalog and late-batch release"
    )
    assert.deepEqual(errors, [])
    console.log(
      "PASS: mocked host authority, exact durable IDs, failure/pending/scope guards, file-only actions, group copy reopen feedback, lazy complete emoji catalog, virtualized DOM and keyboard/Escape"
    )
  } finally {
    await browser.close()
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done()))
    )
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
