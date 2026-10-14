/** Owned production-profile measurement; no model credentials or private test IPC. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { appendFileSync, createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication } from "playwright"
import AdmZip from "adm-zip"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import { installConversationFrameProbe } from "./support/conversation-frame-probe"
import { writeLargeEvidence } from "./support/write-large-evidence"

const root = resolve(__dirname, "..")
assert(process.env.CMB_MODS_PACKAGED_DIR)
const artifacts = resolve(process.env.CMB_MODS_CORE_E2E_ARTIFACTS!)
assert(!existsSync(artifacts))
mkdirSync(artifacts, { recursive: true })
const { isolated, workspace, env } = compositionEnvironment(root)
const launch = createModsCoreLauncher(root, isolated, env, artifacts)
const profiling = process.env.CMB_STABILITY_PROFILE !== "0"
const preflightProfile = process.env.CMB_STABILITY_PREFLIGHT_PROFILE === "1"
assert(!preflightProfile || profiling)
const paced = process.env.CMB_STABILITY_PACED === "1"
const schemaInvalidation = process.env.CMB_STABILITY_SCHEMA_INVALIDATION === "1"
const schemaZip = new AdmZip()
if (schemaInvalidation) {
  schemaZip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name: "owned-schema-refresh", version: "1.0.0" }))
  )
  schemaZip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  schemaZip.addFile(
    "hooks/register.ts",
    Buffer.from(
      `export function register(on) { on("tool.call", {tool:"read_file"}, async ($,e,next) => { await $.ui.invalidate("config.describe"); return next(e) }) }`
    )
  )
}
const complexStream = process.env.CMB_STABILITY_COMPLEX === "1"
const fixtureReadPath = join(workspace, "stream-read-fixture.txt")
if (complexStream) writeFileSync(fixtureReadPath, "OWNED_STREAM_READ_OK")
const frameProbe = process.env.CMB_STABILITY_FRAME_PROBE === "1"
const inputDiagnostics = process.env.CMB_STABILITY_INPUT_DIAGNOSTICS === "1"
const inputPresentationProbe = process.env.CMB_STABILITY_INPUT_PRESENTATION_PROBE === "1"
const requestedTurns = process.env.CMB_STABILITY_TURNS
  ? Number(process.env.CMB_STABILITY_TURNS)
  : undefined
assert(
  requestedTurns === undefined ||
    (Number.isInteger(requestedTurns) && requestedTurns >= 1 && requestedTurns <= 12)
)
const turns = preflightProfile ? 1 : (requestedTurns ?? (paced ? 2 : 5))
const evidence: Record<string, unknown> = {
  isolated,
  workspace,
  profiling,
  profileStage: preflightProfile ? "first-request-preflight" : "whole-mode",
  outputPolicy: false,
  paced,
  frameProbe,
  inputDiagnostics,
  inputPresentationProbe,
  complexStream,
  schemaInvalidation,
  passed: false
}
async function hashAsar() {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(
    join(process.env.CMB_MODS_PACKAGED_DIR!, "resources/app.asar")
  ))
    hash.update(chunk)
  return hash.digest("hex")
}
const rounds: Array<Record<string, unknown>> = []
evidence.rounds = rounds
let app: ElectronApplication | undefined
let calls = 0
let responseMarker = ""
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions")
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    assert(Buffer.concat(chunks).length < 8 * 1024 * 1024)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      model: string
      messages?: Array<{ role: string; tool_call_id?: string; content?: unknown }>
      tools?: Array<{ function?: { name?: string } }>
    }
    assert(++calls <= 40)
    const toolId = `owned-read-${responseMarker}`
    const toolResult = body.messages?.find(
      (message) => message.role === "tool" && message.tool_call_id === toolId
    )
    const firstPhase = complexStream && !toolResult
    if (complexStream) {
      assert(
        body.tools?.some((tool) => tool.function?.name === "read_file"),
        "Actual read_file schema required"
      )
      if (toolResult)
        assert(
          JSON.stringify(toolResult.content).includes("OWNED_STREAM_READ_OK"),
          "Original tool must read the owned fixture"
        )
    }
    if (preflightProfile && calls === 1) {
      assert(app)
      await app.evaluate(`(async () => {
        const measurement=globalThis.__stabilityProfile;
        measurement.early=await measurement.post('Profiler.stop');
      })()`)
    }
    if (rounds.at(-1)) {
      rounds.at(-1)!.serverFirstSseAt ??= Date.now()
      const phases = (rounds.at(-1)!.modelPhases ??= []) as unknown[]
      phases.push({
        time: Date.now(),
        call: calls,
        phase: firstPhase ? "reasoning-text-read" : toolResult ? "after-real-read" : "plain",
        verifiedRead: Boolean(toolResult)
      })
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const emit = (delta: unknown, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: `perf-${calls}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      )
    if (firstPhase) {
      for (let i = 0; i < 12; i++) {
        emit({
          ...(i === 0 ? { role: "assistant" } : {}),
          reasoning_content: "先检查隔离目录中的只读样本。"
        })
        await new Promise<void>((done) => setTimeout(done, 25))
      }
    }
    const chunkCount = complexStream ? 22 : 302
    for (let index = 0; index < chunkCount; index++) {
      const content =
        index === 0
          ? `${responseMarker}_${toolResult ? "AFTER_TOOL" : "FIRST"}\n`
          : index === chunkCount - 1
            ? `\n${responseMarker}_${firstPhase ? "BEFORE_TOOL" : "DONE"}`
            : "固定的本地性能样本。"
      res.write(
        `data: ${JSON.stringify({
          id: `perf-${calls}`,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              delta: { ...(index === 0 ? { role: "assistant" } : {}), content },
              finish_reason: null
            }
          ]
        })}\n\n`
      )
      if (paced) await new Promise<void>((done) => setTimeout(done, complexStream ? 100 : 10))
    }
    if (firstPhase) {
      emit({
        tool_calls: [
          {
            index: 0,
            id: toolId,
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ file_path: fixtureReadPath })
            }
          }
        ]
      })
      emit({}, "tool_calls")
      res.end("data: [DONE]\n\n")
      return
    }
    if (rounds.at(-1)) rounds.at(-1)!.serverEndAt = Date.now()
    res.end(
      `data: ${JSON.stringify({
        id: `perf-${calls}`,
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1500 * calls,
          completion_tokens: 1800,
          total_tokens: 1500 * calls + 1800
        }
      })}\n\ndata: [DONE]\n\n`
    )
  } catch (error) {
    evidence.serverError = String(error)
    if (!res.headersSent) res.writeHead(500)
    res.end("Owned performance fixture failed")
  }
})

async function main() {
  evidence.asarBefore = await hashAsar()
  if (process.env.CMB_MODS_EXPECTED_ASAR_SHA256)
    assert.equal(evidence.asarBefore, process.env.CMB_MODS_EXPECTED_ASAR_SHA256)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address === "object")
  const watchdog = setTimeout(() => void app?.close(), 900000)
  try {
    app = await launch(60000)
    evidence.pid = app.process().pid
    for (const stream of [app.process().stdout, app.process().stderr])
      stream?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    await app.evaluate("globalThis.__name = value => value")
    await app.evaluate(({ BrowserWindow }) => {
      const state = globalThis as unknown as {
        __stabilityWire: Array<{ time: number; type: string; mode?: string }>
      }
      state.__stabilityWire = []
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const original = contents.send.bind(contents)
      contents.send = (channel: string, ...args: unknown[]) => {
        const data = args[0]
        if (
          channel.startsWith("agent:stream:") &&
          data &&
          typeof data === "object" &&
          "type" in data &&
          typeof data.type === "string" &&
          state.__stabilityWire.length < 4096
        ) {
          state.__stabilityWire.push({
            time: Date.now(),
            type: data.type,
            ...("mode" in data && typeof data.mode === "string" ? { mode: data.mode } : {})
          })
        }
        return original(channel, ...args)
      }
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(60000)
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.mods))
    await page.evaluate(async (url) => {
      await window.api.models.setCustomConfig({
        id: "stability-model",
        name: "本地稳定性模型",
        baseUrl: url,
        model: "stability-model",
        apiKey: "isolated-loopback-only",
        maxTokens: 128000,
        maxOutputTokens: 8192
      })
      await window.api.models.setDefault("custom:stability-model")
    }, `http://127.0.0.1:${address.port}/v1`)
    for (const mode of process.env.CMB_STABILITY_FOCUS === "weather"
      ? (["weather"] as const)
      : (["ordinary", "weather", "replay", "combined"] as const)) {
      const title = `稳定性验收-${mode}`
      const threadId = await page.evaluate(
        async ({ mode, title, workspace, schemaBytes }) => {
          await window.api.mods.configureGlobal(mode !== "ordinary")
          const thread = await window.api.threads.create({
            title,
            workspacePath: workspace,
            agentMode: "normal"
          })
          const threadId = (thread as unknown as { thread_id: string }).thread_id
          await window.api.workspace.set(threadId, workspace)
          await window.api.mods.configure(threadId, mode !== "ordinary", false)
          if (mode !== "ordinary") {
            const selected: Array<{ pluginId: string; name: string; digest: string }> = []
            for (const exampleId of mode === "weather"
              ? ["token-weather"]
              : mode === "replay"
                ? ["replay-theater"]
                : ["token-weather", "replay-theater"]) {
              const installed = await window.api.mods.communityExamples.install({
                exampleId: exampleId as "token-weather" | "replay-theater"
              })
              const status = await window.api.mods.status(threadId)
              const row = status.functionMods!.find((row) => row.pluginId === installed.pluginId)!
              if (!row.digest) throw Error("Official digest missing")
              await window.api.mods.approveFunction(threadId, row.pluginId, row.digest)
              selected.push({ pluginId: row.pluginId, name: row.name, digest: row.digest })
            }
            if (schemaBytes) {
              const installed = await window.api.plugins.install(
                new Uint8Array(schemaBytes).buffer,
                "schema-refresh.zip",
                "local"
              )
              if (!installed.success) throw Error(installed.error)
              const status = await window.api.mods.status(threadId)
              const row = status.functionMods!.find((row) => row.name === "owned-schema-refresh")!
              if (!row?.digest) throw Error("Owned schema plugin digest missing")
              await window.api.mods.approveFunction(threadId, row.pluginId, row.digest)
              selected.push({ pluginId: row.pluginId, name: row.name, digest: row.digest })
            }
            let view = await window.api.mods.clawView(threadId)
            view = await window.api.mods.clawChange(threadId, {
              kind: "save",
              revision: view.revision,
              workspace: view.workspace,
              profile: {
                id: `perf-${mode}`,
                name: title,
                capabilities: selected,
                builtins: { contextMeter: true }
              }
            })
            await window.api.mods.clawChange(threadId, {
              kind: "apply",
              revision: view.revision,
              bindingRevision: view.bindingRevision,
              workspace: view.workspace,
              id: `perf-${mode}`
            })
          }
          return threadId
        },
        {
          mode,
          title,
          workspace,
          schemaBytes: schemaInvalidation ? [...schemaZip.toBuffer()] : null
        }
      )
      await page.reload()
      await page.getByText(title, { exact: true }).first().click()
      if (inputPresentationProbe) await page.evaluate(() => {
        const samples: Array<Record<string, unknown>> = []
        ;(window as unknown as { __inputPresentation: typeof samples }).__inputPresentation = samples
        ;(window as unknown as { __inputPresentationOverflow: boolean }).__inputPresentationOverflow = false
        document.addEventListener("input", event => {
          const node = event.target
          if (!(node instanceof HTMLTextAreaElement) ||
            !node.classList.contains("composer-textarea") ||
            !/^PERF_(?:PENDING_DRAFT|LIVE_DRAFT|DRAFT)_/.test(node.value)) return
          const sample: Record<string, unknown> = {
            value: node.value, inputAt: Date.now(), trusted: event.isTrusted
          }
          if (samples.length >= 40) {
            ;(window as unknown as { __inputPresentationOverflow: boolean }).__inputPresentationOverflow = true
            return
          }
          samples.push(sample)
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const rect = node.getBoundingClientRect()
            sample.opportunityAt = Date.now()
            sample.valueAtOpportunity = node.value
            sample.visible = node.isConnected && document.visibilityState === "visible" &&
              rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
              rect.left < innerWidth && rect.top < innerHeight && node.checkVisibility({
                checkOpacity: true, checkVisibilityCSS: true
              })
          }))
        }, true)
      })
      const rendererProfiler = inputDiagnostics ? await page.context().newCDPSession(page) : undefined
      if (rendererProfiler) {
        await rendererProfiler.send("Profiler.enable")
        await rendererProfiler.send("Profiler.start")
        await page.evaluate(`(() => {
          const probe={inputs:[],longTasks:[]}; window.__stabilityInput=probe;
          document.addEventListener('input', event => {
            const node=event.target;
            if(!(node instanceof HTMLTextAreaElement)||!node.classList.contains('composer-textarea'))return;
            const sample={time:Date.now(),length:node.value.length,perfDraft:node.value.startsWith('PERF_DRAFT_')};
            if(probe.inputs.length<256)probe.inputs.push(sample);
            requestAnimationFrame(()=>{sample.rafAt=Date.now()});
          },true);
          const observer=new PerformanceObserver(list=>{
            for(const entry of list.getEntries())if(probe.longTasks.length<2000)
              probe.longTasks.push({time:performance.timeOrigin+entry.startTime,duration:entry.duration});
          });observer.observe({type:'longtask',buffered:false});
        })()`)
      }
      // Inspector runs only inside this owned isolated main process. Save function summaries,
      // never raw stack locals, model arguments, heap snapshots, or personal profile content.
      await app.evaluate(`(async () => {
        const inspector = process.getBuiltinModule('node:inspector'), perf = process.getBuiltinModule('node:perf_hooks');
        const session = new inspector.Session(); session.connect();
        const post = (method) => new Promise((resolve,reject) => session.post(method,(e,v)=>e?reject(e):resolve(v)));
        const delay = perf.monitorEventLoopDelay({resolution:10}); delay.enable();
        const gaps=[]; let lastTick=perf.performance.now(), lastWall=Date.now();
        // Diagnostic profile only. The clean paced comparison does not run this timer.
        const gapTimer=${profiling} ? setInterval(() => {
          const now=perf.performance.now(), wall=Date.now(), elapsed=now-lastTick;
          if(elapsed>50 && gaps.length<2000) gaps.push({from:lastWall,to:wall,elapsedMs:elapsed});
          lastTick=now;lastWall=wall;
        },20) : undefined;
        globalThis.__stabilityProfile = {session,post,delay,gaps,gapTimer};
        if (${profiling}) { await post('Profiler.enable'); await post('Profiler.start'); }
      })()`)
      for (let turn = 1; turn <= turns; turn++) {
        responseMarker = `PERF_${mode}_${turn}`
        const marker = responseMarker
        const previous = turn > 1 ? `PERF_${mode}_${turn - 1}_DONE` : ""
        await app.evaluate(() => {
          ;(globalThis as unknown as { __stabilityWire: unknown[] }).__stabilityWire = []
        })
        const start = Date.now()
        const row: Record<string, unknown> = {
          mode,
          turn,
          start,
          priorSettledHistoryMessages: rounds.at(-1)?.mode === mode ? rounds.at(-1)?.settledHistoryMessages ?? 0 : 0
        }
        rounds.push(row)
        if (frameProbe)
          await page.evaluate(installConversationFrameProbe, [
            marker + "_FIRST",
            marker + "_DONE",
            previous
          ])
        await page.evaluate(`(() => {
          const state={samples:[], stopped:false}; window.__stabilityUi=state;
          const begin=performance.now();
          const sample=()=>{if(state.stopped||state.samples.length>=2400||performance.now()-begin>120000)return;
            const text=document.body.innerText;
            state.samples.push({time:Date.now(),previous:!${JSON.stringify(previous)}||text.includes(${JSON.stringify(previous)}),
              loading:(text.match(/内容加载较慢，请稍候/g)||[]).length,
              responseUnits:(text.match(/固定的本地性能样本。/g)||[]).length,
              first:text.includes(${JSON.stringify(marker + "_FIRST")}),done:text.includes(${JSON.stringify(marker + "_DONE")})});
            setTimeout(sample,50)};sample();
        })()`)
        const composer = page.locator("textarea.composer-textarea")
        await composer.fill(`本地固定样本第${turn}轮，只输出受控响应。`)
        await composer.press("Enter")
        const pendingInputAt = Date.now()
        row.pendingInputAt = pendingInputAt
        await composer.fill(`PERF_PENDING_DRAFT_${mode}_${turn}`)
        assert.equal(await composer.inputValue(), `PERF_PENDING_DRAFT_${mode}_${turn}`)
        row.pendingInputRoundtripMs = Date.now() - pendingInputAt
        await page.waitForFunction(
          (value) => document.body.innerText.includes(value),
          marker + "_FIRST"
        )
        row.firstVisibleMs = Date.now() - start
        if (paced) {
          assert.equal(
            row.serverEndAt,
            undefined,
            "First protected frame must precede server completion"
          )
          const duringStream = Date.now()
          row.liveInputAt = duringStream
          await composer.fill(`PERF_LIVE_DRAFT_${mode}_${turn}`)
          assert.equal(await composer.inputValue(), `PERF_LIVE_DRAFT_${mode}_${turn}`)
          row.liveInputRoundtripMs = Date.now() - duringStream
          assert.equal(
            row.serverEndAt,
            undefined,
            "Draft input must respond during active streaming"
          )
        }
        await page.waitForFunction(
          (value) => document.body.innerText.includes(value),
          marker + "_DONE"
        )
        row.doneVisibleMs = Date.now() - start
        const ipcStart = Date.now()
        const history = await page.evaluate(
          (threadId) => window.api.threads.getMessages(threadId),
          threadId
        )
        row.historyIpcMs = Date.now() - ipcStart
        row.historyMessages = history.length
        const inputAt = Date.now()
        row.inputAt = inputAt
        await composer.fill(`PERF_DRAFT_${mode}_${turn}`)
        row.inputFillMs = Date.now() - inputAt
        assert.equal(await composer.inputValue(), `PERF_DRAFT_${mode}_${turn}`)
        row.inputRoundtripMs = Date.now() - inputAt
        row.inputValueMs = Number(row.inputRoundtripMs) - Number(row.inputFillMs)
        await page.waitForTimeout(3000)
        if (inputPresentationProbe) {
          const probe = await page.evaluate(() => {
            const state = window as unknown as {
              __inputPresentation: Array<Record<string, unknown>>
              __inputPresentationOverflow: boolean
            }
            return { samples: state.__inputPresentation, overflow: state.__inputPresentationOverflow }
          })
          assert.equal(probe.overflow, false, "Input sample overflow cannot certify responsiveness")
          const samples = probe.samples
          row.inputPresentation = [
            ["pending", `PERF_PENDING_DRAFT_${mode}_${turn}`, row.pendingInputAt],
            ["live", `PERF_LIVE_DRAFT_${mode}_${turn}`, row.liveInputAt],
            ["settled", `PERF_DRAFT_${mode}_${turn}`, row.inputAt]
          ].filter(([phase]) => phase !== "live" || paced).map(([phase, value, requestedAt]) => {
            const matches = samples.filter(sample => sample.value === value)
            assert.equal(matches.length, 1, "Each draft must have exactly one actual input event")
            const sample = matches[0]
            assert.equal(sample.trusted, true, "Real dispatched input is required")
            assert.equal(sample.visible, true, "Composer must remain visible at the opportunity")
            assert.equal(sample.valueAtOpportunity, value, "Draft must survive both animation frames")
            const latency = Number(sample.opportunityAt) - Number(requestedAt)
            assert(Number.isFinite(latency) && latency >= 0, "Missing or inconsistent input timing")
            assert(Number(sample.inputAt) >= Number(requestedAt) &&
              Number(sample.opportunityAt) >= Number(sample.inputAt), "Input clock order changed")
            return { phase, requestedAt, ...sample, inputPresentationOpportunityMs: latency }
          })
        }
        if (inputDiagnostics) row.inputDiagnostics = await page.evaluate(
          `(() => {const probe=window.__stabilityInput;const result={inputs:probe.inputs,longTasks:probe.longTasks};probe.inputs=[];probe.longTasks=[];return result})()`)
        const settledIpcStart = Date.now()
        const settledHistory = await page.evaluate(
          (threadId) => window.api.threads.getMessages(threadId),
          threadId
        )
        row.settledHistoryIpcMs = Date.now() - settledIpcStart
        for (let prior = 1; prior <= turn; prior++) {
          const expected = `PERF_${mode}_${prior}_DONE`
          assert.equal(
            settledHistory.filter((message) => JSON.stringify(message.content).includes(expected))
              .length,
            1
          )
        }
        row.settledHistoryMessages = settledHistory.length
        row.wire = await app.evaluate(
          () => (globalThis as unknown as { __stabilityWire: unknown[] }).__stabilityWire
        )
        row.ui = await page.evaluate(
          `(() => {window.__stabilityUi.stopped=true;return window.__stabilityUi.samples})()`
        )
        if (frameProbe)
          row.frameProbe = await page.evaluate(() =>
            (
              window as unknown as { __stabilityFrameProbe: { stop(): unknown } }
            ).__stabilityFrameProbe.stop()
          )
        if (frameProbe) {
          const trace = row.frameProbe as {
            limitReached: boolean
            samples: Array<{
              reason: string
              documentVisible: boolean
              list: { count: number }
              markers: Array<{ present: boolean }>
            }>
          }
          assert.equal(trace.limitReached, false, "Truncated traces cannot prove continuity")
          const frames = trace.samples.filter(
            (sample) => sample.reason === "raf" && sample.documentVisible
          )
          const first = frames.findIndex((sample) => sample.markers[0]?.present)
          assert(first >= 0, "Current answer must have a visible-document frame")
          assert(
            frames.slice(first).every((sample) => sample.list.count > 0),
            "Entire message list became empty after current answer display"
          )
          assert(
            frames.slice(first).every((sample) => sample.markers[0]?.present),
            "Current answer disappeared from DOM after first display"
          )
        }
        assert(
          Array.isArray(row.wire) && row.wire.length > 0,
          "Real outgoing stream observations required"
        )
        assert(Array.isArray(row.ui) && row.ui.length > 0, "Actual UI samples required")
        if (paced) {
          const samples = row.ui as Array<{ time: number; responseUnits: number; first: boolean }>
          const beforeEnd = samples.filter(
            (sample) => sample.first && sample.time < Number(row.serverEndAt)
          )
          assert(
            new Set(beforeEnd.map((sample) => sample.responseUnits)).size >= 3,
            "Protected response must visibly advance repeatedly before server completion"
          )
        }
        console.log(
          "STABILITY_ROUND",
          JSON.stringify({
            mode,
            turn,
            firstVisibleMs: row.firstVisibleMs,
            doneVisibleMs: row.doneVisibleMs,
            historyIpcMs: row.historyIpcMs
          })
        )
      }
      const profile = await app.evaluate(`(async () => {
        const {session,post,delay,early,gaps,gapTimer}=globalThis.__stabilityProfile;
        const result=${profiling} ? early ?? await post('Profiler.stop') : undefined;
        if(gapTimer) clearInterval(gapTimer);
        delay.disable(); session.disconnect();
        if (!result) return {profiling:false,eventLoopMaxMs:delay.max/1e6,eventLoopP99Ms:delay.percentile(99)/1e6,topSelfMs:[]};
        const {profile}=result;
        const byId=new Map(profile.nodes.map(n=>[n.id,n])), costs=new Map(), stacks=new Map(), inclusive=new Map(), parents=new Map();
        for(const n of profile.nodes)for(const child of n.children||[])parents.set(child,n.id);
        for(let i=0;i<profile.samples.length;i++){
          const node=byId.get(profile.samples[i]), frame=node.callFrame;
          const key=frame.functionName+' @ '+frame.url.split(/[\\/]/).slice(-2).join('/')+':'+frame.lineNumber;
          costs.set(key,(costs.get(key)||0)+(profile.timeDeltas[i]||0));
          const chain=[]; let cursor=node;
          for(let depth=0;cursor&&depth<24;depth++){
            const f=cursor.callFrame; chain.push(f.functionName+' @ '+f.url.split(/[\\/]/).slice(-2).join('/')+':'+f.lineNumber);
            cursor=byId.get(parents.get(cursor.id));
          }
          const stack=chain.join(' <- ');stacks.set(stack,(stacks.get(stack)||0)+(profile.timeDeltas[i]||0));
          const seen=new Set();cursor=node;
          for(let depth=0;cursor&&depth<256;depth++){
            const f=cursor.callFrame,key=f.functionName+' @ '+f.url.split(/[\\/]/).slice(-2).join('/')+':'+f.lineNumber;
            if(!seen.has(key)){inclusive.set(key,(inclusive.get(key)||0)+(profile.timeDeltas[i]||0));seen.add(key)};
            cursor=byId.get(parents.get(cursor.id));
          }
        }
        return {eventLoopMaxMs:delay.max/1e6,eventLoopP99Ms:delay.percentile(99)/1e6,slowEventLoopIntervals:gaps,
          profileDurationMs:(profile.endTime-profile.startTime)/1000,
          inclusiveMs:[...inclusive].sort((a,b)=>b[1]-a[1]).slice(0,80).map(([fn,us])=>({fn,ms:us/1000})),
          topStacksMs:[...stacks].sort((a,b)=>b[1]-a[1]).slice(0,40).map(([stack,us])=>({stack,ms:us/1000})),
          topSelfMs:[...costs].sort((a,b)=>b[1]-a[1]).slice(0,35).map(([fn,us])=>({fn,ms:us/1000}))};
      })()`)
      if (rendererProfiler) {
        const { profile: renderer } = await rendererProfiler.send("Profiler.stop")
        const nodes = new Map(renderer.nodes.map(node => [node.id, node]))
        const costs = new Map<string, number>()
        for (let index = 0; index < (renderer.samples?.length ?? 0); index++) {
          const frame = nodes.get(renderer.samples![index])!.callFrame
          const key = `${frame.functionName} @ ${frame.url.split(/[\\/]/).slice(-2).join("/")}:${frame.lineNumber}`
          costs.set(key, (costs.get(key) ?? 0) + (renderer.timeDeltas?.[index] ?? 0))
        }
        evidence[`renderer-profile-${mode}`] = {
          durationMs: (renderer.endTime - renderer.startTime) / 1000,
          topSelfMs: [...costs].sort((a, b) => b[1] - a[1]).slice(0, 50)
            .map(([fn, us]) => ({ fn, ms: us / 1000 }))
        }
        await rendererProfiler.detach()
      }
      assert(
        profile && typeof profile === "object" && "topSelfMs" in profile,
        "Main CPU profile required"
      )
      evidence[`profile-${mode}`] = profile
      writeLargeEvidence(join(artifacts, "evidence.json"), evidence)
    }
    assert.equal(
      calls,
      (process.env.CMB_STABILITY_FOCUS === "weather" ? 1 : 4) * turns * (complexStream ? 2 : 1)
    )
    // A completed response is not an acceptable pass if the next draft stalls for a second.
    // CPU diagnostics retain timings without pretending to be an uninstrumented latency run.
    if (!profiling) {
      for (const row of rounds) {
        if (inputPresentationProbe) {
          const samples = row.inputPresentation as Array<{
            phase: string; inputPresentationOpportunityMs: number
          }>
          assert.equal(samples.length, paced ? 3 : 2)
          for (const sample of samples) assert(sample.inputPresentationOpportunityMs < 1000,
            `${row.mode} turn ${row.turn} ${sample.phase} input presentation: ${sample.inputPresentationOpportunityMs}ms exceeds the 1s budget`)
        }
        for (const field of ["pendingInputRoundtripMs", "inputRoundtripMs", ...(paced ? ["liveInputRoundtripMs"] : [])]) {
          assert(Number(row[field]) < 1000, `${row.mode} turn ${row.turn} ${field}: ${row[field]}ms exceeds the 1s input budget`)
        }
      }
    }
    evidence.asarAfter = await hashAsar()
    assert.equal(evidence.asarAfter, evidence.asarBefore)
    evidence.passed = true
  } catch (error) {
    evidence.failure = String(error)
    await (await app?.firstWindow())
      ?.screenshot({ path: join(artifacts, "failure.png") })
      .catch(() => {})
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close().catch(() => {})
    await new Promise<void>((resolve) => server.close(() => resolve()))
    writeLargeEvidence(join(artifacts, "evidence.json"), { ...evidence, calls })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
