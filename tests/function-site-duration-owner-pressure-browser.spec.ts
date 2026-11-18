/** Real completed chat turns, computed timing, browser scrolling and Main duration owner limits. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { FunctionUiSites } from "../src/main/mods/v2/sites"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

interface DurationSample {
  mounted: number
  visible: number
  committed: number
  rejected: number
  averageTurnHeight: number
  scrollTop: number
}

declare global {
  interface Window {
    durationOwnerHistory: { start(): void; sample(): DurationSample }
  }
}

async function rendererCss() {
  const root = resolve("src/renderer/src")
  const compiler = await compile(readFileSync(resolve(root, "index.css"), "utf8"), {
    base: root, onDependency: () => {}
  })
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.[jt]sx?$/.test(entry.name))
  return compiler.build(new Scanner({}).scanFiles(files.map(entry => ({
    content: readFileSync(resolve(entry.parentPath, entry.name), "utf8"), extension: "tsx"
  }))))
}

async function main() {
  const output = resolve("output/mods-site-limit-20261117", `duration-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const css = await rendererCss()
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    let rejected = 0
    for (const height of [900, 2100]) {
      const page = await browser.newPage({ viewport: { width: 1280, height } })
      page.setDefaultTimeout(12000)
      const errors: string[] = []
      page.on("pageerror", error => errors.push(error.message))
      const sites = new FunctionUiSites({
        plugins: [], assertLive: () => {}, changed: () => {}, publish: async value => value,
        dispatch: async () => null, callback: async () => {}
      })
      const owners = new Map<string, string>()
      const requests: string[] = []
      const failures: Array<{ id: string; code: string }> = []
      const samples: DurationSample[] = []
      let peak = 0
      await page.exposeBinding("mountDurationDrawing", async (_, id: string) => {
        requests.push(id)
        try {
          const owner = await sites.mount("TurnDuration")
          owners.set(owner, id)
          peak = Math.max(peak, owners.size)
          return owner
        } catch (error) {
          failures.push({ id, code: error instanceof Error ? error.message : String(error) })
          throw error
        }
      })
      await page.exposeBinding("releaseDurationDrawing", async (_, owner: string) => {
        await sites.unmount(owner)
        owners.delete(owner)
      })
      try {
        await mount(page, `
          import { useLayoutEffect } from 'react';
          import { ChatMessageVirtualList } from './src/renderer/src/components/chat/ChatMessageVirtualList';
          import { buildMessageBubbleTimingMeta } from './src/renderer/src/lib/message-bubble-timing';
          import { ModsChatScope, useModsChatState } from './src/renderer/src/lib/mods-chat-scope';
          {
            const thread = 'duration-history', workspace = 'C:/duration-owner-fixture';
            const noop = () => {}, empty = new Map();
            const messages = Array.from({ length: 100 }, (_, i) => {
              const start = Date.UTC(2026, 10, 16, 12, 0, i * 3);
              return [
                { id: 'user-' + i, role: 'user', content: '继续', created_at: new Date(start) },
                { id: 'assistant-' + i, role: 'assistant', content: '好的。',
                  created_at: new Date(start + 50), end_at: new Date(start + 1200) }
              ];
            }).flat();
            const timing = buildMessageBubbleTimingMeta(messages);
            Object.assign(window.api.mods, {
              chatDisplayCapability: async () => true, onCardsChanged: () => noop,
              onConfigurationChanged: () => noop,
              siteRead: async (threadId, component, props, identity) => {
                if (component !== 'TurnDuration')
                  return { state: 'inactive', reason: 'no-protection-or-functions' };
                if (props.durationMs !== 1200) throw Error('Expected actual positive elapsed time');
                const [id] = JSON.parse(identity);
                const owner = await window.mountDurationDrawing(id);
                return { state: 'mounted', owner, snapshot: {
                  key: 'engine:' + owner, id: owner, plugin: 'engine', title: '灵件耗时',
                  generation: 'duration-' + owner, closeOnEscape: false, rows: 12,
                  tree: { type: 'Button', props: { key: 'metrics', label: '耗时 1.2s' },
                    press: { plugin: 'test', handle: 1 } },
                  nativeContent: { component, entries: [{ ref: 0, props }] }
                } };
              },
              siteUnmount: (threadId, owner) => window.releaseDurationDrawing(owner)
            });
            function Transcript() {
              const state = useModsChatState(thread, workspace,
                { threadId: thread, workspacePath: workspace,
                  incarnation: { token: thread, legacyCreatedAt: 1 } });
              const [parent, setParent] = useState(null);
              const viewport = useRef(null), virtual = useRef(null);
              const refs = useRef(new Map()), range = useRef(null);
              useLayoutEffect(() => setParent(viewport.current), []);
              return <ModsChatScope.Provider value={{ threadId: thread, ...state }}>
                <div data-duration-transcript data-radix-scroll-area-viewport ref={viewport}
                  style={{ height: 'calc(100vh - 130px)', overflow: 'auto', overflowAnchor: 'none' }}>
                  <ChatMessageVirtualList projection={{ messages, contentVersion: 1, structureVersion: 1 }}
                    visibleMessageIndexes={messages.map((_, index) => index)}
                    lastUserMessageIndex={messages.length - 2}
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
                    {...timing} customScrollParent={parent} virtuosoRef={virtual}
                    navigatorVirtualRangeRef={range} initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
                    onInitialVirtualItemsRendered={noop} onContentHeightChanged={noop}
                    onAtBottomStateChange={noop} footer={null}/>
                </div>
              </ModsChatScope.Provider>;
            }
            window.durationOwnerHistory = {
              start: () => host.render(<Transcript />),
              sample: () => {
                const viewport = document.querySelector('[data-duration-transcript]');
                const view = viewport.getBoundingClientRect();
                const all = [...viewport.querySelectorAll('[data-function-site="TurnDuration"]')];
                const rowBox = site => site.closest('[data-chat-message-row]').getBoundingClientRect();
                const visible = all.filter(site => {
                  const bounds = rowBox(site);
                  return bounds.bottom > view.top && bounds.top < view.bottom;
                });
                const averageTurnHeight = all.length > 1 ?
                  (rowBox(all.at(-1)).top - rowBox(all[0]).top) / (all.length - 1) : 0;
                return { mounted: all.length, visible: visible.length, averageTurnHeight,
                  committed: visible.filter(site => site.querySelector('[data-function-handle]')).length,
                  rejected: visible.filter(site => site.querySelector('[role=alert]')).length,
                  scrollTop: viewport.scrollTop };
              }
            };
          }
        `, [browserWorkerPlugin(), {
          name: "duration-history-assets",
          setup(builder) {
            builder.onLoad({ filter: /\.png$/ }, args => ({
              contents: readFileSync(args.path), loader: "dataurl"
            }))
            builder.initialOptions.define = {
              ...builder.initialOptions.define, "import.meta.hot": "undefined"
            }
          }
        }])
        await page.addStyleTag({ content: css })
        await page.evaluate(() => window.durationOwnerHistory.start())
        await page.getByRole("button", { name: "耗时 1.2s" }).last().waitFor()
        const collect = async () => {
          await page.waitForFunction(() => {
            const next = window.durationOwnerHistory.sample()
            return next.visible > 0 && next.committed + next.rejected === next.visible
          })
          const current = await page.evaluate(() => window.durationOwnerHistory.sample())
          samples.push(current)
        }
        await collect()
        await page.mouse.move(600, 360)
        for (const delta of [
          ...Array<number>(12).fill(-325), ...Array<number>(8).fill(325),
          ...Array<number>(8).fill(-325)
        ]) {
          const previousTop = samples.at(-1)!.scrollTop
          await page.mouse.wheel(0, delta)
          await page.waitForFunction(top => window.durationOwnerHistory.sample().scrollTop !== top,
            previousTop)
          await collect()
        }
        assert(samples.some((sample, i) => i > 0 && sample.scrollTop > samples[i - 1].scrollTop))
        assert(samples.some((sample, i) => i > 0 && sample.scrollTop < samples[i - 1].scrollTop))
        assert.deepEqual(errors, [])
        rejected += failures.length
        console.log(JSON.stringify({ viewportHeight: height, peak, requests: requests.length,
          failures: failures.length, mountPeak: Math.max(...samples.map(sample => sample.mounted)),
          minimumTurnHeight: Math.min(...samples.map(sample => sample.averageTurnHeight)) }))
      } finally {
        await page.screenshot({ path: resolve(output, `duration-${height}.png`) }).catch(() => {})
        writeFileSync(resolve(output, `duration-${height}.json`), JSON.stringify({
          viewportHeight: height, peak, requests, failures, samples, errors
        }, null, 2) + "\n")
        sites.close()
        await page.close()
      }
    }
    assert.equal(rejected, 0, "active duration labels must coexist across the real scroll buffer")
  } finally {
    await browser.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
