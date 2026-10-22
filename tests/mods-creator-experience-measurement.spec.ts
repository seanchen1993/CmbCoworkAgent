/* Standalone packaged current-version measurement; controlled model, no historical S0 claim. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { performance } from "node:perf_hooks"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  lstatSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import type { BrowserWindow, MessageBoxOptions, OpenDialogOptions } from "electron"
import type { ClawView } from "../src/shared/mods/claw"
import { isSameWorkspacePath } from "../src/shared/workspace-path"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"
import { MeasurementLedger, bounded } from "./support/creator-experience-measurement-ledger"

type Task = "weather" | "document"
type Arm = "technical-ui" | "creator-dialogue"
type Json = Record<string, unknown>
type NativeApi = Window["api"]
type ModsStatus = Awaited<ReturnType<NativeApi["mods"]["status"]>>
type NativeThread = Awaited<ReturnType<NativeApi["threads"]["create"]>>
type InstallResult = Awaited<ReturnType<NativeApi["plugins"]["install"]>>
type NativeTrace = NonNullable<Awaited<ReturnType<NativeApi["optimizer"]["getTraceDetail"]>>>
type NativeLog = Awaited<ReturnType<NativeApi["mods"]["logs"]>>[number]
interface NativeHarness {
  chooserArmed: boolean
  chooser: Array<{ options: OpenDialogOptions; selected: string; at: number; harness: boolean }>
  network: Array<{ detail: unknown; at: number; harness: boolean; response: number }>
}
type HarnessGlobal = typeof globalThis & {
  __name: (value: unknown) => unknown
  pairedNative: NativeHarness
  pairedForecastUrl?: string
}
type OpenArguments =
  | [options: OpenDialogOptions]
  | [owner: BrowserWindow, options: OpenDialogOptions]
type MessageArguments =
  | [options: MessageBoxOptions]
  | [owner: BrowserWindow, options: MessageBoxOptions]

function record(value: unknown, label: string): Json {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), label)
  return value as Json
}
function records(value: unknown, label: string): Json[] {
  assert(Array.isArray(value), label)
  return value.map((item: unknown) => record(item, label))
}
const root = resolve(__dirname, "..")
const expected = process.env.CREATOR_E2E_EXPECTED_SHA256 ?? ""
assert.match(expected, /^[a-f0-9]{64}$/)
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR, "Strict packaged directory required")
assert.equal(process.env.CREATOR_E2E_BUILT_PREVIEW, undefined)
for (const name of [
  "CMB_MODS_E2E_MAIN_CPU_PROFILE",
  "CMB_PROJECT_E2E_IO_DIAGNOSTIC",
  "COMPOSITION_E2E_LONG_ONLY",
  "CREATOR_E2E_SHORT",
  "CMB_E2E_FS_DIAGNOSTIC"
])
  assert(!process.env[name], `Profiling/alternate execution flag forbidden: ${name}`)
assert(process.env.GIT_BASH_PATH && existsSync(process.env.GIT_BASH_PATH))
assert.equal(projectCompositionCandidate(root).execution, "packaged-asar")
assert.equal(projectCompositionCandidate(root).sha256, expected)
const outputParent = resolve(
  process.env.COMPOSITION_E2E_ARTIFACT_ROOT ?? "C:/tmp/cmb-experience-paired"
)
mkdirSync(outputParent, { recursive: true })
const outputRoot = mkdtempSync(join(outputParent, "suite-"))
process.env.COMPOSITION_E2E_ARTIFACT_ROOT = outputRoot
let active:
  | { ledger: MeasurementLedger; task: Task; combo: string; effectToken: string; workspace: string }
  | undefined
function verifyPreparedImplementation(bytes: Buffer, installedRoot: string) {
  assert(bytes.length > 0 && bytes.length <= 4 * 1024 * 1024, "Bounded prepared ZIP required")
  const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
  const entries = new AdmZip(bytes).getEntries()
  assert(entries.length > 0 && entries.length <= 128, "Bounded exact package inventory required")
  const expected = new Map<string, Buffer>()
  const expectedDirectories = new Set<string>()
  let totalBytes = 0
  for (const entry of entries) {
    const name = entry.isDirectory ? entry.entryName.slice(0, -1) : entry.entryName
    const parts = name.split("/")
    assert(
      name &&
        !name.includes("\\") &&
        !name.includes("\0") &&
        !/^[A-Za-z]:/.test(name) &&
        parts.every((part) => part && part !== "." && part !== ".."),
      "Only safe original relative ZIP paths are allowed"
    )
    assert(((entry.header.attr >>> 16) & 0o170000) !== 0o120000, "ZIP links are forbidden")
    if (entry.isDirectory) continue
    assert(!expected.has(name), "Duplicate prepared file forbidden")
    assert(entry.header.size <= 4 * 1024 * 1024 - totalBytes, "Bounded declared ZIP content")
    const content = entry.getData()
    totalBytes += content.length
    assert(totalBytes <= 4 * 1024 * 1024, "Bounded exact source bytes required")
    expected.set(name, content)
    for (let end = 1; end < parts.length; end++)
      expectedDirectories.add(parts.slice(0, end).join("/"))
  }
  for (const entry of entries.filter((value) => value.isDirectory))
    assert(expectedDirectories.has(entry.entryName.slice(0, -1)), "Unexpected ZIP directory")
  assert(expected.size > 0, "Prepared source files required")
  const rootState = lstatSync(installedRoot)
  assert(
    rootState.isDirectory() && !rootState.isSymbolicLink(),
    "Real installed source directory required"
  )
  const actualRoot = realpathSync(installedRoot)
  const files: Array<{ path: string; bytes: number; sha256: string }> = []
  const directories = new Set<string>()
  const visit = (directory: string, prefix: string, depth: number) => {
    assert(depth <= 16, "Bounded installed source depth")
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(directory, entry.name)
      const state = lstatSync(full)
      assert(!state.isSymbolicLink(), "Installed source links are forbidden")
      const owned = relative(actualRoot, realpathSync(full))
      assert(
        owned !== ".." && !owned.startsWith(`..${sep}`) && !isAbsolute(owned),
        "Owned source only"
      )
      if (state.isDirectory()) {
        assert(expectedDirectories.has(name), "Extra installed directory forbidden")
        directories.add(name)
        visit(full, name, depth + 1)
      } else {
        assert(state.isFile() && expected.has(name), "Extra or nonregular installed file forbidden")
        const original = expected.get(name)!
        assert.equal(state.size, original.length, "Exact prepared file size required")
        const content = readFileSync(full)
        assert(content.equals(original), `Installed source differs from prepared ZIP: ${name}`)
        const after = lstatSync(full)
        assert(!after.isSymbolicLink() && after.isFile())
        assert.equal(after.dev, state.dev)
        assert.equal(after.ino, state.ino)
        assert.equal(after.size, state.size)
        assert.equal(after.mtimeMs, state.mtimeMs)
        files.push({ path: name, bytes: content.length, sha256: hash(content) })
      }
    }
  }
  visit(actualRoot, "", 0)
  files.sort((left, right) => left.path.localeCompare(right.path))
  assert.deepEqual(
    files.map((value) => value.path),
    [...expected.keys()].sort((a, b) => a.localeCompare(b))
  )
  assert.deepEqual([...directories].sort(), [...expectedDirectories].sort())
  return {
    schema: "exact-prepared-implementation/v1",
    installedRoot: actualRoot,
    zipSha256: hash(bytes),
    implementationSha256: hash(JSON.stringify(files)),
    files,
    boundary: "Portable source-byte identity only; never a native grant or compiled source digest"
  }
}

const savePrompt = (task: Task, combo: string) =>
  `请在这段聊天只使用已安装的 paired-${task}，保存搭配为“${combo}”，保留原生权限核对。`
const applyPrompt = (combo: string) =>
  `请在这段聊天应用已保存的“${combo}”，核对当前目录、插件版本和权限，不重新制作源码。`
const effectPrompt = (task: Task) =>
  task === "weather"
    ? "请先读取 counter.txt，再把其中唯一的 before 替换成 after；用当前聊天已应用的天气与工具计数功能显示真实结果。"
    : "请用当前聊天已应用的文档审查功能读取 review.md，调用当前模型审查，并显示真实结果。"
let forecastUrl = ""
const errors: string[] = []
const allHttp: Json[] = []
const effectSource = (task: Task) =>
  task === "weather"
    ? `
export function register(on){
  on("tool.call",{tool:"edit_file"},async($,event,next)=>{
    const result=await next(event)
    $.ui.log("PAIR_OBSERVATION "+JSON.stringify({at:Date.now(),tool:event.tool,toolUseId:event.tool_use_id,nextReturned:true,isError:result.isError===true}))
    if(!result.isError){await $.store.set("calls",Number(await $.store.get("calls")||0)+1);$.ui.invalidate("ui.render")}
    return result
  })
  on("ui.render",{component:"AbovePrompt"},async($,event)=>{
    let weather=await $.store.get("forecast")
    if(!weather){const response=await $.http.fetch(${JSON.stringify("FORECAST_ENDPOINT")});if(!response.ok)throw Error("forecast failed");
      const forecast=JSON.parse(response.text);weather=forecast.temperature+"° "+forecast.forecast;await $.store.set("forecast",weather)}
    const {Text}=$.ui.resolve(event)
    return Text({children:"工具计数："+Number(await $.store.get("calls")||0)+" · 天气："+weather})
  })
}`.replace(JSON.stringify("FORECAST_ENDPOINT"), JSON.stringify(forecastUrl))
    : `
export function register(on){
  on("tool.call",{tool:"read_file"},async($,event,next)=>{
    const original=await next(event)
    $.ui.log("PAIR_OBSERVATION "+JSON.stringify({at:Date.now(),tool:event.tool,toolUseId:event.tool_use_id,nextReturned:true,isError:original.isError===true}))
    if(original.isError)return original
    const input=await $.fs.read("review.md")
    const result=await $.model.complete({model:"default",prompt:"PAIR_DOC_REVIEW\\n"+input})
    if(!result.isAnswered)throw Error("review incomplete")
    await $.store.set("review",result.text);$.ui.invalidate("ui.render");return original
  })
  on("ui.render",{component:"AbovePrompt"},async($,event)=>{
    const {Text}=$.ui.resolve(event)
    return Text({children:"审查："+String(await $.store.get("review")||"等待文档审查")})
  })
}`

function packageBytes(task: Task) {
  const zip = new AdmZip()
  // Fixed source and ZIP timestamp; the same bytes are installed in both profiles.
  for (const [path, text] of Object.entries({
    "plugin.json": JSON.stringify({
      name: `paired-${task}`,
      version: "1.0.0",
      mods: "mods/manifest.json"
    }),
    "mods/manifest.json": JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: `paired-${task}`,
      entry: "main.ts",
      modelProtocol: "result-v1"
    }),
    "mods/main.ts": effectSource(task)
  })) {
    zip.addFile(path, Buffer.from(text))
    zip.getEntry(path)!.header.time = new Date("2026-01-01T00:00:00Z")
  }
  return zip.toBuffer()
}

function reply(
  response: import("node:http").ServerResponse,
  body: Json,
  text: string,
  tool?: { name: string; args: Json; id: string }
) {
  if (!body.stream) {
    assert(!tool)
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        id: `pair-${allHttp.length}`,
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }
        ]
        // Intentionally no fabricated usage or vendor cost.
      })
    )
    return
  }
  response.writeHead(200, { "content-type": "text/event-stream" })
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: tool.id,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.args) }
          }
        ]
      }
    : { role: "assistant", content: text }
  for (const choice of [
    { delta, finish_reason: null },
    { delta: {}, finish_reason: tool ? "tool_calls" : "stop" }
  ]) {
    response.write(
      `data: ${JSON.stringify({
        id: `pair-${allHttp.length}`,
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, ...choice }]
      })}\n\n`
    )
  }
  response.end("data: [DONE]\n\n")
}

const server = createServer(async (request, response) => {
  try {
    assert(active, "No active measurement cell")
    if (request.url === "/forecast") {
      active.ledger.recordNative("actual-http-forecast", { method: "GET", url: forecastUrl })
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ temperature: 23, forecast: "晴" }))
      return
    }
    assert.equal(request.url, "/v1/chat/completions")
    let raw = ""
    for await (const bytes of request) {
      raw += bytes
      assert(raw.length < 3_000_000)
    }
    const body = record(JSON.parse(raw), "Actual model request must be an object")
    const row = active.ledger.acceptHttp(body)
    allHttp.push(row)
    const messages = records(body.messages, "Actual model messages must be objects")
    const last = messages.findLastIndex((value) => value.role === "user")
    const content = messages[last]?.content
    const input =
      typeof content === "string"
        ? content
        : Array.isArray(content) &&
            content.every((part: unknown) => {
              const value = record(part, "Actual content part must be an object")
              return value.type === "text" && typeof value.text === "string"
            })
          ? content.map((part: unknown) => record(part, "Actual text content part").text).join("")
          : undefined
    assert(
      typeof input === "string",
      "Only original string/all-text user message shapes are supported"
    )
    const results = messages.slice(last + 1).filter((value) => value.role === "tool")
    const parsed = results
      .filter((value) => value.name === "mod_composition")
      .map((value) =>
        record(JSON.parse(String(value.content)), "Actual composition reply must be an object")
      )
    let tool: { name: string; args: Json; id: string } | undefined
    let text = ""
    const next = (name: string, args: Json) => {
      assert(
        records(body.tools, "Actual tool inventory must be an array").some(
          (item) =>
            record(item.function, "Actual tool schema must contain a function").name === name
        ),
        `${name} not published`
      )
      tool = { name, args, id: `pair-call-${allHttp.length}` }
      active!.ledger.toolRequests.push({ phase: row.phase, ...tool })
    }
    if (input.startsWith("PAIR_DOC_REVIEW\n")) {
      assert.equal(input, "PAIR_DOC_REVIEW\n# Release plan\nOwner: missing\nDeadline: Friday\n")
      text = "缺少负责人"
    } else if (input === savePrompt(active.task, active.combo)) {
      const latest = parsed.at(-1)
      if (!latest) next("mod_composition", { action: "list", refresh: true })
      else {
        assert.equal(latest.ok, true, JSON.stringify(latest))
        const result = record(latest.result, "Actual composition result must be an object")
        if (result.catalogToken && result.available) {
          const source = records(
            result.available,
            "Actual catalog availability must be an array"
          ).find((item) => item.name === `paired-${active!.task}`)
          assert(source?.pluginId && source.digest)
          next("mod_composition", {
            action: "stage",
            catalogToken: result.catalogToken,
            name: active.combo,
            replace: true,
            capabilities: [{ pluginId: source.pluginId, name: source.name, digest: source.digest }]
          })
        } else if (parsed.length === 2)
          next("mod_composition", {
            action: "save",
            savedName: active.combo,
            savedRevision: 0,
            catalogToken: record(parsed[0].result, "Original first catalog result").catalogToken
          })
        else {
          // Original CreatorCompositionHistory.save returns {name,revision}, not saved:true.
          assert.equal(result.name, active.combo)
          assert.equal(result.revision, 1)
          text = "PAIR_SAVED"
        }
      }
    } else if (input === applyPrompt(active.combo)) {
      if (!results.length) next("mod_composition", { action: "list", refresh: true })
      else if (parsed.length === 1) {
        assert.equal(parsed[0].ok, true)
        const saved = records(
          record(parsed[0].result, "Actual saved catalog").saved,
          "Actual saved combinations must be an array"
        ).find((value) => value.name === active!.combo)
        assert(saved?.revision)
        next("mod_composition", {
          action: "apply_saved",
          savedName: saved.name,
          savedRevision: saved.revision
        })
      } else {
        const latest = parsed.at(-1)
        assert(latest)
        assert.equal(latest.ok, true)
        text = "PAIR_APPLIED"
      }
    } else if (input === active.effectToken) {
      if (!results.length)
        next("read_file", {
          file_path: join(active.workspace, active.task === "weather" ? "counter.txt" : "review.md")
        })
      else if (results.length === 1 && active.task === "weather")
        next("edit_file", {
          file_path: join(active.workspace, "counter.txt"),
          old_string: "before",
          new_string: "after"
        })
      else {
        assert(!results.some((value) => value.status === "error"))
        text = "PAIR_EFFECT_COMPLETE"
      }
    } else throw Error(`Unexpected exact user message: ${JSON.stringify(input)}`)
    reply(response, body, text, tool)
  } catch (error) {
    errors.push(String(error))
    response.writeHead(500).end("controlled model protocol rejected")
  }
})

async function api<T = unknown>(page: Page, expression: string): Promise<T> {
  return page.evaluate(`(async () => (${expression}))()`)
}
async function send(page: Page, text: string) {
  await page.locator("textarea.composer-textarea").fill(text)
  await page.getByRole("button", { name: "发送消息", exact: true }).click()
}
async function openClaw(page: Page) {
  await page.getByRole("button", { name: "自定义设置", exact: true }).click()
  const advanced = page.getByRole("button", { name: "高级特性", exact: true })
  await advanced.waitFor({ state: "visible" })
  const expanded = await advanced.getAttribute("aria-expanded")
  assert(expanded === "true" || expanded === "false", "Original menu must expose expansion state")
  if (expanded === "false") await advanced.click()
  await page
    .getByRole("button", { name: "高级特性", exact: true, expanded: true })
    .waitFor({ state: "visible" })
  await page.getByRole("button", { name: "搭配管理", exact: true }).click()
  await page.getByLabel("助手组合设置", { exact: true }).waitFor()
}
async function showChat(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click()
  await page.locator("textarea.composer-textarea").waitFor()
}

function summarizeTracePhases(ledger: MeasurementLedger, cellId: string, traces: NativeTrace[]) {
  const phases = ledger.phases.filter((value) => value.cellId === cellId)
  const group = (startedAt: string) => {
    const at = Date.parse(startedAt)
    return (
      phases.find((value) => at >= value.wallStartedAt && at < (value.wallEndedAt ?? Infinity))
        ?.phase ?? "unattributed"
    )
  }
  const logical = traces.flatMap((trace) =>
    (trace.modelCalls ?? []).map((call) => ({
      traceId: trace.traceId,
      messageId: call.messageId,
      phase: group(call.startedAt),
      startedAt: call.startedAt,
      tokenUsage: call.tokenUsage,
      truncated: "truncated" in call && call.truncated === true,
      usageCoverage: "unknown: controlled provider deliberately omits usage"
    }))
  )
  const requested = traces.flatMap((trace) =>
    (trace.nodes ?? [])
      .filter((node) => node.type === "tool")
      .map((node) => ({
        traceId: trace.traceId,
        id: node.id,
        name: node.name,
        phase: group(node.startedAt),
        input: node.input,
        metadata: node.metadata
      }))
  )
  const results = traces.flatMap((trace) =>
    (trace.nodes ?? [])
      .filter((node) => node.type === "tool_result")
      .map((node) => ({
        traceId: trace.traceId,
        id: node.id,
        parentId: node.parentId,
        phase: group(node.startedAt),
        status: node.status,
        output: node.output
      }))
  )
  const clarifications = requested.filter((node) => node.name === "request_user_input")
  // This candidate never authors a clarification response or silently accepts a new question.
  // If actual runtime asks one, fail and retain its native question item rather than counting '?'.
  assert.equal(
    clarifications.length,
    0,
    "Unexpected structured question requires explicit candidate UI handling"
  )
  return {
    logicalModelCalls: logical,
    requestedTools: requested,
    toolResults: results,
    successfulToolResults: results.filter((value) => value.status === "success"),
    structuredClarificationRequests: clarifications,
    publicToolObservation: {
      status: "not-collected",
      reason: "Trace requested/result nodes are not public Mod event-entry counts"
    },
    usage: {
      coverage: "unknown",
      reason:
        "No controlled-provider usage emitted; original trace fields retained without inventing tokens"
    },
    cost: { status: "unknown" }
  }
}

async function profile(task: Task, arm: Arm, bytes: Buffer, modelUrl: string) {
  const fixture = projectCompositionEnvironment(root)
  fixture.env.GIT_BASH_PATH = process.env.GIT_BASH_PATH!
  const ledger = new MeasurementLedger(`${task}:${arm}`)
  const combo = `相同实现-${task}`
  active = { ledger, task, combo, effectToken: effectPrompt(task), workspace: fixture.workspace }
  writeFileSync(join(fixture.workspace, "counter.txt"), "before")
  writeFileSync(
    join(fixture.workspace, "review.md"),
    "# Release plan\nOwner: missing\nDeadline: Friday\n"
  )
  const byteDigest = createHash("sha256").update(bytes).digest("hex")
  let app: ElectronApplication | undefined
  let appProcess: ReturnType<ElectronApplication["process"]> | undefined
  let page: Page | undefined
  let failure: unknown
  let processExitObservation: Json | undefined
  const cells: Json[] = []
  const watchdog = setTimeout(() => void app?.close(), 300_000)
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    appProcess = app.process()
    appProcess.once("exit", (code, signal) => {
      processExitObservation = {
        code,
        signal,
        observedAt: Date.now(),
        source: "original App process exit event"
      }
    })
    appProcess.stdout?.on("data", (value) =>
      appendFileSync(join(fixture.isolated, "main.stdout.log"), value)
    )
    appProcess.stderr?.on("data", (value) =>
      appendFileSync(join(fixture.isolated, "main.stderr.log"), value)
    )
    page = await app.firstWindow({ timeout: 60_000 })
    page.setDefaultTimeout(30_000)
    await page.waitForFunction(() => Boolean(window.api?.mods))
    await ledger.observe(page)
    await api<InstallResult>(
      page,
      `(async () => {
      await window.api.autoCommit.saveSettings({mode:"off",push:false})
      await window.api.models.setCustomConfig({id:"paired-model",name:"统一隔离模型",baseUrl:${JSON.stringify(modelUrl)},
        model:"paired-model",apiKey:"local-fixture",maxTokens:32000,maxOutputTokens:4096})
      await window.api.models.setDefault("custom:paired-model")
      await window.api.mods.configureGlobal(true)
      return window.api.plugins.install(new Uint8Array(${JSON.stringify([...bytes])}).buffer,"paired.zip","local")
    })()`
    ).then((result) => assert.equal(result.success, true, JSON.stringify(result)))
    // Only original native chooser is intercepted, with exact options and one armed owner request.
    await app.evaluate(({ dialog }, ownedPath) => {
      ;(globalThis as HarnessGlobal)["__name"] = Function("value", "return value") as (
        value: unknown
      ) => unknown
      const state = globalThis as HarnessGlobal
      state.pairedNative = { chooserArmed: false, chooser: [], network: [] }
      const originalOpen = dialog.showOpenDialog.bind(dialog)
      dialog.showOpenDialog = (async (...args: OpenArguments) => {
        const options = args.length === 1 ? args[0] : args[1]
        if (options.title !== "选择工作区文件夹")
          return args.length === 1 ? originalOpen(args[0]) : originalOpen(args[0], args[1])
        if (
          !state.pairedNative.chooserArmed ||
          JSON.stringify(options.properties) !== '["openDirectory","createDirectory"]'
        )
          throw Error("Unarmed or foreign native chooser")
        state.pairedNative.chooserArmed = false
        state.pairedNative.chooser.push({
          options,
          selected: ownedPath,
          at: Date.now(),
          harness: true
        })
        return { canceled: false, filePaths: [ownedPath] }
      }) as typeof dialog.showOpenDialog
      const originalMessage = dialog.showMessageBox.bind(dialog)
      dialog.showMessageBox = (async (...args: MessageArguments) => {
        const options = args.length === 1 ? args[0] : args[1]
        if (options.title !== "批准插件网络请求")
          return args.length === 1 ? originalMessage(args[0]) : originalMessage(args[0], args[1])
        const detail: unknown = JSON.parse(options.detail ?? "{}")
        if (
          detail === null ||
          typeof detail !== "object" ||
          Array.isArray(detail) ||
          !("method" in detail) ||
          !("url" in detail)
        )
          throw Error("Malformed native network request")
        if (
          args.length !== 2 ||
          typeof args[0].isDestroyed !== "function" ||
          args[0].isDestroyed() ||
          detail.method !== "GET" ||
          detail.url !== state.pairedForecastUrl
        )
          throw Error("Foreign native network request")
        state.pairedNative.network.push({ detail, at: Date.now(), harness: true, response: 1 })
        return { response: 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    }, fixture.workspace)
    await app.evaluate((_, url) => {
      ;(globalThis as HarnessGlobal).pairedForecastUrl = url
    }, forecastUrl)

    for (const binding of ["fresh-task-directory", "existing-task-directory"] as const) {
      const cellId = `${task}:${arm}:${binding}`
      const title = cellId
      ledger.selectCell(cellId)
      const startedAt = Date.now()
      const cell: Json = {
        id: cellId,
        task,
        arm,
        binding,
        byteDigest,
        status: "running",
        startedAt
      }
      cell.sameTaskInstructions =
        binding === "fresh-task-directory" ? savePrompt(task, combo) : applyPrompt(combo)
      cell.sameEffectInstructions = effectPrompt(task)
      cells.push(cell)
      const thread = await api<NativeThread>(
        page,
        `window.api.threads.create({title:${JSON.stringify(title)},workspacePath:null,agentMode:"normal"})`
      )
      const threadId = thread.thread_id
      assert(threadId)
      await ledger.drain(page)
      await page.reload()
      await ledger.observe(page)
      await showChat(page, title)
      await ledger.mark(page, "directory-binding")
      const before = await api<NativeThread | null>(
        page,
        `window.api.threads.get(${JSON.stringify(threadId)})`
      )
      assert(before, "Original target thread must still exist")
      cell.beforeBinding = before
      const beforeMetadata = record(
        typeof before.metadata === "string" ? JSON.parse(before.metadata) : (before.metadata ?? {}),
        "Original thread metadata must be an object"
      )
      assert(
        !beforeMetadata?.workspacePath,
        "Thread must really be workspace-less before native chooser"
      )
      await app.evaluate(() => {
        ;(globalThis as HarnessGlobal).pairedNative.chooserArmed = true
      })
      await page.getByRole("button", { name: "选择工作区", exact: true }).click()
      await page.getByRole("button", { name: "选择文件夹", exact: true }).click()
      const workspaceBindingDeadline = performance.now() + 30_000
      const workspaceBindingTimeRemaining = () => {
        const remaining = workspaceBindingDeadline - performance.now()
        assert(remaining > 0, "Original workspace-binding read budget exhausted")
        return remaining
      }
      assert(
        typeof beforeMetadata.cmb_thread_incarnation === "string" &&
          beforeMetadata.cmb_thread_incarnation.length > 0,
        "Original native thread incarnation required"
      )
      const persistedThread = await bounded<NativeThread | null>(
        () =>
          api<NativeThread | null>(page!, `window.api.threads.get(${JSON.stringify(threadId)})`),
        (value) => {
          assert(value && value.thread_id === threadId, "Original chooser target thread required")
          const metadata = record(
            typeof value.metadata === "string"
              ? JSON.parse(value.metadata)
              : (value.metadata ?? {}),
            "Original persisted target metadata"
          )
          assert.equal(metadata.cmb_thread_incarnation, beforeMetadata.cmb_thread_incarnation)
          if (metadata.workspacePath == null || metadata.workspacePath === "") return false
          assert(typeof metadata.workspacePath === "string", "Persisted workspace must be a path")
          assert(
            isSameWorkspacePath(metadata.workspacePath, fixture.workspace),
            "Native chooser must persist this exact isolated workspace"
          )
          return true
        },
        "native chooser persists the original exact thread workspace",
        workspaceBindingTimeRemaining()
      )
      cell.persistedWorkspaceThread = persistedThread
      const scope = await bounded<ModsStatus>(
        () => api<ModsStatus>(page!, `window.api.mods.status(${JSON.stringify(threadId)})`),
        (value) => !!value.workspace,
        "native chooser creates original workspace binding",
        workspaceBindingTimeRemaining()
      )
      assert(
        performance.now() <= workspaceBindingDeadline,
        "Original workspace-binding read deadline exceeded"
      )
      assert(
        isSameWorkspacePath(scope.workspace, fixture.workspace),
        "Native Mods workspace must match the chooser target"
      )
      cell.workspace = scope.workspace
      cell.directoryChooser = "original workspace:select, bounded exact native dialog harness"
      await ledger.mark(page, "source-authority")
      await api(
        page,
        `window.api.mods.configure(${JSON.stringify(threadId)},true,true,${JSON.stringify(scope.workspace)})`
      )
      const admitted = await api<ModsStatus>(
        page,
        `window.api.mods.status(${JSON.stringify(threadId)})`
      )
      const source = admitted.functionMods?.find((value) => value.name === `paired-${task}`)
      assert(source?.digest)
      cell.sourceBefore = source
      // Common prerequisite only. Native original admission, NOT counted as a trusted human action.
      // Both arms use the same service and exact package digest; never claim this harness is UI cost.
      if (binding === "fresh-task-directory") {
        assert.equal(
          source.state,
          "needs-approval",
          "Fresh exact workspace/digest must not inherit a prior grant"
        )
        await api(
          page,
          `window.api.mods.approveFunction(${JSON.stringify(threadId)},${JSON.stringify(source.pluginId)},
          ${JSON.stringify(source.digest)},${JSON.stringify(scope.workspace)})`
        )
        ledger.recordNative("original-exact-source-approval-harness", {
          threadId,
          pluginId: source.pluginId,
          digest: source.digest,
          humanClick: false
        })
      } else
        assert.equal(
          source.state,
          "ready",
          "Bound cell must actually retain the same valid workspace/digest grant"
        )
      cell.sourceAfter = await api(page, `window.api.mods.status(${JSON.stringify(threadId)})`)
      await ledger.drain(page)
      await page.reload()
      await ledger.observe(page)
      await showChat(page, title)
      await ledger.mark(
        page,
        binding === "fresh-task-directory" ? "configure-save" : "apply-other-chat"
      )
      if (arm === "technical-ui") {
        await openClaw(page)
        if (binding === "fresh-task-directory") {
          const simple = page.getByRole("region", { name: "简单组合", exact: true })
          await simple.getByLabel("组合名称", { exact: true }).fill(combo)
          const selection = simple.getByLabel(`paired-${task}`, { exact: true })
          if (!(await selection.isChecked())) await selection.check()
          await simple.getByRole("button", { name: "保存并核对应用", exact: true }).click()
          await simple
            .getByRole("region", { name: "简单组合应用预览", exact: true })
            .getByRole("button", { name: "确认应用", exact: true })
            .click()
          await simple
            .getByRole("region", { name: "组合首次使用", exact: true })
            .getByRole("button", { name: "去这段聊天使用", exact: true })
            .click()
        } else {
          const details = page
            .locator("details")
            .filter({ has: page.getByText("高级编辑与已保存组合", { exact: true }) })
          if ((await details.getAttribute("open")) === null)
            await details.locator(":scope > summary").click()
          assert.notEqual(
            await details.getAttribute("open"),
            null,
            "Original advanced saved-combinations details must actually be open"
          )
          const row = page
            .locator("aside div")
            .filter({ has: page.getByRole("button", { name: combo, exact: true }) })
            .filter({ has: page.getByRole("button", { name: "应用到所选聊天", exact: true }) })
            .last()
          await row.getByRole("button", { name: "应用到所选聊天", exact: true }).click()
          await page
            .getByRole("region", { name: "应用变化预览", exact: true })
            .getByRole("button", { name: "确认应用", exact: true })
            .click()
          const current = page
            .getByLabel("助手组合设置", { exact: true })
            .locator("section")
            .filter({ has: page.getByText(`当前组合：${combo}`, { exact: true }) })
          await current.getByRole("button", { name: "去这段聊天使用", exact: true }).click()
        }
      } else {
        await page.getByRole("button", { name: "创造者模式", exact: true }).click()
        await send(
          page,
          binding === "fresh-task-directory" ? savePrompt(task, combo) : applyPrompt(combo)
        )
        await page
          .getByText(binding === "fresh-task-directory" ? "PAIR_SAVED" : "PAIR_APPLIED", {
            exact: true
          })
          .waitFor({ timeout: 60_000 })
      }
      const applied = await bounded<ClawView>(
        () => api<ClawView>(page!, `window.api.mods.clawView(${JSON.stringify(threadId)})`),
        (value) => value.active?.name === combo,
        "same native named combination active"
      )
      assert(applied.active, "Original named combination must actually be active")
      const capability = applied.active.capabilities.find(
        (value) => value.name === `paired-${task}`
      )
      assert.equal(capability?.digest, source.digest)
      cell.applied = applied
      if (task === "weather") writeFileSync(join(fixture.workspace, "counter.txt"), "before")
      await ledger.mark(page, "real-effect")
      const effectSendStartedMonotonic = performance.now()
      cell.effectSendStartedMonotonic = effectSendStartedMonotonic
      cell.effectSendStartedAt = Date.now()
      const effectDeadline = effectSendStartedMonotonic + (task === "weather" ? 60_000 : 45_000)
      const effectTimeRemaining = () => {
        const remaining = effectDeadline - performance.now()
        assert(remaining > 0, "Original absolute real-effect deadline exceeded")
        return remaining
      }
      // One original effect budget includes send, native approval and the actual visible result.
      await page.locator("textarea.composer-textarea").fill(active!.effectToken, {
        timeout: effectTimeRemaining()
      })
      await page.getByRole("button", { name: "发送消息", exact: true }).click({
        timeout: effectTimeRemaining()
      })
      if (task === "weather") {
        const approvalStarted = performance.now()
        const targetPath = join(fixture.workspace, "counter.txt")
        const chat = page.locator(`[data-chat-thread-id=${JSON.stringify(threadId)}]`)
        const approvalCard = chat
          .locator("div.border-2")
          .filter({ has: page.getByText("编辑文件需要审批", { exact: true }) })
          .filter({ has: page.getByText(`编辑: ${targetPath}`, { exact: true }) })
        await approvalCard.waitFor({ state: "visible", timeout: effectTimeRemaining() })
        assert.equal(await approvalCard.count(), 1, "One exact current-thread edit approval card")
        let approvalReadTimer: ReturnType<typeof setTimeout> | undefined
        let pendingValue: unknown
        try {
          const readTimeout = effectTimeRemaining()
          pendingValue = await Promise.race([
            api<unknown[]>(
              page,
              `window.api.sandbox.getPendingApprovals(${JSON.stringify(threadId)})`
            ),
            new Promise<never>((_, reject) => {
              approvalReadTimer = setTimeout(
                () => reject(Error("Original real-effect deadline expired during approval read")),
                readTimeout
              )
            })
          ])
        } finally {
          if (approvalReadTimer !== undefined) clearTimeout(approvalReadTimer)
        }
        const pending = records(pendingValue, "Original current-thread pending approvals")
        assert.equal(pending.length, 1, "No unrelated pending operation may be approved")
        const request = pending[0]
        assert(typeof request.id === "string" && request.id.length > 0)
        assert.equal(request.operation, "edit_file")
        assert.equal(request.filePath, targetPath)
        assert.equal(request.cwd, fixture.workspace)
        const call = record(request.tool_call, "Original pending tool call")
        assert.equal(call.name, "edit_file")
        assert.equal(record(call.args, "Original file approval arguments").filePath, targetPath)
        // Trusted original UI click only: no session/permanent approval or decision IPC.
        await approvalCard.getByRole("button", { name: "允许", exact: true }).click({
          timeout: effectTimeRemaining()
        })
        const approvalEvidence = {
          threadId,
          requestId: request.id,
          targetPath,
          operation: "edit_file",
          decision: "approve",
          source: "original current-thread approval UI, trusted automated single click",
          humanThinkingMeasured: false,
          elapsedMs: performance.now() - approvalStarted
        }
        cell.fileEditApproval = approvalEvidence
        ledger.recordNative("original-file-edit-approval-ui", approvalEvidence)
        await page.getByText("PAIR_EFFECT_COMPLETE", { exact: true }).waitFor({
          timeout: effectTimeRemaining()
        })
        assert.equal(readFileSync(join(fixture.workspace, "counter.txt"), "utf8"), "after")
        await page
          .locator('[data-function-site="AbovePrompt"] > div:not([data-function-site-cached])')
          .getByText(/^工具计数：[1-9][0-9]* · 天气：23° 晴$/)
          .waitFor({ timeout: effectTimeRemaining() })
      } else {
        await page.getByText("PAIR_EFFECT_COMPLETE", { exact: true }).waitFor({
          timeout: effectTimeRemaining()
        })
        await page
          .locator('[data-function-site="AbovePrompt"] > div:not([data-function-site-cached])')
          .getByText("审查：缺少负责人", { exact: true })
          .waitFor({ timeout: effectTimeRemaining() })
      }
      // Capture immediately after the real noncached visible-result condition, before trace readback.
      const visibleObservedMonotonic = performance.now()
      assert(
        visibleObservedMonotonic <= effectDeadline,
        "Original absolute real-effect deadline exceeded"
      )
      const visibleObservedAt = Date.now()
      cell.visibleObservedMonotonic = visibleObservedMonotonic
      cell.visibleObservedAt = visibleObservedAt
      cell.firstVisibleMs = visibleObservedMonotonic - effectSendStartedMonotonic
      cell.firstVisibleSinceCellStartMs = visibleObservedAt - startedAt
      cell.visibilityDefinition =
        "Observed live AbovePrompt visible after real result; includes automation observation latency, not an exact first raster-paint timestamp"
      const verificationStartedMonotonic = performance.now()
      cell.verificationStartedMonotonic = verificationStartedMonotonic
      await ledger.mark(page, "verification")
      assert.equal(errors.length, 0, errors.join("\n"))
      const publicLogs = await api<NativeLog[]>(
        page,
        `window.api.mods.logs(${JSON.stringify(threadId)})`
      )
      cell.publicLogs = publicLogs
      const observed: Json[] = publicLogs
        .filter((row) => row.text.startsWith("PAIR_OBSERVATION "))
        .map((row) => ({
          nativeLogId: row.id,
          nativePlugin: row.plugin,
          ...record(
            JSON.parse(row.text.slice("PAIR_OBSERVATION ".length)),
            "Original public tool observation must be an object"
          )
        }))
      assert.equal(observed.length, 1, "One prepared task Mod observes the actual effect tool")
      for (const event of observed) {
        assert.equal(event.nextReturned, true)
        assert.equal(event.isError, false)
        assert(
          typeof event.toolUseId === "string" && event.toolUseId.length > 0,
          "Actual observed tool call ID required"
        )
      }
      const effectStartedAt = cell.effectSendStartedAt
      assert(typeof effectStartedAt === "number", "Original effect send timestamp required")
      const verificationDeadline = verificationStartedMonotonic + 30_000
      const verificationRemaining = verificationDeadline - performance.now()
      assert(verificationRemaining > 0, "Original trace verification budget exhausted")
      const traces = await bounded(
        () =>
          api<Array<NativeTrace | null>>(
            page!,
            `(async () => {
        const summaries = await window.api.optimizer.getTraces({threadId:${JSON.stringify(threadId)}})
        return Promise.all(summaries.map(row => window.api.optimizer.getTraceDetail(row.traceId)))
      })()`
          ),
        (values) =>
          performance.now() <= verificationDeadline &&
          values.length > 0 &&
          values.every((value) => value && value.endedAt && value.outcome !== "running") &&
          values.some((trace) => {
            if (
              !trace ||
              trace.threadId !== threadId ||
              !trace.endedAt ||
              trace.outcome === "running" ||
              !trace.userMessage.includes(active!.effectToken)
            )
              return false
            const startedAt = Date.parse(trace.startedAt)
            if (!Number.isFinite(startedAt) || startedAt < effectStartedAt) return false
            const nodes = trace.nodes ?? []
            return observed.every((event) => {
              const call = nodes.find(
                (node) => node.type === "tool" && node.metadata?.toolCallId === event.toolUseId
              )
              return (
                call !== undefined &&
                nodes.some(
                  (node) =>
                    node.type === "tool_result" &&
                    node.parentId === call.id &&
                    node.status === "success"
                )
              )
            })
          }),
        "original protected trace completion with this effect's actual tool evidence",
        verificationRemaining
      )
      assert(
        performance.now() <= verificationDeadline,
        "Original trace verification budget exceeded"
      )
      assert(
        traces.every((trace): trace is NativeTrace => trace !== null),
        "Original trace details must exist"
      )
      cell.traces = traces
      const metrics: Json = summarizeTracePhases(ledger, cellId, traces)
      cell.metrics = metrics
      for (const event of observed) {
        assert.equal(event.nextReturned, true)
        assert.equal(event.isError, false)
        assert(
          typeof event.toolUseId === "string" && event.toolUseId.length > 0,
          "Actual observed tool call ID required"
        )
        const call = traces
          .flatMap((trace) => trace.nodes ?? [])
          .find((node) => node.type === "tool" && node.metadata?.toolCallId === event.toolUseId)
        assert(call, "Public Mod observation must match the actual original trace call ID")
        assert(
          traces
            .flatMap((trace) => trace.nodes ?? [])
            .some(
              (node) =>
                node.type === "tool_result" &&
                node.parentId === call.id &&
                node.status === "success"
            )
        )
      }
      metrics.publicToolObservation = {
        source: "Original mods.logs IPC, actual approved tool.call/next",
        observed,
        nativeNextReturnedSuccess: 1,
        definition:
          "Entry observation and native next result are separate from complete application success"
      }
      metrics.http = ledger.requests.filter((value) => value.cellId === cellId)
      metrics.phaseDurations = ledger.phases.filter((value) => value.cellId === cellId)
      metrics.nativeCommonPrerequisites = ledger.native.filter((value) => value.cellId === cellId)
      metrics.clarifications = {
        requestedQuestions: 0,
        source: "No request_user_input in actual controlled tool outputs or protected trace",
        forcedQuestions: false,
        punctuationHeuristic: false
      }
      metrics.repairCost = {
        rerunsInThisCell: 0,
        sourcePatchesInThisCell: 0,
        definition:
          "Any future repair rerun must retain this entire failed run and record its own phases/HTTP; no best-of selection"
      }
      cell.accounting = await api(
        page,
        `window.api.mods.development.status({threadId:${JSON.stringify(threadId)}})`
      )
      cell.phaseAccounting =
        "Raw per-phase HTTP captured at accept; protected trace logical/tool nodes retained, no SSE-invented totals"
      const verificationEndedMonotonic = performance.now()
      cell.verificationEndedMonotonic = verificationEndedMonotonic
      cell.verificationMs = verificationEndedMonotonic - verificationStartedMonotonic
      ledger.end()
      cell.status = "passed"
      const endedAt = Date.now()
      cell.endedAt = endedAt
      cell.elapsedMs = endedAt - startedAt
      cell.totalElapsedMs = cell.elapsedMs
      metrics.timing = {
        firstVisibleMs: cell.firstVisibleMs,
        firstVisibleSinceCellStartMs: cell.firstVisibleSinceCellStartMs,
        verificationMs: cell.verificationMs,
        totalElapsedMs: cell.totalElapsedMs,
        definition:
          "Effect visible observation is distinct from mandatory trace/log/accounting verification; total includes both"
      }
      await page.screenshot({ path: join(fixture.isolated, `${binding}.png`) })
      writeFileSync(join(fixture.isolated, `${binding}.json`), JSON.stringify(cell, null, 2))
    }
  } catch (error) {
    failure = error
    const last = cells.at(-1)
    if (last?.status === "running") {
      last.status = "failed"
      last.error = String(error)
    }
    if (page) await page.screenshot({ path: join(fixture.isolated, "failure.png") }).catch(() => {})
  } finally {
    clearTimeout(watchdog)
    if (page) {
      try {
        await ledger.finish(page, join(fixture.isolated, "measurement-ledger.json"), {
          cells,
          error: failure ? String(failure) : undefined
        })
      } catch (error) {
        // A watchdog/window loss must not bypass original App close or become a successful cell.
        failure ??= error
        writeFileSync(
          join(fixture.isolated, "measurement-capture-failure.json"),
          JSON.stringify(
            {
              error: String(error),
              cells,
              requests: ledger.requests,
              phases: ledger.phases,
              clicks: "unavailable after renderer loss; do not substitute synthetic events"
            },
            null,
            2
          )
        )
      }
    }
    const native = app
      ? await app.evaluate(() => (globalThis as HarnessGlobal).pairedNative).catch(() => undefined)
      : undefined
    writeFileSync(
      join(fixture.isolated, "native-harness.json"),
      JSON.stringify(native ?? { unavailable: true }, null, 2)
    )
    if (app) {
      try {
        await app.close()
      } catch (error) {
        failure ??= error
      }
    }
    const exitCode = appProcess?.exitCode
    const signalCode = appProcess?.signalCode
    const settled = typeof exitCode === "number" || typeof signalCode === "string"
    const normalExit = exitCode === 0 && signalCode === null
    const cleanup = {
      status: normalExit ? "succeeded" : settled ? "failed" : "unknown",
      normalCloseRequested: Boolean(app),
      actualProcessExitSettled: settled,
      exitCode,
      signalCode,
      processExitObservation,
      definition:
        "Only known exitCode 0 with no signal permits profile PASS; close request alone is not settlement"
    }
    if (!normalExit)
      failure ??= Error(settled ? "EXPERIENCE_APP_EXIT_FAILED" : "EXPERIENCE_APP_EXIT_UNCONFIRMED")
    const post = projectCompositionCandidate(root)
    assert.equal(post.sha256, expected)
    writeFileSync(
      join(fixture.isolated, "profile-result.json"),
      JSON.stringify(
        {
          task,
          arm,
          cells,
          expectedAsar: expected,
          postAsar: post.sha256,
          packageDigest: byteDigest,
          status: failure ? "failed" : "passed",
          cleanup,
          naturalCloseRequested: Boolean(app),
          failed: Boolean(failure),
          error: failure ? String(failure) : undefined,
          appProcessExitCode: exitCode,
          descendantProcessProof: {
            status: "not-collected",
            reason: "Do not infer all native descendants gone solely from app.close"
          },
          firstBindingScope:
            "First task-directory/source binding in this isolated profile, not first machine/model setup",
          commonNativeHarnessExcludedFromHumanClickComparison: true,
          price: { status: "unknown" },
          executed: true
        },
        null,
        2
      )
    )
  }
  if (failure) throw failure
  return { task, arm, root: fixture.isolated, cells }
}

async function main() {
  const results: Awaited<ReturnType<typeof profile>>[] = []
  const implementationProofs: Json[] = []
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  forecastUrl = `http://127.0.0.1:${address.port}/forecast`
  const weather = packageBytes("weather")
  const document = packageBytes("document")
  writeFileSync(join(outputRoot, "prepared-weather.zip"), weather)
  writeFileSync(join(outputRoot, "prepared-document.zip"), document)
  try {
    // Fixed order declared before execution; no retry-until-pass or selecting the fastest sample.
    for (const task of ["weather", "document"] as const)
      for (const arm of ["technical-ui", "creator-dialogue"] as const)
        results.push(
          await profile(
            task,
            arm,
            task === "weather" ? weather : document,
            `http://127.0.0.1:${address.port}/v1`
          )
        )
    assert.equal(results.flatMap((value) => value.cells).length, 8)
    for (const task of ["weather", "document"] as const) {
      const pair = results.filter((value) => value.task === task)
      assert.equal(pair.length, 2)
      assert.equal(pair[0].cells[0].byteDigest, pair[1].cells[0].byteDigest)
      const prepared = task === "weather" ? weather : document
      const proofs = pair.map((entry) =>
        verifyPreparedImplementation(prepared, join(entry.root, "data/plugins", `paired-${task}`))
      )
      for (const proof of proofs) assert.equal(proof.zipSha256, pair[0].cells[0].byteDigest)
      assert.equal(proofs[0].implementationSha256, proofs[1].implementationSha256)
      assert.deepEqual(proofs[0].files, proofs[1].files)
      // Native compiled digests remain bound to each installation and its original grants.
      // Portable equality uses exact ZIP/files, never a copied cross-HOME grant identity.
      implementationProofs.push({
        task,
        profiles: pair.map((entry, index) => ({
          arm: entry.arm,
          root: entry.root,
          implementation: proofs[index],
          nativeSource: entry.cells[0].sourceBefore
        }))
      })
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    writeFileSync(
      join(outputRoot, "comparison.json"),
      JSON.stringify(
        {
          results,
          implementationProofs,
          errors,
          allHttp,
          accepted: false,
          comparison:
            "Same current version common intersection; no historical S0 or percentage claim",
          limitations: [
            "One sample per cell, no statistical claim",
            "Common source approval is bounded native harness, not measured human choice",
            "Model/account installation and supplied implementation effort excluded explicitly",
            "No real vendor spending; usage may be unknown",
            "Candidate requires narrow checks and independent review before actual execution"
          ]
        },
        null,
        2
      )
    )
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
