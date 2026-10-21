/** Repeatable synthetic history observation. No user database, model, source grants or tool execution. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { resolve, join, dirname } from "node:path"
import { chromium, type CDPSession, type Page } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

const sourcePaths = [
  "src/renderer/src/components/chat/ChatMessageVirtualList.tsx",
  "src/renderer/src/components/chat/MessageBubble.tsx",
  "src/renderer/src/components/chat/FunctionSite.tsx",
  "src/renderer/src/components/chat/StreamingMarkdown.tsx",
  "src/renderer/src/components/chat/ChatScrollNavigator.tsx",
  "src/renderer/src/components/chat/ChatMessageScrollArea.tsx",
  "src/renderer/src/components/ui/scroll-area.tsx",
  "src/renderer/src/lib/mods-chat-scope.tsx"
]
const fixtureCssFiles = readdirSync("out/renderer/assets").filter((name) => name.endsWith(".css"))
const fixtureCss = fixtureCssFiles
  .map((name) => readFileSync(resolve("out/renderer/assets", name), "utf8"))
  .join("\n")
// Freeze the same main rendering modules for every scenario, including during parallel development.
// An optional read-only Git snapshot affects only this isolated browser bundle, never the checkout.
const frozenSources = new Map(
  sourcePaths.map((path) => {
    const baseline = Boolean(
      process.env.PERF_BASELINE_COMMIT &&
      (!process.env.PERF_BASELINE_PATHS ||
        process.env.PERF_BASELINE_PATHS.split(",").includes(path))
    )
    const contents = baseline
      ? execFileSync("git", ["show", `${process.env.PERF_BASELINE_COMMIT}:${path}`], {
          encoding: "utf8"
        })
      : readFileSync(path, "utf8")
    return [
      resolve(path),
      {
        path,
        contents,
        sha256: createHash("sha256").update(contents).digest("hex"),
        origin: baseline ? process.env.PERF_BASELINE_COMMIT : "working-tree"
      }
    ] as const
  })
)

async function traceStop(client: CDPSession, output: string) {
  const completed = new Promise<{ stream: string }>((done) =>
    client.once("Tracing.tracingComplete", done)
  )
  await client.send("Tracing.end")
  const { stream } = await completed
  let bytes = ""
  for (;;) {
    const part = await client.send("IO.read", { handle: stream })
    bytes += part.base64Encoded ? Buffer.from(part.data, "base64").toString("utf8") : part.data
    if (part.eof) break
    if (Buffer.byteLength(bytes) > 64 * 1024 * 1024) throw Error("PERFORMANCE_TRACE_LIMIT")
  }
  await client.send("IO.close", { handle: stream })
  writeFileSync(output, bytes)
  const events = JSON.parse(bytes).traceEvents as Array<{ name: string; dur?: number; ph: string }>
  const names = [
    "RunTask",
    "FunctionCall",
    "Layout",
    "UpdateLayoutTree",
    "Paint",
    "RecalculateStyles"
  ]
  return names.map((name) => {
    const durations = events
      .filter((event) => event.name === name && event.ph === "X")
      .map((event) => (event.dur ?? 0) / 1000)
    return {
      name,
      count: durations.length,
      totalMs: durations.reduce((a, b) => a + b, 0),
      maxMs: Math.max(0, ...durations)
    }
  })
}

async function fixture(page: Page, enabled: boolean, delay: number, stableScope: boolean) {
  await mount(
    page,
    `
    const fixtureStyle=document.createElement('style');fixtureStyle.textContent=${JSON.stringify(fixtureCss)};document.head.append(fixtureStyle);
    import {Profiler,useMemo,useLayoutEffect} from 'react';
    import {ChatMessageVirtualList} from ${JSON.stringify(resolve("src/renderer/src/components/chat/ChatMessageVirtualList.tsx"))};
    import {ChatMessageScrollArea} from ${JSON.stringify(resolve("src/renderer/src/components/chat/ChatMessageScrollArea.tsx"))};
    import {ModsChatScope,useModsChatState} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
    import {completedMarkdownParseCache} from ${JSON.stringify(resolve("src/renderer/src/lib/markdown-parse-cache.ts"))};
    {
    const calls=[],commits=[],owners=new Map(),virtual={current:null},range={current:null},refs={current:new Map()},detached=[],initialLocation={index:'LAST',align:'end'};let sequence=0;
    window.api.mods.chatDisplayCapability=async()=>${enabled};
    window.api.mods.onCardsChanged=()=>()=>{};window.api.mods.onConfigurationChanged=()=>()=>{};
    window.api.mods.siteMountOutcome=async(thread,component)=>{const owner='perf-'+(++sequence);owners.set(owner,component);calls.push(['mount',performance.now()]);return {state:'mounted',owner}};
    window.api.mods.siteRender=async(thread,owner,props)=>{calls.push(['render',performance.now()]);if(${delay})await new Promise(done=>setTimeout(done,${delay}));return {key:owner,id:owner,plugin:'perf',generation:owner,title:owners.get(owner),rows:12,closeOnEscape:false,tree:{type:'engine',ref:0},nativeContent:{component:owners.get(owner),entries:[{ref:0,props}],nativeUnchanged:false}}};
    window.api.mods.siteUnmount=async(thread,owner)=>{owners.delete(owner);calls.push(['unmount',performance.now()])};
    const messages=Array.from({length:400},(_,index)=>({id:'perf-'+index,role:index%5===0?'user':'assistant',created_at:new Date(1700000000000+index).toISOString(),content:'PERF_MESSAGE_'+index+'\\n\\n'+Array.from({length:16},(_,section)=>'### Section '+section+'\\n\\nA **deterministic** paragraph with [a reference](https://example.test/reference) and inline \\x60value\\x60.\\n\\n- first item\\n- second item\\n\\n').join('')}));
    const indexes=messages.map((_,index)=>index),noop=()=>{},setRef=()=>noop,emptySet=new Set(),
      maps={tools:new Map(),states:new Map(),hooks:new Map(),durations:new Map(),labels:new Map()};
    function Fixture(){const[parent,setParent]=useState(null),viewport=useRef(null),state=useModsChatState('perf-thread','C:/synthetic-perf'),[tick,setTick]=useState(0);
      useLayoutEffect(()=>{const target=viewport.current.querySelector('[data-radix-scroll-area-viewport]');target.setAttribute('data-perf-viewport','');setParent(target)},[]);
      const stable=useMemo(()=>({threadId:'perf-thread',...state}),[state.enabled,state.ready,state.error,state.retry,state.presentationCache]);
      const production=useMemo(()=>({threadId:'perf-thread',...state}),[state]);
      window.perfFixture={calls,commits,cacheStats:()=>completedMarkdownParseCache.stats(),bump:()=>setTick(value=>value+1),jump:index=>virtual.current.scrollToIndex({index,align:'start',behavior:'auto'})};
      return <ModsChatScope.Provider value={${stableScope ? "stable" : "production"}}>
        <output style={{display:'none'}}>{tick}</output><Profiler id='history' onRender={(id,phase,actualDuration,baseDuration,startTime,commitTime)=>commits.push({phase,actualDuration,baseDuration,startTime,commitTime})}>
        <div style={{height:760,display:'flex',flexDirection:'column'}}><ChatMessageScrollArea scrollRef={viewport} showScrollToBottom={false} hasUnread={false} unreadCount={0} onScrollToBottom={noop}>
        <ChatMessageVirtualList messages={messages} visibleMessageIndexes={indexes} lastUserMessageIndex={395} contentVersion={1}
          historyHasMore={false} historyPageLoading={false} historyRemainingCount={0} onLoadEarlierHistoryPage={noop} historyGapBeforeMessageId={null}
          canLoadReleasedHistory={false} onLoadReleasedHistoryWindow={noop} onRestoreLatestHistoryWindow={noop} hookLoggingEnabled={false}
          hookLogBucketByTurnId={maps.hooks} detachedHookLogBuckets={detached} contentMessageRefs={refs} setMessageRef={setRef} isLoading={false}
          toolResults={maps.tools} toolCallStates={maps.states} pendingApprovalToolCallKeys={emptySet} pendingApproval={null} autoApproveGitPush={false}
          onApprovalDecision={noop} onEditUserMessage={noop} onSetGoalFromMessage={noop} onForkFromMessage={noop} forkingMessageId={null} onOpenHookLogBucket={noop}
          threadId='perf-thread' assistantDurationMsById={maps.durations} userSendTimeLabelById={maps.labels} customScrollParent={parent}
          virtuosoRef={virtual} navigatorVirtualRangeRef={range} initialTopMostItemIndex={initialLocation} onInitialVirtualItemsRendered={noop}
          onContentHeightChanged={noop} onAtBottomStateChange={noop} footer={null}/></ChatMessageScrollArea></div></Profiler></ModsChatScope.Provider>
    }host.render(<Fixture/>)}
  `,
    [
      browserWorkerPlugin(),
      {
        name: "performance-production-profiler",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, (args) => {
            const source = frozenSources.get(resolve(args.path))
            if (source)
              return { contents: source.contents, loader: "tsx", resolveDir: dirname(args.path) }
          })
          builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, (args) => ({
            path: args.path,
            namespace: "perf-thread-context"
          }))
          builder.onLoad({ filter: /.*/, namespace: "perf-thread-context" }, () => ({
            contents:
              "const state={workspacePath:null,workspaceFiles:[]};export const useThreadStateSelector=(id,selector)=>selector(state)"
          }))
          if (process.env.PERF_REACT_PROFILE === "1")
            builder.onResolve({ filter: /^react-dom\/client$/ }, () => ({
              path: resolve("node_modules/react-dom/profiling.js")
            }))
          builder.onLoad({ filter: /\.png$/ }, (args) => ({
            contents: readFileSync(args.path),
            loader: "dataurl"
          }))
          builder.initialOptions.define = {
            ...builder.initialOptions.define,
            "import.meta.hot": "undefined"
          }
        }
      }
    ]
  )
  await page.waitForSelector('[data-chat-initial-presentation="ready"]')
  await page.waitForTimeout(delay + 200)
}

async function observe(page: Page, client: CDPSession, scenario: string, output: string) {
  await client.send("Performance.enable")
  await client.send("Profiler.enable")
  await client.send("Profiler.start")
  const before = await client.send("Performance.getMetrics")
  await client.send("Tracing.start", {
    categories: "devtools.timeline,v8.execute,blink.user_timing",
    transferMode: "ReturnAsStream"
  })
  await page.evaluate(
    (options) => {
      let capturedOversize = false
      const values = {
        frames: [] as number[],
        samples: [] as {
          at: number
          gap: number
          pending: boolean
          empty: boolean
          rows: number
          scrollTop: number
          phase: string
        }[],
        newMax: [] as unknown[],
        phase: "start",
        longTasks: [] as number[],
        pendingFrames: 0,
        mountedPendingFrames: 0,
        emptyFrames: 0,
        maxMountedRows: 0,
        running: true
      }
      ;(window as unknown as { interactionMetrics: typeof values }).interactionMetrics = values
      let previous = performance.now()
      const observer = new PerformanceObserver((list) =>
        values.longTasks.push(...list.getEntries().map((entry) => entry.duration))
      )
      observer.observe({ type: "longtask" })
      const sample = (now: number) => {
        if (!values.running) {
          observer.disconnect()
          return
        }
        const gap = now - previous
        values.frames.push(gap)
        previous = now
        const viewport = document.querySelector<HTMLElement>("[data-perf-viewport]")!
        const rows = [...viewport.querySelectorAll<HTMLElement>("[data-chat-message-id]")]
        if (
          (options.diagnostic && rows.length > values.maxMountedRows) ||
          (options.captureOversize && !capturedOversize && rows.length > 20)
        ) {
          capturedOversize = true
          const edges = [...rows.slice(0, 5), ...rows.slice(-5)].map((row) => {
            const item = row.closest<HTMLElement>("[data-item-index]"),
              rect = row.getBoundingClientRect(),
              itemRect = item?.getBoundingClientRect()
            return {
              id: row.dataset.chatMessageId,
              itemIndex: item?.dataset.itemIndex,
              index: item?.dataset.index,
              knownSize: item?.dataset.knownSize,
              style: item?.getAttribute("style"),
              row: { height: rect.height, top: rect.top, width: rect.width },
              item: itemRect ? { height: itemRect.height, top: itemRect.top } : null
            }
          })
          values.newMax.push({
            at: now,
            phase: values.phase,
            rows: rows.length,
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
            edges
          })
        }
        values.maxMountedRows = Math.max(values.maxMountedRows, rows.length)
        const pending = [...viewport.querySelectorAll<HTMLElement>("[data-function-site-pending]")]
        if (pending.length) values.mountedPendingFrames++
        // Do not force a layout on ordinary frames just to observe that no pending surface exists.
        const bounds = pending.length ? viewport.getBoundingClientRect() : null
        const visiblePending =
          bounds !== null &&
          pending.some((element) => {
            const rect = element.getBoundingClientRect()
            return rect.bottom > bounds.top && rect.top < bounds.bottom
          })
        if (visiblePending) values.pendingFrames++
        if (!rows.length) values.emptyFrames++
        values.samples.push({
          at: now,
          gap,
          pending: visiblePending,
          empty: !rows.length,
          rows: rows.length,
          scrollTop: viewport.scrollTop,
          phase: values.phase
        })
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    },
    {
      diagnostic: process.env.PERF_DIAGNOSTIC === "1",
      captureOversize: process.env.PERF_CAPTURE_OVERSIZE === "1"
    }
  )
  const phase = (value: string) =>
    page.evaluate((value) => {
      ;(window as unknown as { interactionMetrics: { phase: string } }).interactionMetrics.phase =
        value
    }, value)
  const viewport = page.locator("[data-perf-viewport]")
  const box = await viewport.boundingBox()
  assert(box)
  if (process.env.PERF_CAPTURE_OVERSIZE === "1")
    await page.screenshot({ path: join(output, scenario + ".initial-window.png") })
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const track = page.locator('[data-scroll-area-scrollbar][data-orientation="vertical"]')
  await track.waitFor({ state: "visible" })
  const thumb = track.locator(":scope > div")
  const trackBox = await track.boundingBox(),
    thumbBox = await thumb.boundingBox()
  assert(trackBox && thumbBox, "The real Radix vertical thumb must be visible")
  await page.evaluate(() => performance.mark("perf:thumb-drag:start"))
  await phase("drag")
  const dragStart = await page.evaluate(() => performance.now())
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2)
  await page.mouse.down()
  const dragPositions: number[] = []
  for (const fraction of [0.05, 0.85, 0.1, 0.7, 0.02, 0.95]) {
    await page.mouse.move(
      trackBox.x + trackBox.width / 2,
      trackBox.y + trackBox.height * fraction,
      { steps: 5 }
    )
    dragPositions.push(await viewport.evaluate((element) => element.scrollTop))
  }
  await page.mouse.up()
  assert(
    Math.max(...dragPositions) - Math.min(...dragPositions) > box.height * 10,
    "A real thumb drag must cross more than ten viewport heights"
  )
  await page.waitForTimeout(250)
  const dragEnd = await page.evaluate(() => {
    performance.mark("perf:thumb-drag:end")
    return performance.now()
  })
  await phase("wheel")
  for (let step = 0; step < 16; step++) {
    await page.mouse.wheel(0, -480)
    await page.waitForTimeout(24)
  }
  for (const index of [40, 180, 80, 310, 120, 399]) {
    await phase("jump:" + index)
    await page.evaluate(
      (index) =>
        (window as unknown as { perfFixture: { jump(index: number): void } }).perfFixture.jump(
          index
        ),
      index
    )
    await page.waitForTimeout(180)
  }
  await phase("bump")
  const beforeUpdates = await page.evaluate(() => {
    const value = (window as unknown as { perfFixture: { commits: unknown[]; calls: unknown[] } })
      .perfFixture
    return { commits: value.commits.length, calls: value.calls.length }
  })
  for (let tick = 0; tick < 30; tick++)
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          ;(window as unknown as { perfFixture: { bump(): void } }).perfFixture.bump()
          requestAnimationFrame(() => done())
        })
    )
  const measurements = await page.evaluate(() => {
    const target = window as unknown as {
      interactionMetrics: { running: boolean }
      perfFixture: { commits: unknown[]; calls: unknown[]; cacheStats(): unknown }
    }
    target.interactionMetrics.running = false
    return {
      metrics: target.interactionMetrics,
      commits: target.perfFixture.commits,
      calls: target.perfFixture.calls,
      markdownParseCache: target.perfFixture.cacheStats()
    }
  })
  const after = await client.send("Performance.getMetrics")
  const timings = await traceStop(client, join(output, scenario + ".trace.json"))
  const { profile } = await client.send("Profiler.stop")
  writeFileSync(join(output, scenario + ".cpuprofile"), JSON.stringify(profile))
  const samples = new Map<number, number>()
  for (const id of profile.samples ?? []) samples.set(id, (samples.get(id) ?? 0) + 1)
  const hotFunctions = profile.nodes
    .map((node) => ({
      name: node.callFrame.functionName,
      url: node.callFrame.url,
      line: node.callFrame.lineNumber + 1,
      selfSamples: samples.get(node.id) ?? 0
    }))
    .sort((a, b) => b.selfSamples - a.selfSamples)
    .slice(0, 25)
  const counters = [
    "TaskDuration",
    "ScriptDuration",
    "LayoutDuration",
    "RecalcStyleDuration",
    "JSHeapUsedSize",
    "Nodes"
  ].map((name) => ({
    name,
    before: before.metrics.find((x) => x.name === name)?.value,
    after: after.metrics.find((x) => x.name === name)?.value
  }))
  return {
    scenario,
    ...measurements,
    unrelatedUpdates: {
      beforeCommits: beforeUpdates.commits,
      beforeCalls: beforeUpdates.calls,
      afterCommits: measurements.commits.length,
      afterCalls: measurements.calls.length
    },
    counters,
    timings,
    hotFunctions,
    drag: { start: dragStart, end: dragEnd, positions: dragPositions }
  }
}

async function main() {
  const output = resolve(
    "output/chat-interaction-performance",
    process.env.PERF_LABEL ?? String(Date.now())
  )
  mkdirSync(output, { recursive: true })
  const sources = [...frozenSources.values()].map(({ path, sha256, origin }) => ({
    path,
    sha256,
    origin
  }))
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const rows = []
  try {
    for (const scenario of [
      { name: "mods-off", enabled: false, delay: 0, stable: false },
      { name: "mods-on", enabled: true, delay: 0, stable: false },
      { name: "mods-on-stable-scope", enabled: true, delay: 0, stable: true },
      { name: "mods-delayed", enabled: true, delay: 120, stable: false }
    ].filter((value) => !process.env.PERF_SCENARIO || value.name === process.env.PERF_SCENARIO)) {
      const page = await browser.newPage({ viewport: { width: 1180, height: 900 } }),
        errors: string[] = []
      await page.addInitScript("globalThis.__name=(value)=>value")
      page.on("pageerror", (error) => {
        if (!errors.length) console.error(error.stack)
        errors.push(error.message)
      })
      await fixture(page, scenario.enabled, scenario.delay, scenario.stable)
      writeFileSync(
        join(output, scenario.name + ".fixture.js"),
        (await page.locator("script").last().textContent()) ?? ""
      )
      const client = await page.context().newCDPSession(page)
      const row = await observe(page, client, scenario.name, output)
      assert.deepEqual(errors, [])
      rows.push({ ...row, errors })
      writeFileSync(
        join(output, "observations.json"),
        JSON.stringify(
          {
            synthetic: true,
            productionProfilingBuild: process.env.PERF_REACT_PROFILE === "1",
            sourceSnapshots: sources,
            cssBeforeReact: true,
            cssSnapshot: {
              files: fixtureCssFiles,
              sha256: createHash("sha256").update(fixtureCss).digest("hex")
            },
            baselineCommit: process.env.PERF_BASELINE_COMMIT ?? null,
            diagnosticGeometry: process.env.PERF_DIAGNOSTIC === "1",
            limits:
              "Actual virtual list/message/Markdown/site components with mocked transport; excludes full ChatContainer, Electron IPC, real Sidebar DnD and remote model. Tracing/profiling overhead is included consistently.",
            measurementNotes: [
              "Trace categories contain nested events; their totalMs values must not be summed as CPU time.",
              "Performance TaskDuration/ScriptDuration/LayoutDuration/RecalcStyleDuration are cumulative seconds; compare after-before.",
              "CDP Nodes is a page-wide counter, not the live virtual row count; use sampled rows/maxMountedRows for the virtual window.",
              "RAF observation queries mounted rows each frame and reads pending geometry only when pending nodes exist; diagnosticGeometry adds one-off measurements and is not a timing baseline.",
              "The explicit delay scenario injects mock transport latency; it is not measured native IPC latency.",
              "Markdown cache counters observe the new parser cache only; an old source that does not use it reports zero, not zero legacy parser invocations."
            ],
            rows
          },
          null,
          2
        )
      )
      const metrics = row.metrics as unknown as {
        frames: number[]
        longTasks: number[]
        pendingFrames: number
        emptyFrames: number
        maxMountedRows: number
      }
      const frames = [...metrics.frames].sort((a, b) => a - b)
      console.log(
        JSON.stringify({
          scenario: row.scenario,
          frames: frames.length,
          frameP95: frames[Math.floor(frames.length * 0.95)],
          frameMax: Math.max(...frames),
          longTaskCount: metrics.longTasks.length,
          longTaskTotalMs: metrics.longTasks.reduce((sum, value) => sum + value, 0),
          pendingFrames: metrics.pendingFrames,
          emptyFrames: metrics.emptyFrames,
          maxMountedRows: metrics.maxMountedRows,
          updates: row.unrelatedUpdates,
          counters: row.counters
        })
      )
      await client.detach()
      await page.close()
    }
    console.log("ARTIFACTS " + output)
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
