/** Real virtual rows revisiting a host-authorized native chat body. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

type Scope = "native" | "inactive"
type Traversal = "index" | "wheel"
interface RowSample {
  visible: boolean
  body: boolean
  height: number
  pending: boolean
  inert: boolean
  scrollTop: number
}
interface Fixture {
  open(scope: Scope, fixedRows: boolean): void
  jump(index: number): void
  sample(index: number): RowSample
  jumpAndSample(index: number): Promise<RowSample[]>
  beginFrames(index: number): void
  finishFrames(): Promise<RowSample[]>
  held(index: number): boolean
  hold(index: number): void
  release(): void
  revoke(): void
  fail(): void
  reads(scope: Scope): number
  interactions(): number[]
}

async function main() {
  const output = resolve("output/mods-scroll-continuity-20261117", `browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const evidence: Array<{
    scope: Scope
    traversal: Traversal
    index: number
    expected: number
    frames: RowSample[]
  }> = []
  const errors: string[] = []
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 560 } })
    page.setDefaultTimeout(8000)
    page.on("pageerror", (error) => errors.push(error.message))
    await mount(
      page,
      `
      import { Virtuoso } from 'react-virtuoso';
      import { FunctionMessageText } from './src/renderer/src/components/chat/FunctionMessageText';
      import { ModsChatScope, useModsChatState } from './src/renderer/src/lib/mods-chat-scope';
      import { CHAT_VIRTUAL_OVERSCAN } from './src/renderer/src/components/chat/chat-virtual-overscan';
      {
        const history = Array.from({ length: 120 }, (_, index) => ({ id: 'history-' + index,
          role: index % 2 ? 'assistant' : 'user', text: '已保存的历史消息 ' + index }));
        const configs = new Set(), pending = [], reads = [], interactions = [];
        const inactive = { state: 'inactive', reason: 'no-protection-or-functions' };
        const workspace = 'C:/history';
        const virtual = { current: null };
        const heldRows = new Set();
        let activeFrames;
        const mods = window.api.mods;
        mods.chatDisplayCapability = async thread => thread.startsWith('inactive:');
        mods.onConfigurationChanged = listener => {
          configs.add(listener); return () => configs.delete(listener);
        };
        mods.onCardsChanged = () => () => {};
        mods.siteRead = async (thread, component, props, presentationId) => {
          const [messageId] = JSON.parse(presentationId);
          const index = Number(messageId.slice('history-'.length));
          reads.push({ thread, index });
          if (!heldRows.has(index)) return inactive;
          return new Promise((resolve, reject) => pending.push({ index, resolve, reject }));
        };
        const openRow = index => virtual.current.scrollToIndex({ index, align: 'center', behavior: 'auto' });
        const sample = index => {
          const viewport = document.querySelector('[data-virtual-history]');
          if (!viewport) return { visible: false, body: false, height: 0, pending: false, inert: false, scrollTop: 0 };
          const row = viewport.querySelector('[data-row="' + index + '"]');
          const rect = row?.getBoundingClientRect(), view = viewport.getBoundingClientRect();
          const body = row?.querySelector('[data-body]');
          return {
            visible: Boolean(rect && rect.bottom > view.top && rect.top < view.bottom),
            body: body?.textContent === history[index].text,
            height: rect?.height ?? 0, pending: !!row?.querySelector('[data-function-site-pending]'),
            inert: !!body?.closest('[inert]'),
            scrollTop: viewport.scrollTop
          };
        };
        const sampleFrames = async index => {
          const frames = [];
          for (let frame = 0; frame < 12; frame++) {
            await new Promise(done => requestAnimationFrame(done));
            frames.push(sample(index));
          }
          return frames;
        };
        function History({ threadId, fixedRows }) {
          const state = useModsChatState(threadId, workspace,
            { threadId, workspacePath: workspace, incarnation: { token: threadId, legacyCreatedAt: 1 } });
          return <ModsChatScope.Provider value={{ threadId, ...state }}>
            <Virtuoso ref={virtual} data-virtual-history style={{ width: 720, height: 420 }}
              data={history} defaultItemHeight={104} increaseViewportBy={CHAT_VIRTUAL_OVERSCAN}
              fixedItemHeight={fixedRows ? 104 : undefined}
              computeItemKey={(_, row) => row.id} itemContent={(index, row) => {
                const body = text => <div style={{ minHeight: 96 }}>
                  <p data-body style={{ margin: 0 }}>{text}</p>
                  <button type='button' onClick={() => interactions.push(index)}>消息操作</button>
                </div>;
                return <article data-row={index} style={{ padding: '4px 0', minHeight: fixedRows ? 104 : undefined,
                  boxSizing: 'border-box' }}>
                  <FunctionMessageText threadId={threadId} role={row.role} messageId={row.id}
                    presentationId={JSON.stringify([row.id, 0])} isHistory isExpanded
                    isFirstOfReply text={row.text}
                    fallback={body(row.text)} renderText={body} />
                </article>;
              }} />
          </ModsChatScope.Provider>;
        }
        function Scenario() {
          const [{ scope, fixedRows }, setOptions] = useState({ scope: 'native', fixedRows: false });
          window.inactiveContinuity.open = (scope, fixedRows) => setOptions({ scope, fixedRows });
          const threadId = scope + (fixedRows ? ':fixed' : ':measured');
          return <History key={threadId} threadId={threadId} fixedRows={fixedRows} />;
        }
        window.inactiveContinuity = {
          jump: openRow, sample,
          jumpAndSample: index => { openRow(index); return sampleFrames(index); },
          beginFrames: index => { activeFrames = sampleFrames(index); },
          finishFrames: () => activeFrames,
          held: index => pending.some(read => read.index === index),
          hold: index => heldRows.add(index),
          release: () => { heldRows.clear(); pending.splice(0).forEach(read => read.resolve(inactive)); },
          revoke: () => { for (const listener of [...configs]) listener(); },
          fail: () => { heldRows.clear(); pending.splice(0).forEach(read =>
            read.reject(Error('MODS_UI_SITE_PROTECTION_REQUIRED'))); },
          reads: scope => reads.filter(read => read.thread.startsWith(scope + ':')).length,
          interactions: () => interactions.slice()
        };
        host.render(<Scenario />);
      }
    `,
      [browserWorkerPlugin()]
    )
    await page.addStyleTag({ content: "[data-function-site-pending] { min-height: 40px }" })
    const jump = (index: number) =>
      page.evaluate(
        (index) => (Reflect.get(window, "inactiveContinuity") as Fixture).jump(index),
        index
      )
    const release = () =>
      page.evaluate(() => (Reflect.get(window, "inactiveContinuity") as Fixture).release())
    const waitForBody = (index: number) =>
      page.waitForFunction((index) => {
        const row = (Reflect.get(window, "inactiveContinuity") as Fixture).sample(index)
        return row.visible && row.body
      }, index)
    const interactions = () =>
      page.evaluate(() => (Reflect.get(window, "inactiveContinuity") as Fixture).interactions())
    const sample = (index: number) =>
      page.evaluate(
        (index) => (Reflect.get(window, "inactiveContinuity") as Fixture).sample(index),
        index
      )
    const baseline = async (index: number) => {
      await jump(index)
      await waitForBody(index)
      return sample(index)
    }
    const wheel = async (index: number, top: number) => {
      const delta = top - (await sample(index)).scrollTop
      assert.notEqual(delta, 0, "Physical wheel must move to another region")
      await page.mouse.move(300, 210)
      await page.evaluate(
        (index) => (Reflect.get(window, "inactiveContinuity") as Fixture).beginFrames(index),
        index
      )
      await page.mouse.wheel(0, delta)
      return page.evaluate(() =>
        (Reflect.get(window, "inactiveContinuity") as Fixture).finishFrames()
      )
    }
    const targets = [6, 89]
    for (const [scope, traversal] of [
      ["native", "index"],
      ["native", "wheel"],
      ["inactive", "index"],
      ["inactive", "wheel"]
    ] as const) {
      const holdFirstRead = scope === "inactive" && traversal === "index"
      // Fixed outer heights for physical wheel isolate body painting from scroll-position
      // corrections. The API-jump cases retain Virtuoso's actual height measurements.
      await page.evaluate(
        ({ scope, fixedRows, holdFirstRead }) => {
          const fixture = Reflect.get(window, "inactiveContinuity") as Fixture
          if (holdFirstRead) fixture.hold(0)
          fixture.open(scope, fixedRows)
        },
        { scope, fixedRows: traversal === "wheel", holdFirstRead }
      )
      if (holdFirstRead) {
        await page.waitForFunction(() =>
          (Reflect.get(window, "inactiveContinuity") as Fixture).held(0)
        )
        assert.equal(
          await page.locator('[data-row="0"] [data-body]').count(),
          0,
          "First visit must wait for a host decision"
        )
        await release()
      }
      await waitForBody(0)
      const baselines = new Map<number, RowSample>()
      const wheelPositions = new Map<number, number>()
      for (const index of targets) {
        const first = await baseline(index)
        baselines.set(index, first)
        wheelPositions.set(index, first.scrollTop)
      }
      for (const index of traversal === "index" ? [...targets, ...targets] : targets) {
        await page.locator(`[data-row="${index}"]`).waitFor({ state: "detached" })
        await page.evaluate(
          (index) => (Reflect.get(window, "inactiveContinuity") as Fixture).hold(index),
          index
        )
        const frames =
          traversal === "wheel"
            ? await wheel(index, wheelPositions.get(index)!)
            : await page.evaluate(
                (index) =>
                  (Reflect.get(window, "inactiveContinuity") as Fixture).jumpAndSample(index),
                index
              )
        evidence.push({ scope, traversal, index, expected: baselines.get(index)!.height, frames })
        if (
          scope === "inactive" &&
          index === targets[0] &&
          evidence.filter((visit) => visit.scope === scope).length === 1
        ) {
          await page.locator("[data-virtual-history]").screenshot({
            path: resolve(output, "inactive-revisit-while-reading.png")
          })
        }
        const row = page.locator(`[data-row="${index}"]`)
        if (scope === "inactive" && frames.some((frame) => frame.visible && frame.body)) {
          const cachedControl = row.locator("[data-function-site-cached][inert] button")
          assert.equal(await cachedControl.count(), 1)
          const beforeClick = await interactions()
          await cachedControl.dispatchEvent("click")
          assert.deepEqual(await interactions(), beforeClick, "A retained drawing cannot act")
        }
        await release()
        await waitForBody(index)
        wheelPositions.set(index, (await sample(index)).scrollTop)
        if (scope === "inactive") {
          const beforeClick = await interactions()
          await row.getByRole("button", { name: "消息操作" }).click()
          assert.deepEqual(
            await interactions(),
            [...beforeClick, index],
            "Fresh native authority restores ordinary message controls"
          )
        }
      }
      if (scope === "native") {
        assert.equal(
          await page.evaluate(() =>
            (Reflect.get(window, "inactiveContinuity") as Fixture).reads("native")
          ),
          0
        )
      }
    }
    const finalTarget = targets[1]
    await page.evaluate((index) => {
      const fixture = Reflect.get(window, "inactiveContinuity") as Fixture
      fixture.hold(index)
      fixture.revoke()
    }, finalTarget)
    await page.waitForFunction(
      (index) => (Reflect.get(window, "inactiveContinuity") as Fixture).held(index),
      finalTarget
    )
    const revoked = page.locator(`[data-row="${finalTarget}"]`)
    await revoked.locator("[data-body]").waitFor({ state: "detached" })
    await page.evaluate(() => (Reflect.get(window, "inactiveContinuity") as Fixture).fail())
    await revoked.getByRole("alert").waitFor()
    assert.equal(await revoked.locator("[data-body]").count(), 0)

    for (const scope of ["native", "inactive"] as const) {
      const revisits = evidence.filter((record) => record.scope === scope)
      for (const record of revisits) {
        assert(
          record.frames.filter((frame) => frame.visible).length >= 4,
          `Must sample the revisited row for multiple frames: ${JSON.stringify(record)}`
        )
      }
      const flicker = revisits.flatMap(({ traversal, index, expected, frames }) =>
        frames
          .filter(
            (frame) =>
              frame.visible &&
              (!frame.body ||
                Math.abs(frame.height - expected) > 1 ||
                (scope === "inactive" && !frame.inert))
          )
          .map((frame) => ({ traversal, index, expected, frame }))
      )
      assert.equal(
        flicker.length,
        0,
        `${scope} revisits must preserve displayed bodies and heights without cached actions: ${JSON.stringify(flicker.slice(0, 4))}`
      )
      console.log(
        `PASS ${scope}: API jumps and wheel reversals preserve virtual row bodies and heights`
      )
    }
    assert.deepEqual(errors, [])
  } finally {
    writeFileSync(resolve(output, "frames.json"), JSON.stringify({ evidence, errors }, null, 2))
    console.log(`Virtual revisit frames: ${output}`)
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
