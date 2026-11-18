/** Real virtual rows and FunctionSite scheduling with delayed, protected active drawings. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

interface PrefetchFixture {
  open(qualified: boolean): void
  qualify(qualified: boolean): void
  sample(): { held: number[]; read: number[]; raw: boolean; live: number; actions: number }
  finish(index: number): void
  heldReads(): number[]
}

declare global {
  interface Window { historyPrefetch: PrefetchFixture }
}

async function main() {
  const output = resolve("output/mods-active-scroll-20261118", `prefetch-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const errors: string[] = [], checks: unknown[] = []
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
  page.setDefaultTimeout(6000)
  page.on("pageerror", error => errors.push(error.message))
  try {
    await mount(page, `
      import { Virtuoso } from 'react-virtuoso';
      import { FunctionMessageText } from './src/renderer/src/components/chat/FunctionMessageText';
      import { ModsChatScope } from './src/renderer/src/lib/mods-chat-scope';
      import { CHAT_VIRTUAL_OVERSCAN } from './src/renderer/src/components/chat/chat-virtual-overscan';
      {
        crypto.randomUUID ??= () => 'prefetch-' + Math.random().toString(16).slice(2);
        const pending = new Map(), owners = new Set(), reads = [], noop = () => {};
        let sequence = 0, actions = 0;
        const rows = Array.from({ length: 80 }, (_, index) => ({ id: 'row-' + index, index }));
        const onScreen = index => {
          const view = document.querySelector('[data-history-prefetch]')?.getBoundingClientRect();
          const row = document.querySelector('[data-row="' + index + '"]')?.getBoundingClientRect();
          return row && view && row.top < view.bottom && row.bottom > view.top;
        };
        const snapshot = (component, owner, index, props) => ({
          key: 'engine:' + owner, id: owner, plugin: 'engine', generation: 'generation-' + owner,
          title: 'protected active row', closeOnEscape: false, rows: 12,
          tree: { type: 'Box', props: {}, children: [ { type: 'engine', ref: 0 },
            { type: 'Button', props: { key: 'show', label: '灵件操作 ' + index },
              press: { plugin: 'fixture', handle: 1 } } ] },
          nativeContent: { component, nativeUnchanged: false,
            entries: [{ ref: 0, props: { ...props, text: 'SAFE ' + index } }] }
        });
        Object.assign(window.api.mods, {
          onCardsChanged: () => noop, onConfigurationChanged: () => noop,
          siteRead: async (thread, component, props, identity) => {
            const index = Number(identity.split('-').at(-1));
            reads.push(index);
            if (!onScreen(index)) await new Promise(done => pending.set(index, done));
            const owner = thread + ':' + (++sequence);
            owners.add(owner);
            return { state: 'mounted', owner, snapshot: snapshot(component, owner, index, props) };
          },
          siteUnmount: async (thread, owner) => { owners.delete(owner); },
          siteAct: async (thread, owner) => {
            if (!owners.has(owner)) throw Error('retired owner');
            actions++;
          }
        });
        function Fixture() {
          const [mode, setMode] = useState(null), [qualified, setQualified] = useState(false);
          window.historyPrefetch.open = qualified => { setMode(String(qualified)); setQualified(qualified); };
          window.historyPrefetch.qualify = setQualified;
          return mode === null ? null :
            <ModsChatScope.Provider value={{ threadId: mode, enabled: true, ready: true,
              prefetchHistory: qualified }}>
              <Virtuoso key={mode} data-history-prefetch
                style={{ height: 280, width: 720 }} data={rows}
                defaultItemHeight={56} fixedItemHeight={56} increaseViewportBy={CHAT_VIRTUAL_OVERSCAN}
                computeItemKey={(_, row) => row.id} itemContent={(_, row) =>
                  <article data-row={row.index} style={{ height: 56 }}>
                    <FunctionMessageText threadId={mode} role='assistant'
                      messageId={row.id} isHistory text={'RAW ' + row.index} isExpanded isFirstOfReply
                      fallback={<p>RAW {row.index}</p>}
                      renderText={safe => <p data-body style={{ margin: 0 }}>{safe}</p>} />
                  </article>} />
            </ModsChatScope.Provider>;
        }
        window.historyPrefetch = {
          heldReads: () => [...pending.keys()],
          sample: () => ({ held: [...pending.keys()], read: [...reads],
            raw: document.body.textContent.includes('RAW '), live: owners.size, actions }),
          finish: index => { const done = pending.get(index); pending.delete(index); done?.(); }
        };
        host.render(<Fixture />);
      }
    `, [browserWorkerPlugin()])
    await page.evaluate(() => window.historyPrefetch.open(false))
    await page.getByText("SAFE 0", { exact: true }).waitFor()
    await page.waitForFunction(() => window.historyPrefetch.heldReads().length === 1)
    const legacy = await page.evaluate(() => window.historyPrefetch.sample())
    assert.equal(legacy.raw, false)
    checks.push({ qualified: false, snapshot: legacy })
    await page.evaluate(() => window.historyPrefetch.qualify(true))
    await page.getByText("SAFE 0", { exact: true }).waitFor()
    await page.waitForFunction(() => window.historyPrefetch.heldReads().length === 3)
    const prefetch = await page.evaluate(() => window.historyPrefetch.sample())
    assert.equal(prefetch.raw, false)
    assert.equal(prefetch.held.length, 3,
      "two prefetch reads coexist with the original uncompleted background read")
    assert.equal(prefetch.read.filter(index => index === 0).length, 1,
      "changing scheduling eligibility never remounts an already authorized drawing")
    checks.push({ qualified: true, snapshot: prefetch })

    const row = prefetch.held[0]
    await page.evaluate(index => window.historyPrefetch.finish(index), row)
    await page.getByText(`SAFE ${row}`, { exact: true }).waitFor({ state: "attached" })
    await page.mouse.move(300, 160)
    await page.mouse.wheel(0, 56 * row)
    await page.getByText(`SAFE ${row}`, { exact: true }).waitFor()
    await page.getByRole("button", { name: `灵件操作 ${row}`, exact: true }).click()
    await page.waitForFunction(() => window.historyPrefetch.sample().actions === 1)
    const after = await page.evaluate(() => window.historyPrefetch.sample())
    assert.equal(after.raw, false)
    checks.push({ after })
    assert.deepEqual(errors, [])
    console.log("PASS history prefetch uses two protected lanes without restarting authorized drawings")
  } finally {
    await page.screenshot({ path: resolve(output, "prefetch.png") }).catch(() => {})
    writeFileSync(resolve(output, "evidence.json"), JSON.stringify({ checks, errors }, null, 2) + "\n")
    await browser.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
