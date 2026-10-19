/** Real RuntimeSessions UI with controlled native replies; no runtime or user data is loaded. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium, type Browser, type Page } from "playwright"
import type {
  FunctionRuntimeSession,
  FunctionRuntimeSessions
} from "../src/shared/mods/v2/runtime-sessions"

const root = resolve(__dirname, "..")
const output = resolve(root, "output/runtime-sessions-browser")
const checks: string[] = []
const browserErrors: string[] = []
const pass = (check: string) => {
  checks.push(check)
  console.log("PASS " + check)
}
const row = (
  threadId: string,
  extra: Partial<FunctionRuntimeSession> = {}
): FunctionRuntimeSession => ({
  threadId,
  workspace: `C:/fixture/${threadId}`,
  generation: 7,
  incarnationKey: `native-incarnation-${threadId}`,
  state: "resident",
  canRelease: true,
  canResume: false,
  ...extra
})
const view = (
  sessions: FunctionRuntimeSession[],
  extra: Partial<FunctionRuntimeSessions> = {}
): FunctionRuntimeSessions => ({
  limit: 6,
  resident: sessions.filter((session) => session.state === "resident").length,
  reserved: 0,
  retiring: 0,
  stoppedTotal: sessions.filter((session) => session.state === "stopped").length,
  omitted: 0,
  sessions,
  ...extra
})
const call = (page: Page, code: string) => page.evaluate(code)
const settle = (page: Page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  )
const controls = (page: Page) =>
  call(page, "window.fixture.controls()") as Promise<
    Array<{ kind: "release" | "resume"; session: FunctionRuntimeSession }>
  >
const readCount = (page: Page) => call(page, "window.fixture.reads().length") as Promise<number>
const open = async (page: Page) => {
  if ((await page.locator("details").getAttribute("open")) === null)
    await page.locator("summary").click()
}

async function bundleFixture() {
  const result = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
      import React from "react";
      import {createRoot} from "react-dom/client";
      import {RuntimeSessions} from "./src/renderer/src/components/customize/RuntimeSessions";
      const seed=window.runtimeSeed,host=createRoot(document.getElementById("root"));
      let nativeView=structuredClone(seed.view),props={threadId:seed.threadId??"a",active:true};
      let sequence=0;const calls=[],readPlans=[],actionPlans=[],waiting=new Map(),listeners=new Set();
      if(seed.initialError)readPlans.push({error:seed.initialError});
      const copy=value=>structuredClone(value);
      const stopped=(action,input)=>{
        const next=copy(nativeView),item=next.sessions.find(row=>row.threadId===input.threadId);
        if(!item||item.workspace!==input.workspace||item.generation!==input.generation||
          item.incarnationKey!==input.incarnationKey)throw Error("FIXTURE_NATIVE_STALE");
        if(action==="release"){
          if(!item.canRelease)throw Error("FIXTURE_NATIVE_BLOCKED");
          item.state="stopped";item.canRelease=false;item.canResume=true;
          next.resident--;next.stoppedTotal++;
        }else{
          if(!item.canResume)throw Error("FIXTURE_NATIVE_BLOCKED");
          item.state="resident";item.canRelease=true;item.canResume=false;item.generation++;
          next.resident++;next.stoppedTotal--;
        }
        return next;
      };
      function reply(kind,plan,result){
        if(plan.error&&!plan.hold)return Promise.reject(Error(plan.error));
        if(!plan.hold){if(kind!=="read")nativeView=copy(result);return Promise.resolve(copy(result))}
        const id=++sequence;
        return new Promise((resolve,reject)=>waiting.set(id,{kind,resolve,reject,
          error:plan.error,result:copy(result)}));
      }
      window.api={mods:{
        runtimeSessions:async threadId=>{
          calls.push({kind:"read",threadId});const plan=readPlans.shift()??{};
          return reply("read",plan,plan.view??nativeView);
        },
        releaseRuntimeSession:async input=>{
          calls.push({kind:"release",session:copy(input)});const plan=actionPlans.shift()??{};
          return reply("release",plan,plan.view??stopped("release",input));
        },
        resumeRuntimeSession:async input=>{
          calls.push({kind:"resume",session:copy(input)});const plan=actionPlans.shift()??{};
          return reply("resume",plan,plan.view??stopped("resume",input));
        },
        onConfigurationChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}
      }};
      const render=patch=>{props={...props,...patch};host.render(<RuntimeSessions {...props}/>)};
      window.fixture={
        render,setView:value=>nativeView=copy(value),
        queueRead:plan=>readPlans.push(copy(plan)),queueAction:plan=>actionPlans.push(copy(plan)),
        emit:()=>{for(const listener of listeners)listener()},listeners:()=>listeners.size,
        reads:()=>copy(calls.filter(call=>call.kind==="read")),
        controls:()=>copy(calls.filter(call=>call.kind!=="read")),
        pending:kind=>[...waiting].filter(([,item])=>item.kind===kind).map(([id])=>id),
        finish:(id,preserveNative=false)=>{
          const item=waiting.get(id);if(!item)throw Error("UNKNOWN_FIXTURE_REPLY");waiting.delete(id);
          if(item.error)item.reject(Error(item.error));
          else{if(item.kind!=="read"&&!preserveNative)nativeView=copy(item.result);item.resolve(copy(item.result))}
        }
      };
      render({});
      `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve(root, "src/renderer/src") }
  })
  const cssPath = resolve(root, "src/renderer/src/index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency() {
      /* Build only the real fixture component's CSS; no generated repository files. */
    }
  })
  const candidates = new Scanner({}).scanFiles(
    [
      "src/renderer/src/components/customize/RuntimeSessions.tsx",
      "src/renderer/src/components/ui/button.tsx"
    ].map((path) => ({ content: readFileSync(resolve(root, path), "utf8"), extension: "tsx" }))
  )
  return { script: result.outputFiles[0].text, css: compiler.build(candidates) }
}

async function mount(
  browser: Browser,
  fixture: Awaited<ReturnType<typeof bundleFixture>>,
  seed: { view: FunctionRuntimeSessions; threadId?: string; initialError?: string }
) {
  const page = await browser.newPage({ viewport: { width: 375, height: 850 } })
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => browserErrors.push(error.message))
  await page.setContent('<div id="root" style="padding:12px;min-width:0"></div>')
  await page.addStyleTag({ content: fixture.css })
  await page.evaluate((value) => Object.assign(window, { runtimeSeed: value }), seed)
  await page.addScriptTag({ content: fixture.script })
  await page.locator("summary").waitFor()
  await settle(page)
  await open(page)
  return page
}

async function readRecovery(browser: Browser, fixture: Awaited<ReturnType<typeof bundleFixture>>) {
  const page = await mount(browser, fixture, {
    view: view([row("a")]),
    initialError: "DIAGNOSTIC_TEMPORARILY_UNAVAILABLE"
  })
  try {
    await page
      .getByRole("alert")
      .filter({ hasText: "DIAGNOSTIC_TEMPORARILY_UNAVAILABLE" })
      .waitFor()
    assert.deepEqual(await controls(page), [])
    await page.getByRole("button", { name: "刷新占用", exact: true }).click()
    await page.getByText("当前聊天 · 已启动", { exact: true }).waitFor()
    assert.equal(await page.getByRole("alert").count(), 0)
    assert.equal(await readCount(page), 2)
    assert.deepEqual(await controls(page), [])
    pass("diagnostic failure clears after a successful refresh without starting any runtime")
  } finally {
    await page.close()
  }
}

async function confirmedControls(
  browser: Browser,
  fixture: Awaited<ReturnType<typeof bundleFixture>>
) {
  const page = await mount(browser, fixture, {
    view: view([row("a", { title: "测试任务甲" })])
  })
  try {
    await page.clock.install()
    await call(
      page,
      "window.fixture.queueRead({hold:true,view:{...window.runtimeSeed.view,error:'OLD_POLL_RESPONSE'}});window.fixture.emit()"
    )
    await page.waitForFunction("window.fixture.pending('read').length===1")
    const oldRead = await call(page, "window.fixture.pending('read')[0]")
    await page.getByRole("button", { name: "停止并释放", exact: true }).click()
    assert.deepEqual(await controls(page), [])
    const targetCard = page.getByText("C:/fixture/a", { exact: true }).locator("..")
    assert.equal(await targetCard.getByRole("button", { name: "确认", exact: true }).count(), 1)
    assert(
      await targetCard
        .getByRole("alert")
        .getByText(/测试任务甲/)
        .isVisible()
    )
    await page.getByRole("button", { name: "取消", exact: true }).click()
    assert.deepEqual(await controls(page), [])
    await call(page, "window.fixture.queueAction({hold:true})")
    await page.getByRole("button", { name: "停止并释放", exact: true }).click()
    await page.getByRole("button", { name: "确认", exact: true }).click()
    await page.waitForFunction("window.fixture.pending('release').length===1")
    assert.equal((await controls(page)).length, 1)
    assert(await page.getByRole("button", { name: "正在处理…", exact: true }).isDisabled())
    await page
      .getByRole("button", { name: "正在处理…", exact: true })
      .evaluate((button) => (button as HTMLButtonElement).click())
    const reads = await readCount(page)
    await call(page, `window.fixture.finish(${oldRead});window.fixture.emit()`)
    await page.clock.fastForward(15000)
    assert.equal(await readCount(page), reads)
    assert.equal(await page.getByText("OLD_POLL_RESPONSE", { exact: true }).count(), 0)
    assert.equal((await controls(page)).length, 1)
    await call(page, "window.fixture.finish(window.fixture.pending('release')[0])")
    await page.getByText("当前聊天 · 已停止并释放", { exact: true }).waitFor()
    await page.clock.fastForward(10000)
    await call(page, "window.fixture.emit()")
    assert.equal((await controls(page)).filter((item) => item.kind === "resume").length, 0)
    await page.getByRole("button", { name: "明确恢复组件", exact: true }).click()
    assert.equal((await controls(page)).length, 1)
    await page.getByRole("button", { name: "取消", exact: true }).click()
    await call(page, "window.fixture.queueAction({hold:true})")
    await page.getByRole("button", { name: "明确恢复组件", exact: true }).click()
    await page.getByRole("button", { name: "确认", exact: true }).click()
    await page.waitForFunction("window.fixture.pending('resume').length===1")
    const calls = await controls(page)
    assert.deepEqual(
      calls.map((item) => item.kind),
      ["release", "resume"]
    )
    for (const request of calls)
      assert.deepEqual(
        {
          threadId: request.session.threadId,
          workspace: request.session.workspace,
          generation: request.session.generation,
          incarnationKey: request.session.incarnationKey
        },
        {
          threadId: "a",
          workspace: "C:/fixture/a",
          generation: 7,
          incarnationKey: "native-incarnation-a"
        }
      )
    await call(page, "window.fixture.finish(window.fixture.pending('resume')[0])")
    await page.getByText("当前聊天 · 已启动", { exact: true }).waitFor()
    assert.deepEqual(
      (await controls(page)).map((item) => item.kind),
      ["release", "resume"]
    )
    pass(
      "release and resume each require confirmation and run once; stopped sessions never auto-resume"
    )
    pass(
      "pending control rejects an older poll reply and suppresses periodic/configuration refreshes"
    )

    await call(page, "window.fixture.queueAction({error:'EXIT_UNCONFIRMED'})")
    await page.getByRole("button", { name: "停止并释放", exact: true }).click()
    await page.getByRole("button", { name: "确认", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "EXIT_UNCONFIRMED" }).waitFor()
    await page.getByRole("button", { name: "刷新占用", exact: true }).waitFor({ state: "visible" })
    await settle(page)
    assert(await page.getByRole("alert").filter({ hasText: "EXIT_UNCONFIRMED" }).isVisible())
    await page.getByRole("button", { name: "刷新占用", exact: true }).click()
    await page
      .getByRole("alert")
      .filter({ hasText: "EXIT_UNCONFIRMED" })
      .waitFor({ state: "detached" })
    assert.equal((await controls(page)).length, 3)
    pass(
      "a failed control remains visible after its automatic diagnostic refresh until a normal refresh"
    )
  } finally {
    await page.close()
  }
}

async function staleReads(browser: Browser, fixture: Awaited<ReturnType<typeof bundleFixture>>) {
  const page = await mount(browser, fixture, { view: view([row("a")]) })
  try {
    await page.clock.install()
    await call(
      page,
      "window.fixture.queueRead({hold:true,view:{...window.runtimeSeed.view,error:'OLD_A_READ'}});window.fixture.emit()"
    )
    await page.waitForFunction("window.fixture.pending('read').length===1")
    const oldA = await call(page, "window.fixture.pending('read')[0]")
    await call(
      page,
      `window.fixture.setView(${JSON.stringify(view([row("b")]))});window.fixture.render({threadId:'b'})`
    )
    await page.getByText("C:/fixture/b", { exact: true }).waitFor()
    await call(page, `window.fixture.finish(${oldA})`)
    await settle(page)
    assert.equal(await page.getByText("OLD_A_READ", { exact: true }).count(), 0)
    assert(await page.getByText("C:/fixture/b", { exact: true }).isVisible())
    await call(
      page,
      "window.fixture.queueRead({hold:true,view:{...window.runtimeSeed.view,error:'OLD_ACTIVE_READ'}});window.fixture.emit()"
    )
    await page.waitForFunction("window.fixture.pending('read').length===1")
    const oldActive = await call(page, "window.fixture.pending('read')[0]")
    await call(page, "window.fixture.render({active:false})")
    await page.waitForFunction("window.fixture.listeners()===0")
    const reads = await readCount(page)
    await call(page, `window.fixture.finish(${oldActive});window.fixture.emit()`)
    await page.clock.fastForward(15000)
    assert.equal(await readCount(page), reads)
    assert.equal(await page.getByText("OLD_ACTIVE_READ", { exact: true }).count(), 0)
    await call(page, "window.fixture.render({active:true})")
    await page.waitForFunction(`window.fixture.reads().length===${reads + 1}`)
    await settle(page)
    assert(await page.getByText("C:/fixture/b", { exact: true }).isVisible())
    assert.equal(await page.getByRole("alert").count(), 0)
    assert.deepEqual(await controls(page), [])
    pass(
      "thread changes and inactive scopes invalidate old reads, remove listeners/timers and never issue controls"
    )
  } finally {
    await page.close()
  }
}

async function staleControls(browser: Browser, fixture: Awaited<ReturnType<typeof bundleFixture>>) {
  const page = await mount(browser, fixture, { view: view([row("a")]) })
  try {
    await call(
      page,
      "window.fixture.queueAction({hold:true,view:{...window.runtimeSeed.view,error:'OLD_A_CONTROL'}})"
    )
    await page.getByRole("button", { name: "停止并释放", exact: true }).click()
    await page.getByRole("button", { name: "确认", exact: true }).click()
    await page.waitForFunction("window.fixture.pending('release').length===1")
    const oldA = await call(page, "window.fixture.pending('release')[0]")
    await call(page, "window.fixture.render({threadId:'b',active:false})")
    await page.waitForFunction("window.fixture.listeners()===0")
    await call(
      page,
      `window.fixture.setView(${JSON.stringify(view([row("b")]))});window.fixture.render({active:true})`
    )
    await page.getByText("C:/fixture/b", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "确认", exact: true }).count(), 0)
    assert.equal((await controls(page)).length, 1)
    await call(page, "window.fixture.queueAction({hold:true})")
    await page.getByRole("button", { name: "停止并释放", exact: true }).click()
    await page.getByRole("button", { name: "确认", exact: true }).click()
    await page.waitForFunction("window.fixture.pending('release').length===2")
    const reads = await readCount(page)
    await call(page, `window.fixture.finish(${oldA},true)`)
    await settle(page)
    assert.equal(await page.getByText("OLD_A_CONTROL", { exact: true }).count(), 0)
    assert(await page.getByText("C:/fixture/b", { exact: true }).isVisible())
    assert(await page.getByRole("button", { name: "正在处理…", exact: true }).isDisabled())
    assert.equal(await readCount(page), reads)
    const calls = await controls(page)
    assert.deepEqual(
      calls.map((item) => [item.kind, item.session.threadId]),
      [
        ["release", "a"],
        ["release", "b"]
      ]
    )
    assert.equal(calls[1].session.incarnationKey, "native-incarnation-b")
    await call(page, "window.fixture.finish(window.fixture.pending('release')[0])")
    await page.getByText("当前聊天 · 已停止并释放", { exact: true }).waitFor()
    assert.equal((await controls(page)).length, 2)
    pass(
      "late controls from a retired chat cannot overwrite or settle the new chat's pending control"
    )
  } finally {
    await page.close()
  }
}

async function boundedMobile(browser: Browser, fixture: Awaited<ReturnType<typeof bundleFixture>>) {
  const stopped = (id: string) => row(id, { state: "stopped", canRelease: false, canResume: true })
  const current = stopped("old-0")
  current.workspace = "C:/fixture/" + "很长的项目目录与文件夹名称/".repeat(18) + "current"
  const readOnly = row("readonly", {
    title: "历史项目检视",
    canRelease: false,
    blocker: "这段聊天为只读"
  })
  const busy = row("timer", { canRelease: false, blocker: "组件仍有后台资源或定时任务" })
  const failed = row("failed", {
    state: "failed",
    canRelease: false,
    error: "组件清理或进程退出尚未确认，名额仍保留。"
  })
  const sessions = [
    readOnly,
    busy,
    failed,
    current,
    ...Array.from({ length: 10 }, (_, i) => stopped(`old-${39 - i}`))
  ]
  const page = await mount(browser, fixture, {
    threadId: "old-0",
    view: view(sessions, { resident: 6, retiring: 1, reserved: 1, stoppedTotal: 40, omitted: 29 })
  })
  try {
    for (const item of [readOnly, busy, failed]) {
      const card = page.getByText(item.workspace, { exact: true }).locator("..")
      assert.equal(await card.getByRole("button").count(), 0)
    }
    assert(await page.getByText("这段聊天为只读", { exact: true }).isVisible())
    assert(await page.getByText("历史项目检视 · 已启动", { exact: true }).isVisible())
    assert(await page.getByText("组件仍有后台资源或定时任务", { exact: true }).isVisible())
    assert(await page.getByText(/另有 1 个运行正在清理/).isVisible())
    assert(await page.getByText(/其中 1 个名额正在启动或等待清理确认/).isVisible())
    assert(await page.getByText(/共 40 段聊天已停止，仅展示最近 10/).isVisible())
    assert(await page.getByText("当前聊天 · 已停止并释放", { exact: true }).isVisible())
    assert.equal(await page.getByRole("button", { name: "明确恢复组件", exact: true }).count(), 11)
    assert.equal(await readCount(page), 1)
    assert.deepEqual(await call(page, "window.fixture.reads()"), [
      { kind: "read", threadId: "old-0" }
    ])
    assert.deepEqual(await controls(page), [])
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    await page.screenshot({ path: resolve(output, "runtime-sessions-mobile.png"), fullPage: true })
    pass(
      "readonly/busy/failed sessions expose no controls; current plus recent stops and omitted/reserved counts remain bounded"
    )
    pass("375px real Tailwind layout wraps long workspace paths without horizontal overflow")
  } finally {
    await page.close()
  }
}

async function reclamationLabels(
  browser: Browser,
  fixture: Awaited<ReturnType<typeof bundleFixture>>
) {
  const page = await mount(browser, fixture, {
    view: view([
      row("probe", {
        state: "discovery",
        autoReclaimable: true,
        guestEntered: false,
        mountedSites: 0
      }),
      row("retained", { autoReclaimable: false, guestEntered: true, mountedSites: 0 })
    ])
  })
  try {
    await open(page)
    assert(
      await page
        .getByText("仅完成登记、尚未使用；名额不足时可自动回收。", { exact: true })
        .isVisible()
    )
    assert(
      await page.getByText("当前未挂载聊天绘制，组件运行状态仍保留。", { exact: true }).isVisible()
    )
    assert.deepEqual(await controls(page), [])
    pass(
      "unused registration probes and detached drawings state their different retention boundaries"
    )
  } finally {
    await page.close()
  }
}

async function main() {
  mkdirSync(output, { recursive: true })
  const fixture = await bundleFixture()
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    await readRecovery(browser, fixture)
    await confirmedControls(browser, fixture)
    await staleReads(browser, fixture)
    await staleControls(browser, fixture)
    await boundedMobile(browser, fixture)
    await reclamationLabels(browser, fixture)
    assert.deepEqual(browserErrors, [])
    writeFileSync(
      resolve(output, "acceptance.json"),
      JSON.stringify({ checks, browserErrors }, null, 2) + "\n"
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
