/** The real display keeps unavailable Mods separate from failed protected reads. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { chromium } from "playwright"
import { build as buildCss } from "vite"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

interface SiteFixture {
  reads(): number
  notify(mode: string): void
  heldReads(): number
  historyReads(): number
  rejectHeld(): void
  releaseHistory(): void
  openHistory(outputProtected: boolean): void
  navigation(): unknown[]
  writes(): string[]
  displayedRawFallback(): boolean
}

const rawFallback = "用于验证隔离的原始内容"
const protectedText = "已重新读取受保护的会话内容"
const history = [
  { id: "question", role: "user", text: "已核验的历史提问", persisted: "保存的历史提问" },
  {
    id: "first-answer",
    role: "assistant",
    text: "已核验的第一条历史回复",
    persisted: "保存的第一条历史回复"
  },
  {
    id: "second-answer",
    role: "assistant",
    text: "已核验的第二条历史回复",
    persisted: "保存的第二条历史回复"
  }
]

async function main() {
  const output = resolve("output/mods-disabled-display-20261117", `browser-${Date.now()}`)
  const cssBuild = await buildCss({
    configFile: false,
    plugins: [tailwindcss()],
    build: { write: false, rollupOptions: { input: resolve("src/renderer/src/index.css") } }
  })
  const bundles = Array.isArray(cssBuild) ? cssBuild : [cssBuild]
  const css = bundles
    .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
    .flatMap((asset) =>
      asset.type === "asset" && asset.fileName.endsWith(".css")
        ? [
            typeof asset.source === "string"
              ? asset.source
              : Buffer.from(asset.source).toString("utf8")
          ]
        : []
    )
    .join("\n")
  assert(css, "The screenshot must use the application's stylesheet")
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 520 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await mount(
      page,
      `
      import { FunctionSite } from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      import { FunctionMessageText } from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionMessageText.tsx"))};
      import { ModsChatScope, useModsChatState } from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      {
        const threadId = 'a';
        const raw = ${JSON.stringify(rawFallback)};
        const history = ${JSON.stringify(history)};
        const held = [], historyReads = [], configs = new Set(), writes = [], navigation = [];
        let reads = 0, mode = 'MODS_COMPOSITION_REVIEW_REQUIRED';
        let displayedRaw = false;
        new MutationObserver(() => {
          if (document.body.textContent.includes(raw)) displayedRaw = true;
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
        window.addEventListener('claw:sidebar-tab', event => navigation.push(['tab', event.detail]));
        window.addEventListener('claw:runtime-recovery', event => navigation.push(['thread', event.detail.threadId]));
        const mods = window.api.mods;
        mods.chatDisplayCapability = async () => true;
        mods.onConfigurationChanged = listener => {
          configs.add(listener);
          return () => configs.delete(listener);
        };
        mods.onCardsChanged = () => () => {};
        const hostError = code => new Error(
          "Error invoking remote method 'mods:function-site-read': ModError: " + code);
        const drawing = (id, component, props, text) => {
          const owner = 'owner-' + id;
          return { state: 'mounted', owner, snapshot: {
            key: owner, id: owner, plugin: 'engine', generation: owner, title: '会话内容',
            rows: 2, closeOnEscape: false, tree: { type: 'engine', ref: 0 },
            nativeContent: { component, entries: [{ ref: 0, props: { ...props, text } }] }
          } };
        };
        mods.siteRead = async (threadId, component, props, presentationId) => {
          const id = ++reads;
          if (threadId === 'history-protected' || threadId === 'history-default') {
            const row = history.find(item => item.id === presentationId);
            if (!row) throw Error('Unexpected history read');
            return new Promise(resolve => historyReads.push(() => resolve(
              threadId === 'history-protected' ? drawing(id, component, props, row.text) :
                { state: 'inactive', reason: 'no-protection-or-functions' }
            )));
          }
          if (mode === 'hold') return new Promise((_, reject) => held.push(reject));
          if (mode !== 'ready') throw hostError(mode);
          return drawing(id, component, props, ${JSON.stringify(protectedText)});
        };
        mods.siteUnmount = async () => {};
        const unexpected = name => async () => {
          writes.push(name);
          throw Error('Unexpected effect: ' + name);
        };
        for (const name of ['siteAct', 'configureGlobal', 'configure', 'approve', 'approveFunction',
          'enqueue', 'siteMount', 'clawChange', 'clawStart']) {
          mods[name] = unexpected(name);
        }
        window.api.plugins = { ...window.api.plugins, setEnabled: unexpected('plugins.setEnabled') };
        window.api.agent = { ...window.api.agent, invoke: unexpected('agent.invoke') };
        function Fixture() {
          const state = useModsChatState(threadId, 'C:/protected-project');
          return <main className='p-8'>
            <ModsChatScope.Provider value={{ threadId, ...state }}>
              <FunctionSite threadId={threadId} component='AssistantMessage' presentationId='message-1'
                facts={{ text: raw, isFirstOfReply: true }} fallback={<p>{raw}</p>}
                renderNative={safe => <p>{safe.text}</p>} />
            </ModsChatScope.Provider>
          </main>;
        }
        function History({ outputProtected }) {
          const historyThread = outputProtected ? 'history-protected' : 'history-default';
          const state = useModsChatState(historyThread, 'C:/protected-project');
          return <main data-test-history className='space-y-3 p-8'>
            <ModsChatScope.Provider value={{ threadId: historyThread, ...state }}>
              {history.map(row => <article key={row.id} aria-label={row.id}>
                <FunctionMessageText threadId={historyThread} role={row.role} messageId={row.id}
                  text={outputProtected ? raw + row.id : row.persisted} isHistory isExpanded isFirstOfReply
                  fallback={<p>{outputProtected ? raw + row.id : row.persisted}</p>}
                  renderText={safe => <p>{safe}</p>} />
              </article>)}
            </ModsChatScope.Provider>
          </main>;
        }
        function Scenario() {
          const [outputProtected, setOutputProtected] = useState(null);
          window.unavailableSite.openHistory = setOutputProtected;
          return outputProtected === null ? <Fixture /> :
            <History key={String(outputProtected)} outputProtected={outputProtected} />;
        }
        window.unavailableSite = {
          reads: () => reads,
          notify: next => { mode = next; for (const listener of [...configs]) listener(); },
          heldReads: () => held.length,
          historyReads: () => historyReads.length,
          rejectHeld: () => held.splice(0).forEach(reject => reject(hostError('MODS_COMPOSITION_REVIEW_REQUIRED'))),
          releaseHistory: () => historyReads.splice(0).forEach(resolve => resolve()),
          writes: () => [...writes],
          navigation: () => [...navigation, useAppStore.getState().rightModule,
            useAppStore.getState().rightPanelCollapsed],
          displayedRawFallback: () => displayedRaw
        };
        host.render(<Scenario />);
      }
    `,
      [browserWorkerPlugin()]
    )
    await page.addStyleTag({ content: css })
    const site = page.locator('[data-function-site="AssistantMessage"]')
    const alert = site.getByRole("alert")
    const status = site.getByRole("status")
    const settings = site.getByRole("button", { name: "查看灵件配置", exact: true })
    const notify = (mode: string) =>
      page.evaluate(
        (mode) => (Reflect.get(window, "unavailableSite") as SiteFixture).notify(mode),
        mode
      )
    const expectUnavailable = async (message: string) => {
      await status.getByText(message, { exact: true }).waitFor()
      assert.match((await status.getAttribute("class")) ?? "", /\btext-muted-foreground\b/)
      assert.equal(await alert.count(), 0)
      assert.equal(await site.getByRole("button", { name: "重新读取界面", exact: true }).count(), 0)
      assert.equal(await page.getByText(rawFallback, { exact: true }).count(), 0)
    }

    await expectUnavailable("此会话引用的灵件已停用或发生变化，暂时无法显示相关内容。")
    const beforeSettings = await page.evaluate(() =>
      (Reflect.get(window, "unavailableSite") as SiteFixture).reads()
    )
    mkdirSync(output, { recursive: true })
    await page.screenshot({ path: resolve(output, "composition-unavailable.png") })
    await settings.click()
    assert.deepEqual(
      await page.evaluate(() => {
        const fixture = Reflect.get(window, "unavailableSite") as SiteFixture
        return {
          navigation: fixture.navigation(),
          reads: fixture.reads(),
          writes: fixture.writes()
        }
      }),
      {
        navigation: [["tab", "configuration"], ["thread", "a"], "claw", false],
        reads: beforeSettings,
        writes: []
      }
    )

    await notify("MODS_DISABLED")
    await expectUnavailable("灵件当前未启用，相关内容暂时无法显示。")

    await notify("MODS_DISPLAY_DATA_INVALID")
    await alert.getByText("灵件显示更新失败，请重试。", { exact: true }).waitFor()
    assert.match((await alert.getAttribute("class")) ?? "", /\btext-destructive\b/)
    assert.equal(await alert.getByRole("button", { name: "重新读取界面", exact: true }).count(), 1)
    assert.equal(await settings.count(), 0)

    await notify("MODS_HOST_TIMEOUT")
    await alert.getByRole("button", { name: "查看恢复选项", exact: true }).waitFor()
    assert.match((await alert.getAttribute("class")) ?? "", /\btext-destructive\b/)

    await notify("hold")
    await page.waitForFunction(
      () => (Reflect.get(window, "unavailableSite") as SiteFixture).heldReads() > 0
    )
    await notify("ready")
    const drawing = site.getByText(protectedText, { exact: true })
    await drawing.waitFor()
    await page.evaluate(() => (Reflect.get(window, "unavailableSite") as SiteFixture).rejectHeld())
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        )
    )
    assert.equal(await drawing.count(), 1)
    assert.equal(await alert.count(), 0)
    assert.equal(await status.count(), 0)

    // Main decides whether each history row needs protection. Until it responds,
    // neither the original saved text nor a protected drawing is available to display.
    for (const outputProtected of [true, false]) {
      await page.evaluate(
        (enabled) => (Reflect.get(window, "unavailableSite") as SiteFixture).openHistory(enabled),
        outputProtected
      )
      await page.waitForFunction(
        (count) => (Reflect.get(window, "unavailableSite") as SiteFixture).historyReads() === count,
        history.length
      )
      const transcript = page.locator("[data-test-history]")
      for (const { text, persisted } of history) {
        assert.equal(await transcript.getByText(text, { exact: true }).count(), 0)
        assert.equal(await transcript.getByText(persisted, { exact: true }).count(), 0)
      }
      await page.evaluate(() =>
        (Reflect.get(window, "unavailableSite") as SiteFixture).releaseHistory()
      )
      for (const row of history) {
        const article = transcript.getByRole("article", { name: row.id })
        await article
          .getByText(outputProtected ? row.text : row.persisted, { exact: true })
          .waitFor()
        assert.equal(
          await article
            .getByText(outputProtected ? row.persisted : row.text, {
              exact: true
            })
            .count(),
          0
        )
      }
      assert.equal(await transcript.getByRole("alert").count(), 0)
      assert.equal(await transcript.getByRole("status").count(), 0)
      await transcript.screenshot({
        path: resolve(
          output,
          outputProtected ? "cold-history-readable.png" : "cold-history-default-policy.png"
        )
      })
    }
    assert.deepEqual(
      await page.evaluate(() => {
        const fixture = Reflect.get(window, "unavailableSite") as SiteFixture
        return { displayedRaw: fixture.displayedRawFallback(), writes: fixture.writes() }
      }),
      { displayedRaw: false, writes: [] }
    )
    assert.deepEqual(errors, [])
    console.log(
      `PASS cold history renders all three host-protected bodies without errors or raw fallback; ${output}`
    )
    console.log(
      "PASS default policy shows all three saved bodies only after explicit host inactivity"
    )
    console.log(
      "PASS neutral unavailable notices, settings-only navigation, genuine failures and fenced redraw"
    )
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
