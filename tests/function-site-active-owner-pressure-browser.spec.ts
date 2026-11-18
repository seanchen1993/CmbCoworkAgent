/** Production virtual chat/renderer, with real Main owner limits and controlled active drawings. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { FunctionUiSites } from "../src/main/mods/v2/sites"
import { FUNCTION_CHAT_TRANSCRIPT_SITE_LIMIT } from "../src/shared/mods/v2/sites"
import type { FunctionUiAction } from "../src/shared/mods/v2/ui"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

type Thread = "first" | "second"
type Owner = { thread: Thread; messageId: string }
type HistorySample = { mounted: number; visible: number; protected: number; raw: boolean }
const previousPerComponentLimit = 32

interface ActiveHistoryFixture {
  open(thread: Thread): void
  jump(index: number): void
  heldReads(): string[]
  cancelledReads(): string[]
  release(): void
  sample(): HistorySample
}

declare global {
  interface Window {
    activeOwnerHistory: ActiveHistoryFixture
  }
}

async function main() {
  const output = resolve("output/mods-site-limit-20261117", `browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 830 } })
  page.setDefaultTimeout(8000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))

  // Each conversation owns a separate Main slot registry exactly as an active Mods session does.
  const makeSites = () => new FunctionUiSites({
    plugins: [], assertLive: () => {}, changed: () => {}, publish: async value => value,
    dispatch: async () => null, callback: async () => {}
  })
  const sites = { first: makeSites(), second: makeSites() }
  const owners = new Map<string, Owner>()
  const peak = { first: 0, second: 0 }
  const failures: Array<Owner & { code: string }> = []
  const released: Owner[] = []
  const actions: Array<Owner & { owner: string; generation: string }> = []
  const samples: HistorySample[] = []
  let lastOwnerChange = 0
  const count = (thread: Thread) => [...owners.values()].filter(owner => owner.thread === thread).length

  await page.exposeBinding("mountHistoryDrawing", async (_, thread: Thread, messageId: string) => {
    try {
      const owner = await sites[thread].mount("AssistantMessage")
      owners.set(owner, { thread, messageId })
      peak[thread] = Math.max(peak[thread], count(thread))
      return owner
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error)
      failures.push({ thread, messageId, code })
      throw error
    } finally {
      lastOwnerChange = Date.now()
    }
  })
  await page.exposeBinding("releaseHistoryDrawing", async (_, thread: Thread, owner: string) => {
    const row = owners.get(owner)
    if (!row || row.thread !== thread) throw Error("owner released against the wrong chat")
    await sites[thread].unmount(owner)
    owners.delete(owner)
    released.push(row)
    lastOwnerChange = Date.now()
  })
  await page.exposeBinding("actOnHistoryDrawing",
    (_, thread: Thread, owner: string, action: FunctionUiAction) => {
      const row = owners.get(owner)
      if (!row || row.thread !== thread) throw Error("action dispatched against a retired owner")
      assert.equal(action.pane, `engine:${owner}`)
      assert.equal(action.generation, `generation-${owner}`)
      assert.equal(action.plugin, "test")
      assert.equal(action.handle, 1)
      assert.equal(action.kind, "press")
      actions.push({ ...row, owner, generation: action.generation })
    })

  try {
    await mount(page, `
      import { useLayoutEffect } from 'react';
      import { ChatMessageVirtualList } from './src/renderer/src/components/chat/ChatMessageVirtualList';
      import { ModsChatScope, useModsChatState } from './src/renderer/src/lib/mods-chat-scope';
      {
        const workspace = 'C:/active-owner-fixture';
        const history = Object.fromEntries(['first', 'second'].map(thread => [thread,
          Array.from({ length: thread === 'first' ? 6 : 120 }, (_, index) => ({
            id: thread + '-' + index, role: 'assistant',
            content: 'RAW HISTORY ' + thread + '-' + index, created_at: new Date()
          }))]));
        const reads = new Map(), cancels = [], noop = () => {}, empty = new Map();
        const delayOnce = new Set(['first-1', 'first-3']);
        let sequence = 0;
        if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value: () => {
          const bytes = crypto.getRandomValues(new Uint8Array(16));
          return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
        } });
        Object.assign(window.api.mods, {
          chatDisplayCapability: async () => true,
          onCardsChanged: () => noop,
          onConfigurationChanged: () => noop,
          nextSiteReadId: () => 'read-' + (++sequence),
          cancelSiteRead: async id => { cancels.push(id); },
          siteRead: async (thread, component, props, presentationId, messageId, request, owned, readId) => {
            if (component !== 'AssistantMessage')
              return { state: 'inactive', reason: 'no-protection-or-functions' };
            const [id] = JSON.parse(presentationId);
            const owner = await window.mountHistoryDrawing(thread, id);
            if (delayOnce.delete(id))
              await new Promise(resolve => reads.set(readId, resolve));
            return { state: 'mounted', owner, snapshot: {
              key: 'engine:' + owner, id: owner, plugin: 'engine', title: '灵件结果',
              generation: 'generation-' + owner, closeOnEscape: false, rows: 12,
              tree: { type: 'Box', props: {}, children: [
                { type: 'engine', ref: 0 },
                { type: 'Button', props: { key: 'details', label: '详情' },
                  press: { plugin: 'test', handle: 1 } }
              ] },
              nativeContent: { component, nativeUnchanged: false,
                entries: [{ ref: 0, props: { ...props, text: 'PROTECTED ' + id } }] }
            } };
          },
          siteUnmount: (thread, owner) => window.releaseHistoryDrawing(thread, owner),
          siteAct: (thread, owner, action) => window.actOnHistoryDrawing(thread, owner, action)
        });
        function Transcript({ thread }) {
          const state = useModsChatState(thread, workspace,
            { threadId: thread, workspacePath: workspace, incarnation: { token: thread, legacyCreatedAt: 1 } });
          const messages = history[thread];
          const [parent, setParent] = useState(null);
          const viewport = useRef(null), virtual = useRef(null);
          const refs = useRef(new Map()), range = useRef(null);
          useLayoutEffect(() => setParent(viewport.current), []);
          window.activeOwnerHistory.jump = index =>
            virtual.current.scrollToIndex({ index, align: 'center', behavior: 'auto' });
          return <ModsChatScope.Provider value={{ threadId: thread, ...state }}>
            <div data-active-transcript={thread} data-radix-scroll-area-viewport ref={viewport}
              style={{ height: 710, overflow: 'auto', overflowAnchor: 'none' }}>
              <ChatMessageVirtualList projection={{ messages, contentVersion: 1, structureVersion: 1 }}
                visibleMessageIndexes={messages.map((_, index) => index)} lastUserMessageIndex={-1}
                historyHasMore={false} historyPageLoading={false} historyRemainingCount={0}
                historyGapBeforeMessageId={null} canLoadReleasedHistory={false}
                onLoadEarlierHistoryPage={noop} onLoadReleasedHistoryWindow={noop}
                onRestoreLatestHistoryWindow={noop} hookLoggingEnabled={false}
                hookLogBucketByTurnId={empty} detachedHookLogBuckets={[]}
                contentMessageRefs={refs} setMessageRef={() => noop} isLoading={false}
                toolResults={empty} toolCallStates={empty} pendingApprovalToolCallKeys={new Set()}
                pendingApproval={null} autoApproveGitPush={false} onApprovalDecision={noop}
                onEditUserMessage={noop} onSetGoalFromMessage={noop} onForkFromMessage={noop}
                forkingMessageId={null} onOpenHookLogBucket={noop} threadId={thread}
                assistantDurationMsById={empty} userSendTimeLabelById={empty}
                customScrollParent={parent} virtuosoRef={virtual} navigatorVirtualRangeRef={range}
                initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
                onInitialVirtualItemsRendered={noop} onContentHeightChanged={noop}
                onAtBottomStateChange={noop} footer={null}/>
            </div>
          </ModsChatScope.Provider>;
        }
        function Fixture() {
          const [thread, setThread] = useState(null);
          window.activeOwnerHistory.open = setThread;
          return thread ? <Transcript key={thread} thread={thread} /> : null;
        }
        window.activeOwnerHistory = {
          heldReads: () => [...reads.keys()], cancelledReads: () => [...cancels],
          release: () => { for (const resolve of reads.values()) resolve(); reads.clear(); },
          sample: () => {
            const viewport = document.querySelector('[data-active-transcript]');
            const view = viewport?.getBoundingClientRect();
            const rows = Array.from(viewport?.querySelectorAll('[data-chat-message-row]') ?? []);
            const visible = rows.filter(row => {
              const bounds = row.getBoundingClientRect();
              return bounds.bottom > view.top && bounds.top < view.bottom;
            });
            return { mounted: rows.length, visible: visible.length,
              protected: visible.filter(row => row.textContent.includes('PROTECTED ' + row.dataset.chatMessageId)).length,
              raw: !!viewport?.textContent.includes('RAW HISTORY') };
          }
        };
        host.render(<Fixture />);
      }
    `, [browserWorkerPlugin(), {
      name: "active-history-assets",
      setup(builder) {
        builder.onLoad({ filter: /\.png$/ }, args => ({
          contents: readFileSync(args.path), loader: "dataurl"
        }))
        builder.initialOptions.define = {
          ...builder.initialOptions.define, "import.meta.hot": "undefined"
        }
      }
    }])
    // Keep equally short, one-line history rows so the real overscan can exceed the owner budget.
    // The DOM, content, mounted snapshots and row recycling are still production components.
    await page.addStyleTag({ content: `
      [data-active-transcript] [data-chat-message-row] { height: 46px; overflow: hidden; }
      [data-active-transcript] [data-item-index] { padding: 0; }
      [data-active-transcript] [data-function-site="AssistantMessage"] { display: block; }
      [data-active-transcript] [data-function-site="AssistantMessage"] p { margin: 0; }
      [data-active-transcript] button { font: 12px sans-serif; }
    ` })

    await page.evaluate(() => window.activeOwnerHistory.open("first"))
    await page.getByText("PROTECTED first-5", { exact: true }).waitFor()
    await page.waitForFunction(() => window.activeOwnerHistory.heldReads().length === 2)
    const lateReads = await page.evaluate(() => window.activeOwnerHistory.heldReads())
    await page.evaluate(() => window.activeOwnerHistory.open("second"))
    await page.waitForFunction(readIds => readIds.every(id =>
      window.activeOwnerHistory.cancelledReads().includes(id)), lateReads)
    await page.evaluate(() => window.activeOwnerHistory.release())
    await page.waitForFunction(limit => window.activeOwnerHistory.sample().mounted > limit,
      previousPerComponentLimit)

    async function settledVisible() {
      await page.waitForFunction(() => {
        const sample = window.activeOwnerHistory.sample()
        return sample.visible >= 8 && (sample.protected === sample.visible ||
          document.body.textContent.includes('MODS_UI_SITE_LIMIT'))
      })
      // Newly visible reads run first. Give the queue's offscreen lane time to reach its idle point.
      for (let i = 0; i < 25 && Date.now() - lastOwnerChange < 225; i++)
        await page.waitForTimeout(50)
      const sample = await page.evaluate(() => window.activeOwnerHistory.sample())
      samples.push(sample)
      assert.equal(sample.raw, false, "held, rejected or protected reads cannot show raw history")
      assert.equal(sample.protected, sample.visible, "visible short rows must retain protected bodies")
    }

    await settledVisible()
    assert.equal(await page.getByText("PROTECTED first-", { exact: false }).count(), 0)
    assert.equal(count("first"), 0, "closed chat owners, including the late replies, are reclaimed")
    assert(released.some(row => row.messageId === "first-1") &&
      released.some(row => row.messageId === "first-3"), "both deliberately late owners were released")

    // Return to rows fetched while outside the viewport (and still mounted in the overscan).
    await page.evaluate(() => window.activeOwnerHistory.jump(96))
    await settledVisible()
    await page.evaluate(() => window.activeOwnerHistory.jump(116))
    await settledVisible()
    assert.equal(failures.length, 0, "the real Main registry must admit navigated rows without a capacity error")
    assert(peak.second > previousPerComponentLimit && peak.second <= FUNCTION_CHAT_TRANSCRIPT_SITE_LIMIT)

    const row = page.locator('[data-chat-message-id="second-116"]')
    async function clickVisibleRow(previousCount: number) {
      await row.getByRole("button", { name: "详情" }).click()
      for (let i = 0; i < 20 && actions.length === previousCount; i++)
        await page.waitForTimeout(25)
      assert.equal(actions.length, previousCount + 1)
      const action = actions[previousCount]
      assert.equal(action.thread, "second")
      assert.equal(action.messageId, "second-116")
      assert(owners.has(action.owner), "the visible button uses its own active drawing")
      return action
    }
    const initialAction = await clickVisibleRow(0)
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.evaluate(() => window.activeOwnerHistory.open("first"))
      await page.getByText("PROTECTED first-5", { exact: true }).waitFor()
      await page.getByText("PROTECTED first-3", { exact: true }).waitFor()
      for (let i = 0; i < 25 && count("second") > 0; i++) await page.waitForTimeout(50)
      assert.equal(count("second"), 0, "switching back releases every drawing in the larger chat")
      await page.evaluate(() => window.activeOwnerHistory.open("second"))
      await settledVisible()
      assert.equal(count("first"), 0, "the first chat never contributes to the active chat quota")
    }
    const reopenedAction = await clickVisibleRow(1)
    assert.notEqual(reopenedAction.owner, initialAction.owner)
    assert.notEqual(reopenedAction.generation, initialAction.generation)
    assert.equal(failures.length, 0)
    assert.deepEqual(errors, [])
    console.log("PASS active Mods chat history remains readable and interactive across owner pressure")
  } finally {
    await page.screenshot({ path: resolve(output, "active-history.png") }).catch(() => {})
    writeFileSync(resolve(output, "evidence.json"), JSON.stringify({
      peak, failures, released, current: [...owners.values()], actions, samples, errors
    }, null, 2) + "\n")
    for (const site of Object.values(sites)) site.close()
    await browser.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
