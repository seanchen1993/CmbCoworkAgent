/** Real Electron/SQLite/chat/Radix thumb interaction; no model, synthetic renderer or old-package fallback. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { isChatRowPresented } from "../src/renderer/src/components/chat/chat-row-presentation"
import type { ElectronApplication, Locator, Page } from "playwright"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

import {
  historyScale,
  processObservation,
  readableDuration
} from "./support/performance-acceptance"
import { runThreadDisplayMetadataCases } from "./support/thread-display-metadata-e2e"

const messageCount = historyScale(process.env.CHAT_HISTORY_MESSAGES)
const lastMessageId = `history-thumb-${messageCount - 1}`
const repetitions = Number(process.env.CHAT_HISTORY_REPETITIONS ?? "1")
assert(
  Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 30,
  "Repetitions must be 1..30"
)

async function processSample(app: ElectronApplication) {
  return app.evaluate(({ app }) =>
    app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      creationTime: metric.creationTime,
      type: metric.type,
      cumulativeCpuSeconds: metric.cpu.cumulativeCPUUsage,
      workingSetKiB: metric.memory.workingSetSize
    }))
  )
}

interface Observation {
  elapsedMs: number
  frames: number[]
  longTasks: number[]
  pings: number[]
  peakMountedRows: number
  maxBlankMs: number
  maxPendingMs: number
  geometryFallbacks: number
  geometryRowsChecked: number
  seenMessages: string[]
  blankEpisodes: Array<{
    start: number
    end: number
    duration: number
    phase: string
    endedPhase: string
  }>
}
interface HistoryWindow extends Window {
  historyRowPresented(row: Element): boolean
  historyInteraction: {
    snapshot(): { readable: number; pending: number; mounted: number }
    phase(label: string): void
    stop(): Promise<Observation>
  }
}

const root = resolve(__dirname, "..")
const executedCandidate = projectCompositionCandidate(root)
function rendererFingerprint() {
  const directory = join(root, "out/renderer")
  const files: Array<{ path: string; sha256: string }> = []
  const visit = (folder: string) => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, item.name)
      if (item.isDirectory()) visit(path)
      else if (item.isFile())
        files.push({
          path: relative(directory, path).replaceAll("\\", "/"),
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex")
        })
    }
  }
  visit(directory)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex") }
}
const candidate = {
  ...executedCandidate,
  renderer: executedCandidate.execution === "built-output" ? rendererFingerprint() : undefined
}
const sourceFiles = [
  "src/renderer/src/components/chat/ChatContainer.tsx",
  "src/renderer/src/components/chat/ChatMessageVirtualList.tsx",
  "src/renderer/src/components/chat/MessageBubble.tsx",
  "src/renderer/src/components/chat/StreamingMarkdown.tsx",
  "src/renderer/src/components/chat/user-content-overflow.ts",
  "src/renderer/src/components/chat/FunctionSite.tsx",
  "src/renderer/src/lib/function-site-geometry.ts",
  "src/renderer/src/lib/mods-chat-scope.tsx",
  "src/renderer/src/components/chat/chat-virtual-window.ts",
  "src/renderer/src/lib/function-site-queue.ts",
  "src/main/mods/v2/manager.ts",
  "src/main/mods/v2/sites.ts"
]
const parseCachePath = "src/renderer/src/lib/markdown-parse-cache.ts"
if (existsSync(join(root, parseCachePath))) sourceFiles.push(parseCachePath)
// Include newly introduced local parsing helpers when present, without implying
// that a previously built renderer already contains unbuilt worktree changes.
const markdownSource = join(root, "src/renderer/src/components/chat/StreamingMarkdown.tsx")
for (const match of readFileSync(markdownSource, "utf8").matchAll(
  /from\s+["'](\.[^"']*(?:markdown|parse)[^"']*)["']/gi
)) {
  for (const extension of [".ts", ".tsx"]) {
    const path = resolve(dirname(markdownSource), match[1] + extension)
    if (existsSync(path)) sourceFiles.push(relative(root, path).replaceAll("\\", "/"))
  }
}
const source = Object.fromEntries(
  sourceFiles.map((path) => [
    path,
    createHash("sha256")
      .update(readFileSync(join(root, path)))
      .digest("hex")
  ])
)
type HistoryCase = "ordinary" | "protected" | "unrelated-approved-guest"
// Preserve old runner arguments while making the recorded scope explicit.
const requested =
  process.env.CHAT_HISTORY_CASE === "guest"
    ? "unrelated-approved-guest"
    : process.env.CHAT_HISTORY_CASE
const diagnostic = process.env.CHAT_HISTORY_DIAGNOSTIC === "1"
const metadataRacePreflight = process.env.CHAT_HISTORY_METADATA_RACE === "1"
const presentationScenario = process.env.CHAT_HISTORY_PRESENTATION_SCENARIO
assert(!presentationScenario || ["detach", "deadline"].includes(presentationScenario),
  "Presentation scenario must be detach or deadline")
assert(
  !requested || ["ordinary", "protected", "unrelated-approved-guest"].includes(requested),
  "Unknown case"
)
const displayObservability = {
  productionBridgeInstrumented: false,
  siteRead: null,
  siteMountOutcome: null,
  siteRender: null,
  siteUnmount: null,
  guestEvaluations: null,
  sourceGuardChecks: null,
  policyInvocations: null,
  measured: "Actual visible DOM, input/presentation ping and Electron process intervals",
  limitation:
    "Unmeasured calls are null, never zero. Explicit legacy admission probe is outside history observation; an approved Pane source does not prove an AssistantMessage handler ran. No model is invoked or stubbed."
}

async function beginObservation(page: Page, threadId: string) {
  await page.evaluate(
    ({ threadId, diagnostic }) => {
      const scope = document.querySelector<HTMLElement>(`[data-chat-thread-id="${threadId}"]`)!
      const viewport = scope.querySelector<HTMLElement>(
        "[data-chat-message-scroll-area] [data-radix-scroll-area-viewport]"
      )!
      if (!viewport) throw Error("Actual chat viewport required")
      const bridge = window.api.windowPresentation
      if (!bridge) throw Error("Native window-presentation ping bridge required")
      const visible = new Set<HTMLElement>(),
        observed = new Set<HTMLElement>(),
        seen = new Set<string>()
      let stopped = false,
        frame = 0,
        peakMountedRows = 0
      let previous: number | undefined
      let phase = "initial-ready",
        blankPhase = "initial-ready",
        episodeCaptured = false,
        diagnosticCount = 0
      let blankStart: number | undefined,
        pendingStart: number | undefined,
        maxBlankMs = 0,
        maxPendingMs = 0
      let geometryFallbacks = 0,
        geometryRowsChecked = 0
      const start = performance.now(),
        frames: number[] = [],
        longTasks: number[] = [],
        pings: number[] = []
      const blankEpisodes: Observation["blankEpisodes"] = []
      const intersection = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const row = entry.target as HTMLElement
            if (entry.isIntersecting) visible.add(row)
            else visible.delete(row)
          }
        },
        { root: viewport }
      )
      const refresh = () => {
        const rows = new Set(scope.querySelectorAll<HTMLElement>("[data-chat-message-row]"))
        peakMountedRows = Math.max(peakMountedRows, rows.size)
        for (const row of observed)
          if (!rows.has(row)) {
            intersection.unobserve(row)
            observed.delete(row)
            visible.delete(row)
          }
        for (const row of rows)
          if (!observed.has(row)) {
            observed.add(row)
            intersection.observe(row)
          }
      }
      const mutation = new MutationObserver(refresh)
      mutation.observe(viewport, { childList: true, subtree: true })
      refresh()
      const snapshot = () => {
        let readable = 0,
          pending = 0
        for (const row of visible) {
          if (!(window as unknown as HistoryWindow).historyRowPresented(row)) continue
          if (row.querySelector("[data-function-site-pending]")) pending++
          else if (row.textContent?.includes("HISTORY_CASE_")) {
            readable++
            seen.add(row.dataset.chatMessageId ?? "")
          }
        }
        if (!readable && observed.size) {
          // Virtual rows can mount before IntersectionObserver delivers its next batch.
          // Confirm a zero-readable candidate against the bounded mounted window instead
          // of reporting that delivery delay as an empty presentation.
          geometryFallbacks++
          readable = 0
          pending = 0
          const area = viewport.getBoundingClientRect()
          for (const row of observed) {
            if (!(window as unknown as HistoryWindow).historyRowPresented(row)) continue
            geometryRowsChecked++
            const box = row.getBoundingClientRect()
            if (box.height <= 0 || box.bottom <= area.top || box.top >= area.bottom) continue
            if (row.querySelector("[data-function-site-pending]")) pending++
            else if (row.textContent?.includes("HISTORY_CASE_")) {
              readable++
              seen.add(row.dataset.chatMessageId ?? "")
            }
          }
        }
        return { readable, pending, mounted: observed.size }
      }
      const tick = (now: number) => {
        if (previous !== undefined) frames.push(now - previous)
        previous = now
        const current = snapshot()
        if (!current.readable) {
          if (blankStart === undefined) {
            blankStart = now
            blankPhase = phase
          }
        } else if (blankStart !== undefined) {
          maxBlankMs = Math.max(maxBlankMs, now - blankStart)
          blankEpisodes.push({
            start: blankStart,
            end: now,
            duration: now - blankStart,
            phase: blankPhase,
            endedPhase: phase
          })
          blankStart = undefined
          episodeCaptured = false
        }
        if (current.pending) pendingStart ??= now
        else if (pendingStart !== undefined) {
          maxPendingMs = Math.max(maxPendingMs, now - pendingStart)
          pendingStart = undefined
        }
        if (
          diagnostic &&
          blankStart !== undefined &&
          now - blankStart > 100 &&
          !episodeCaptured &&
          diagnosticCount < 12
        ) {
          episodeCaptured = true
          diagnosticCount++
          // One layout sample only after an observed anomaly. Normal frame metrics
          // continue to use IntersectionObserver, without synchronous geometry reads.
          const area = viewport.getBoundingClientRect()
          const rows = [...scope.querySelectorAll<HTMLElement>("[data-chat-message-row]")].map(
            (row) => {
              const box = row.getBoundingClientRect()
              return {
                id: row.dataset.chatMessageId,
                top: box.top - area.top,
                bottom: box.bottom - area.top,
                height: box.height,
                intersects: box.bottom > area.top && box.top < area.bottom && box.height > 0,
                marker: Boolean(row.textContent?.includes("HISTORY_CASE_")),
                text: row.textContent?.slice(0, 160),
                pending: row.querySelectorAll("[data-function-site-pending]").length,
                cached: row.querySelectorAll("[data-function-site-cached]").length,
                sites: [...row.querySelectorAll<HTMLElement>("[data-function-site]")].map(
                  (site) => ({
                    component: site.dataset.functionSite,
                    plugin: site.dataset.functionPlugin,
                    inert: site.inert,
                    busy: site.getAttribute("aria-busy")
                  })
                )
              }
            }
          )
          const gaps = [...scope.querySelectorAll<HTMLElement>("[data-chat-history-boundary]")].map(
            (gap) => {
              const box = gap.getBoundingClientRect()
              return {
                kind: gap.dataset.chatHistoryBoundary,
                top: box.top - area.top,
                bottom: box.bottom - area.top,
                height: box.height,
                intersects: box.bottom > area.top && box.top < area.bottom && box.height > 0,
                text: gap.textContent?.slice(0, 240),
                buttons: [...gap.querySelectorAll("button")].map((button) => ({
                  label: button.textContent,
                  disabled: button.disabled
                }))
              }
            }
          )
          const dom = {
            sampledAt: performance.now(),
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
            viewport: { top: area.top, height: area.height, width: area.width },
            rows,
            gaps,
            ioVisibleIds: [...visible].map((row) => row.dataset.chatMessageId),
            initialPresentation: scope
              .querySelector("[data-chat-initial-presentation]")
              ?.getAttribute("data-chat-initial-presentation")
          }
          const capture = Reflect.get(window, "captureHistoryBlank") as
            | ((value: unknown) => Promise<void>)
            | undefined
          void capture?.({
            index: diagnosticCount,
            detectedAt: now,
            blankMs: now - blankStart,
            phase,
            io: current,
            dom
          }).catch(() => {})
        }
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
      const tasks = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration)
      })
      tasks.observe({ entryTypes: ["longtask"] })
      const ping = (async () => {
        while (!stopped) {
          const sent = performance.now()
          await bridge.read()
          pings.push(performance.now() - sent)
          if (!stopped) await new Promise<void>((done) => setTimeout(done, 40))
        }
      })()
      ;(window as unknown as HistoryWindow).historyInteraction = {
        snapshot,
        phase: (label) => {
          phase = label
        },
        stop: async () => {
          stopped = true
          cancelAnimationFrame(frame)
          mutation.disconnect()
          intersection.disconnect()
          tasks.disconnect()
          const now = performance.now()
          if (blankStart !== undefined) maxBlankMs = Math.max(maxBlankMs, now - blankStart)
          if (blankStart !== undefined)
            blankEpisodes.push({
              start: blankStart,
              end: now,
              duration: now - blankStart,
              phase: blankPhase,
              endedPhase: phase
            })
          if (pendingStart !== undefined) maxPendingMs = Math.max(maxPendingMs, now - pendingStart)
          await ping
          return {
            elapsedMs: now - start,
            frames,
            longTasks,
            pings,
            peakMountedRows,
            maxBlankMs,
            maxPendingMs,
            geometryFallbacks,
            geometryRowsChecked,
            seenMessages: [...seen],
            blankEpisodes
          }
        }
      }
    },
    { threadId, diagnostic }
  )
}

async function dragThumb(
  page: Page,
  scroll: Locator,
  viewport: Locator,
  fraction: number,
  label = "setup"
) {
  const phase = (stage: string) =>
    page.evaluate((value) => {
      const monitor = (window as Partial<HistoryWindow>).historyInteraction
      monitor?.phase(value)
    }, `${label}:${stage}`)
  const box = await viewport.boundingBox()
  assert(box, "actual chat viewport geometry required")
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2)
  const bar = scroll.locator('[data-scroll-area-scrollbar][data-orientation="vertical"]')
  const thumb = bar.locator(":scope > div").first()
  await thumb.waitFor({ state: "visible" })
  const track = await bar.boundingBox(),
    handle = await thumb.boundingBox()
  assert(track && handle && track.height > handle.height, "draggable overflow thumb required")
  const before = await viewport.evaluate((node) => node.scrollTop)
  const start = performance.now()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  if (diagnostic) await phase("pointer-down")
  await page.mouse.down()
  if (diagnostic) await phase("moving")
  await page.mouse.move(
    handle.x + handle.width / 2,
    track.y + handle.height / 2 + (track.height - handle.height) * fraction,
    { steps: 18 }
  )
  await page.mouse.up()
  const released = performance.now()
  if (diagnostic) await phase("released")
  return { before, start, released, track, handle }
}

async function runCase(mode: HistoryCase) {
  const fixture = projectCompositionEnvironment(root)
  const protectedOutput = mode !== "ordinary"
  const events: unknown[] = [],
    errors: string[] = []
  let app: ElectronApplication | undefined,
    page: Page | undefined,
    passed = false
  const captures: Promise<void>[] = []
  const record = (event: unknown) => {
    events.push(event)
    appendFileSync(join(fixture.isolated, "interaction.ndjson"), JSON.stringify(event) + "\n")
    console.log(JSON.stringify({ mode, event }))
  }
  try {
    const launch = createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })
    if (presentationScenario) {
      assert(protectedOutput, "Presentation waiting requires real protected message sites")
      const bootstrap = join(fixture.isolated, "headless-main.cjs")
      const hold = `
const historyPresentationHold=globalThis.__historyPresentationHold={enabled:false,waiters:[]};
const originalHistoryHandle=ipcMain.handle;
ipcMain.handle=function(channel,listener){return originalHistoryHandle.call(this,channel,
  async function(event,...args){
    if(channel==='mods:function-site-read'&&historyPresentationHold.enabled&&
      ['UserMessage','AssistantMessage'].includes(args[0]?.component))
      await new Promise(resolve=>historyPresentationHold.waiters.push(resolve));
    return listener.call(this,event,...args)
  })};
`
      writeFileSync(bootstrap, readFileSync(bootstrap, "utf8").replace(
        "const {app,BrowserWindow,ipcMain}=electron;",
        marker => marker + hold
      ))
    }
    app = await launch()
    app
      .process()
      .stdout?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
    app
      .process()
      .stderr?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
    page = await app.firstWindow({ timeout: 60000 })
    // Test serializer helper only: tsx keepNames may decorate nested functions
    // inside Playwright evaluate bodies. This does not replace any product bridge.
    const serializer = "globalThis.__name = (fn) => fn"
    await page.addInitScript(serializer)
    await page.evaluate(serializer)
    const presentationCheck = `globalThis.historyRowPresented = ${isChatRowPresented.toString()}`
    await page.addInitScript(presentationCheck)
    await page.evaluate(presentationCheck)
    if (diagnostic)
      await page.exposeBinding(
        "captureHistoryBlank",
        async (
          _source,
          event: {
            index: number
            detectedAt: number
            blankMs: number
            phase: string
            io: unknown
            dom: unknown
          }
        ) => {
          const capture = (async () => {
            record({ kind: "diagnostic-no-readable-sample", ...event })
            const path = join(fixture.isolated, `blank-${event.index}.png`)
            await page!.screenshot({ path })
            const capturedAt = await page!.evaluate(() => performance.now())
            record({
              kind: "diagnostic-screenshot",
              index: event.index,
              path,
              capturedAt,
              delayFromDetectionMs: capturedAt - event.detectedAt
            })
          })()
          captures.push(capture)
          await capture
        }
      )
    page.setDefaultTimeout(15000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.waitForFunction(() => !!window.api?.threads)
    if (metadataRacePreflight) await runThreadDisplayMetadataCases(app, page, fixture, record)
    const title = `History thumb acceptance ${mode}`
    const threadId = await page.evaluate(
      async ({ workspace, title, protectedOutput, messageCount }) => {
        const thread = await window.api.threads.create({
          title,
          workspacePath: workspace,
          agentMode: "normal"
        })
        const id = thread.thread_id
        await window.api.workspace.set(id, workspace)
        await window.api.mods.configureGlobal(protectedOutput)
        const config = await window.api.mods.status(id)
        await window.api.mods.configure(id, protectedOutput, protectedOutput, config.workspace)
        for (let offset = 0; offset < messageCount; offset += 50) {
          const messages = Array.from({ length: 50 }, (_, position) => {
            const ordinal = offset + position
            const kind = ordinal % 4
            const body =
              kind === 0
                ? "A long user requirement with stable layout and explicit acceptance.\n".repeat(40)
                : kind === 1
                  ? "## Actual persisted report\n\n" +
                    "A rendered **Markdown** paragraph with useful details.\n\n".repeat(32)
                  : kind === 2
                    ? "A compact question that still belongs to the same persisted conversation."
                    : "```typescript\n" +
                      Array.from(
                        { length: 28 },
                        (_, index) => `const item${index} = ${index}`
                      ).join("\n") +
                      "\n```\n\n| Item | Outcome |\n| --- | --- |\n| actual history | validated |\n".repeat(
                        4
                      )
            return {
              id: `history-thumb-${ordinal}`,
              role: ordinal % 2 ? ("assistant" as const) : ("user" as const),
              created_at: new Date(1700000000000 + ordinal),
              content: `HISTORY_CASE_${ordinal}\n\n${body}`
            }
          })
          const result = await window.api.threads.appendMessages(id, messages)
          if (result.count !== messages.length) throw Error("History persistence incomplete")
        }
        const persisted = await window.api.threads.getMessagesPage(id, {
          limit: 500,
          byteBudget: 4 * 1024 * 1024
        })
        if (
          persisted.total !== messageCount ||
          persisted.messages.at(-1)?.id !== `history-thumb-${messageCount - 1}` ||
          persisted.messages.length !== Math.min(messageCount, 500)
        )
          throw Error("Durable history total and real persisted tail required")
        return id
      },
      { workspace: fixture.workspace, title, protectedOutput, messageCount }
    )
    record({
      kind: "fixture",
      historyProvenance: "Synthetic messages appended through native IPC in a new isolated profile; no real user history was read or replayed",
      threadId,
      messageCount,
      candidate,
      source,
      sourceProvenance:
        "Current worktree hashes; renderer artifact hash identifies actual executed code. WIP may not be rebuilt.",
      displayObservability,
      currentSourceMatchesExecutedArtifact: null,
      wholeHostMessageSamples: false,
      protection:
        mode === "unrelated-approved-guest"
          ? "native output policy plus exact approved builtin FunctionGuest; matching AssistantMessage execution is not established"
          : protectedOutput
            ? "native output policy; no guest installed or approved"
            : "Mods disabled"
    })
    if (mode === "unrelated-approved-guest") {
      const guest = await page.evaluate(async (threadId) => {
        // Fixture-only consent in this new isolated profile; no user's existing plugin is approved.
        const started = performance.now()
        await window.api.mods.installExamples()
        const initial = await window.api.mods.status(threadId)
        const selected = initial.functionMods?.find((item) => item.name === "function-commands")
        if (!selected?.digest || selected.state !== "needs-approval")
          throw Error("Exact bundled function-commands source requiring fresh consent expected")
        const compatibility = await window.api.mods.checkFunctionCompatibility(
          threadId,
          selected.pluginId,
          selected.digest,
          initial.workspace
        )
        if (compatibility.digest !== selected.digest)
          throw Error("Bundled source changed during inspection")
        await window.api.mods.approveFunction(
          threadId,
          selected.pluginId,
          selected.digest,
          initial.workspace
        )
        const approved = await window.api.mods.status(threadId)
        if (approved.mods.some((item) => item.state === "ready"))
          throw Error("Unselected legacy example was approved")
        const ready = approved.functionMods?.filter((item) => item.state === "ready") ?? []
        if (
          ready.length !== 1 ||
          ready[0].pluginId !== selected.pluginId ||
          ready[0].digest !== selected.digest
        )
          throw Error("Only the exact selected Function source may be ready")
        // These descriptors come from actual session.start SDK registration, never manifest guesses.
        const commands = await window.api.mods.commands(threadId)
        const command = commands.find(
          (item) =>
            item.apiVersion === "cmb.mods/v2" &&
            item.modId === "function:function-commands" &&
            item.command === "claw-info"
        )
        if (command?.digest !== selected.digest)
          throw Error("Real approved FunctionGuest did not register claw-info")
        const mounted = await window.api.mods.siteMountOutcome(threadId, "AssistantMessage")
        if (mounted.state !== "mounted") throw Error("Real Guest display route did not mount")
        try {
          const drawing = await window.api.mods.siteRender(threadId, mounted.owner, {
            text: "HISTORY_CASE_GUEST_AUTHORIZED_PROBE",
            isFirstOfReply: true
          })
          if (
            !drawing?.nativeFallback ||
            !drawing.nativeContent?.entries.some(
              (entry) => entry.props.text === "HISTORY_CASE_GUEST_AUTHORIZED_PROBE"
            )
          )
            throw Error("Guest route must retain actual native-authorized message text")
        } finally {
          await window.api.mods.siteUnmount(threadId, mounted.owner)
        }
        return {
          pluginId: selected.pluginId,
          name: selected.name,
          digest: selected.digest,
          capabilities: selected.capabilities,
          admissionMs: performance.now() - started,
          command: { command: command.command, digest: command.digest },
          unapprovedLegacy: approved.mods.map((item) => ({
            pluginId: item.pluginId,
            state: item.state
          }))
        }
      }, threadId)
      record({
        kind: "real-guest-admission-before-history-observation",
        ...guest,
        scope:
          "Exact native source admission and explicit legacy display probe; not an AssistantMessage match or siteRead/guest evaluation count"
      })
    }
    const processBefore = await processSample(app)
    const intervalStarted = performance.now()
    const coldRequestedAt = performance.now()
    if (presentationScenario) await app.evaluate(() => {
      ;(globalThis as unknown as { __historyPresentationHold: { enabled: boolean } })
        .__historyPresentationHold.enabled = true
    })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click()
    const chat = page.locator(`[data-chat-thread-id="${threadId}"]`)
    const scroll = chat.locator("[data-chat-message-scroll-area]")
    const viewport = scroll.locator("[data-radix-scroll-area-viewport]")
    if (presentationScenario) {
      await page.waitForFunction(id => document.querySelector(
        `[data-chat-message-id="${id}"] [data-function-site-pending]`
      ) !== null, lastMessageId)
      const waitingAt = performance.now()
      const returnButton = chat.getByRole("button", { name: "回到会话底部", exact: true })
      assert.equal(await returnButton.isVisible(), false, "Cold waiting retains initial follow intent")
      if (presentationScenario === "detach") {
        await viewport.hover()
        await page.mouse.wheel(0, -600)
      }
      await returnButton.waitFor({ state: "visible", timeout: 7000 })
      const elapsedMs = performance.now() - waitingAt
      if (presentationScenario === "deadline") {
        assert(elapsedMs > 3500, "Pending authorization must not consume the 60-frame geometry budget")
      }
      await app.evaluate(() => {
        const hold = (globalThis as unknown as {
          __historyPresentationHold: { enabled: boolean; waiters: Array<() => void> }
        }).__historyPresentationHold
        hold.enabled = false
        hold.waiters.splice(0).forEach(resolve => resolve())
      })
      await page.waitForFunction(threadId => {
        const viewport = document.querySelector(
          `[data-chat-thread-id="${threadId}"] [data-radix-scroll-area-viewport]`
        )!
        const area = viewport.getBoundingClientRect()
        return [...viewport.querySelectorAll<HTMLElement>("[data-chat-message-row]")].some(row => {
          const box = row.getBoundingClientRect()
          return box.bottom > area.top && box.top < area.bottom &&
            (window as unknown as HistoryWindow).historyRowPresented(row) &&
            !row.querySelector("[data-function-site-pending]") &&
            row.textContent?.includes("HISTORY_CASE_")
        })
      }, threadId)
      const detached = await viewport.evaluate(node => ({
        top: node.scrollTop,
        bottomGap: node.scrollHeight - node.scrollTop - node.clientHeight
      }))
      assert(await returnButton.isVisible(), "Late presentation completion must retain detached intent")
      assert(detached.bottomGap > 100, "Late presentation completion must not pull the reader to the tail")
      record({ kind: "presentation-wait-boundary", scenario: presentationScenario, elapsedMs,
        detached, realProtectedIpc: true, outputsReplaced: false })
      await returnButton.click()
    }
    await chat.locator(`[data-chat-message-id="${lastMessageId}"]`).waitFor({ state: "visible" })
    await chat.locator('[data-chat-initial-presentation="ready"]').waitFor()
    await page.waitForFunction(
      (id) => {
        const row = document.querySelector(`[data-chat-message-id="${id}"]`)
        const viewport = row?.closest("[data-radix-scroll-area-viewport]")
        if (
          !row ||
          !viewport ||
          !(window as unknown as HistoryWindow).historyRowPresented(row) ||
          row.querySelector("[data-function-site-pending]") ||
          !row.textContent?.includes("HISTORY_CASE_")
        )
          return false
        const box = row.getBoundingClientRect(),
          area = viewport.getBoundingClientRect()
        return box.height > 0 && box.bottom > area.top && box.top < area.bottom
      },
      lastMessageId,
      { polling: "raf" }
    )
    record({
      kind: "cold-native-first-page",
      fixtureId: fixture.isolated,
      durationMs: readableDuration({
        requestedAtMs: coldRequestedAt,
        readableAtMs: performance.now()
      }),
      includesSourceGuard: true,
      scope: "reload-and-select-through-visible-body-dom-after-explicit-admission",
      guestStartupCold: false,
      pixelsMeasured: false
    })
    if (presentationScenario) {
      await page.screenshot({ path: join(fixture.isolated, "presentation-wait-recovered.png") })
      passed = true
      return
    }
    // Load any actual history-page boundary through the existing UI before testing the full range.
    let pageLoads = 0
    for (
      let attempt = 0;
      attempt < Math.ceil(messageCount / 50) + 4 &&
      (await chat.locator('[data-chat-history-boundary="older"]').count());
      attempt++
    ) {
      const detached = await dragThumb(page, scroll, viewport, 0)
      record({
        kind: "detach-to-page-head",
        before: detached.before,
        pointerMs: detached.released - detached.start
      })
      const earlier = chat.locator('[data-chat-history-boundary="older"]')
      await earlier.waitFor({ state: "visible" })
      // Wait for the real old-page head instead of guessing its ID from a count
      // or reading stale tail DOM immediately after assigning scrollTop.
      await page.waitForFunction(
        ({ id, lastMessageId }) => {
          const scope = document.querySelector(`[data-chat-thread-id="${id}"]`)
          const viewport = scope?.querySelector(
            "[data-chat-message-scroll-area] [data-radix-scroll-area-viewport]"
          )
          if (!viewport) return false
          const area = viewport.getBoundingClientRect()
          const boundary = scope
            ?.querySelector('[data-chat-history-boundary="older"]')
            ?.getBoundingClientRect()
          if (!boundary || boundary.bottom <= area.top || boundary.top >= area.bottom) return false
          return [...(scope?.querySelectorAll<HTMLElement>("[data-chat-message-row]") ?? [])].some(
            (row) => {
              const box = row.getBoundingClientRect()
              return (
                box.bottom > area.top &&
                box.top < area.bottom &&
                row.dataset.chatMessageId !== lastMessageId
              )
            }
          )
        },
        { id: threadId, lastMessageId }
      )
      const before = await viewport.evaluate((node) => {
        const area = node.getBoundingClientRect(),
          top = area.top
        const row = [...node.querySelectorAll<HTMLElement>("[data-chat-message-row]")].find(
          (row) => row.getBoundingClientRect().bottom > top
        )
        return {
          observedAt: performance.now(),
          id: row?.dataset.chatMessageId,
          relativeTop: row ? row.getBoundingClientRect().top - top : null,
          height: row?.getBoundingClientRect().height,
          pending: row?.querySelectorAll("[data-function-site-pending]").length,
          readable: row?.textContent?.includes("HISTORY_CASE_"),
          scrollTop: node.scrollTop,
          rows: [...node.querySelectorAll<HTMLElement>("[data-chat-message-row]")].map((row) => {
            const box = row.getBoundingClientRect()
            return {
              id: row.dataset.chatMessageId,
              top: box.top - top,
              height: box.height,
              pending: row.querySelectorAll("[data-function-site-pending]").length,
              readable: row.textContent?.includes("HISTORY_CASE_")
            }
          }),
          label: node.querySelector('[data-chat-history-boundary="older"]')?.textContent
        }
      })
      const started = performance.now()
      await earlier.click()
      await page.waitForFunction(
        (id) => {
          const current = document.querySelector<HTMLButtonElement>(
            `[data-chat-thread-id="${id}"] [data-chat-history-boundary="older"]`
          )
          return !current || !current.disabled
        },
        threadId
      )
      // React commits the loading/disabled state during the click. Waiting for
      // its release also works when two pages both offer "the earlier 500".
      // This is not completion of the animation-frame anchor restore. Keep its original budget:
      // with no sleeps: a loaded body must retain its offset for 12 real frames.
      const restoration = await viewport.evaluate(async (node, before) => {
        const frames: Array<{
          frame: number
          elapsedMs: number
          top: number | null
          pending: number
          pendingRows: number
          pendingPresentations: number
          readable: boolean
          stableFrames: number
        }> = []
        let stableFrames = 0
        for (let frame = 0; frame < 120 && performance.now() - before.observedAt <= 2000; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const rows = [...node.querySelectorAll<HTMLElement>("[data-chat-message-row]")]
          const row = rows.find((item) => item.dataset.chatMessageId === before.id)
          const top = row
            ? row.getBoundingClientRect().top - node.getBoundingClientRect().top
            : null
          const pending = row?.querySelectorAll("[data-function-site-pending]").length ?? 0
          const unresolved = '[data-function-site-pending], [data-function-site][aria-busy="true"]'
          const pendingRows = rows.filter((item) => item.querySelector(unresolved)).length
          const pendingPresentations = node.querySelectorAll(unresolved).length
          const readable = !!row?.textContent?.includes("HISTORY_CASE_")
          const elapsedMs = performance.now() - before.observedAt
          stableFrames =
            top !== null &&
            before.relativeTop !== null &&
            Math.abs(top - before.relativeTop) <= 4 &&
            !pending &&
            pendingPresentations === 0 &&
            readable &&
            elapsedMs <= 2000
              ? stableFrames + 1
              : 0
          frames.push({
            frame,
            elapsedMs,
            top,
            pending,
            pendingRows,
            pendingPresentations,
            readable,
            stableFrames
          })
          if (stableFrames >= 12) break
        }
        return { settled: stableFrames >= 12, frames }
      }, before)
      const after = await viewport.evaluate((node, before) => {
        const row = [...node.querySelectorAll<HTMLElement>("[data-chat-message-row]")].find(
          (row) => row.dataset.chatMessageId === before.id
        )
        return {
          id: row?.dataset.chatMessageId,
          relativeTop: row
            ? row.getBoundingClientRect().top - node.getBoundingClientRect().top
            : null,
          height: row?.getBoundingClientRect().height,
          pending: row?.querySelectorAll("[data-function-site-pending]").length,
          readable: row?.textContent?.includes("HISTORY_CASE_"),
          scrollTop: node.scrollTop,
          rows: [...node.querySelectorAll<HTMLElement>("[data-chat-message-row]")].map((row) => {
            const box = row.getBoundingClientRect()
            return {
              id: row.dataset.chatMessageId,
              top: box.top - node.getBoundingClientRect().top,
              height: box.height,
              pending: row.querySelectorAll("[data-function-site-pending]").length,
              readable: row.textContent?.includes("HISTORY_CASE_")
            }
          })
        }
      }, before)
      const readback = await page.evaluate(async (id) => {
        const data = await window.api.threads.getMessagesPage(id, {
          limit: 500,
          byteBudget: 4 * 1024 * 1024
        })
        return {
          total: data.total,
          count: data.messages.length,
          first: data.messages[0]?.id,
          last: data.messages.at(-1)?.id
        }
      }, threadId)
      record({
        kind: "native-history-page-boundary",
        elapsedMs: performance.now() - started,
        before,
        after,
        restoration,
        anchorDelta:
          before.relativeTop !== null && after.relativeTop !== null
            ? after.relativeTop - before.relativeTop
            : null,
        nativeReadback: readback
      })
      assert(
        restoration.settled,
        "native pagination must restore the readable anchor for 12 frames within its original budget"
      )
      assert(
        before.id && after.id === before.id,
        "native pagination must retain the visible message anchor"
      )
      assert(
        before.relativeTop !== null &&
          after.relativeTop !== null &&
          Math.abs(after.relativeTop - before.relativeTop) <= 4,
        "native pagination must preserve the same visible row position"
      )
      pageLoads++
    }
    assert(pageLoads > 0, "this fixture must exercise actual native history pagination")
    assert.equal(
      await chat.locator('[data-chat-history-boundary="older"]').count(),
      0,
      "all older native history pages must be exhausted before full-range interaction"
    )
    const oldestStarted = performance.now()
    await dragThumb(page, scroll, viewport, 0)
    await page.waitForFunction((id) => {
      const scope = document.querySelector(`[data-chat-thread-id="${id}"]`)
      const viewport = scope?.querySelector(
        "[data-chat-message-scroll-area] [data-radix-scroll-area-viewport]"
      )
      const oldest = scope?.querySelector('[data-chat-message-id="history-thumb-0"]')
      if (
        !viewport ||
        !oldest ||
        oldest.querySelector("[data-function-site-pending]") ||
        !oldest.textContent?.includes("HISTORY_CASE_0")
      )
        return false
      const area = viewport.getBoundingClientRect(),
        row = oldest.getBoundingClientRect()
      return row.height > 0 && row.bottom > area.top && row.top < area.bottom
    }, threadId)
    record({
      kind: "native-full-history-range-confirmed",
      pageLoads,
      oldestVisibleMessageId: "history-thumb-0",
      oldestReachMs: performance.now() - oldestStarted
    })
    // A long history retains an older prefix and a protected latest tail with a gap.
    // Stay detached, then use the real return action so the latest-window replacement
    // cannot be skipped merely because a thumb drag happened to expose the old tail.
    const returnDrag = await dragThumb(page, scroll, viewport, messageCount > 500 ? 0.65 : 1)
    const tailSetupDeadline = returnDrag.released + 15000
    const tailRemaining = () => Math.max(1, tailSetupDeadline - performance.now())
    const tailState = () =>
      page!.evaluate(
        ({ threadId, lastMessageId }) => {
          const scope = document.querySelector(`[data-chat-thread-id="${threadId}"]`)
          const viewport = scope?.querySelector<HTMLElement>(
            "[data-chat-message-scroll-area] [data-radix-scroll-area-viewport]"
          )
          const tail = scope?.querySelector<HTMLElement>(
            `[data-chat-message-id="${lastMessageId}"]`
          )
          const area = viewport?.getBoundingClientRect(),
            box = tail?.getBoundingClientRect()
          const pending =
            tail?.querySelectorAll(
              '[data-function-site-pending], [data-function-site][aria-busy="true"]'
            ).length ?? 0
          return {
            ready: Boolean(
              area &&
              box &&
              tail && (window as unknown as HistoryWindow).historyRowPresented(tail) &&
              box.height > 0 &&
              box.bottom > area.top &&
              box.top < area.bottom &&
              pending === 0 &&
              tail?.textContent?.includes(`HISTORY_CASE_${lastMessageId.split("-").at(-1)}`)
            ),
            tail: tail
              ? {
                  id: tail.dataset.chatMessageId,
                  top: box!.top - area!.top,
                  height: box!.height,
                  pending
                }
              : null,
            scrollTop: viewport?.scrollTop,
            scrollHeight: viewport?.scrollHeight,
            clientHeight: viewport?.clientHeight,
            distanceToBottom: viewport
              ? viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
              : null,
            rows: [
              ...(viewport?.querySelectorAll<HTMLElement>("[data-chat-message-row]") ?? [])
            ].map((row) => ({
              id: row.dataset.chatMessageId,
              top: row.getBoundingClientRect().top - area!.top,
              height: row.getBoundingClientRect().height,
              pending: row.querySelectorAll("[data-function-site-pending]").length
            }))
          }
        },
        { threadId, lastMessageId }
      )
    const afterReturnDrag = await tailState()
    record({
      kind: "native-tail-drag-endpoint",
      gesture: returnDrag,
      viewport: afterReturnDrag
    })
    let tailMethod = "thumb-drag"
    try {
      if (messageCount > 500 || !afterReturnDrag.ready) {
        // A cold virtual row may change the content height after the final pointer move.
        // This is setup for the measured gestures, not proof that one drag reached the tail.
        // Use only the actual native return action, sharing the original 15-second deadline.
        const latest = chat.getByRole("button", { name: "回到会话底部", exact: true })
        await page.waitForFunction(
          ({ threadId, lastMessageId }) => {
            const scope = document.querySelector(`[data-chat-thread-id="${threadId}"]`)
            const viewport = scope?.querySelector(
              "[data-chat-message-scroll-area] [data-radix-scroll-area-viewport]"
            )
            const tail = scope?.querySelector(`[data-chat-message-id="${lastMessageId}"]`)
            const button = scope?.querySelector('button[aria-label="回到会话底部"]')
            const buttonBox = button?.getBoundingClientRect()
            if (buttonBox && buttonBox.width > 0 && buttonBox.height > 0) return true
            if (
              !viewport ||
              !tail ||
              !(window as unknown as HistoryWindow).historyRowPresented(tail) ||
              tail.querySelector(
                '[data-function-site-pending], [data-function-site][aria-busy="true"]'
              ) ||
              !tail.textContent?.includes(`HISTORY_CASE_${lastMessageId.split("-").at(-1)}`)
            )
              return false
            const area = viewport.getBoundingClientRect(),
              box = tail.getBoundingClientRect()
            return box.height > 0 && box.bottom > area.top && box.top < area.bottom
          },
          { threadId, lastMessageId },
          { timeout: tailRemaining() }
        )
        if (await latest.isVisible()) {
          tailMethod = "thumb-drag-then-native-return-button"
          await latest.click({ timeout: tailRemaining() })
        }
        assert(
          messageCount <= 500 || tailMethod === "thumb-drag-then-native-return-button",
          "long-history setup must exercise the actual latest-window return action"
        )
      }
      await page.waitForFunction(
        ({ threadId, lastMessageId }) => {
          const scope = document.querySelector(`[data-chat-thread-id="${threadId}"]`)
          const viewport = scope?.querySelector(
            "[data-chat-message-scroll-area] [data-radix-scroll-area-viewport]"
          )
          const tail = scope?.querySelector(`[data-chat-message-id="${lastMessageId}"]`)
          if (
            !viewport ||
            !tail ||
            !(window as unknown as HistoryWindow).historyRowPresented(tail) ||
            tail.querySelector(
              '[data-function-site-pending], [data-function-site][aria-busy="true"]'
            ) ||
            !tail.textContent?.includes(`HISTORY_CASE_${lastMessageId.split("-").at(-1)}`)
          )
            return false
          const area = viewport.getBoundingClientRect(),
            box = tail.getBoundingClientRect()
          return box.height > 0 && box.bottom > area.top && box.top < area.bottom
        },
        { threadId, lastMessageId },
        { timeout: tailRemaining() }
      )
      const stability = await page.evaluate(
        async ({ threadId, lastMessageId, budgetMs }) => {
          const started = performance.now()
          let stableFrames = 0
          let previousTop: number | undefined
          let previousHeight: number | undefined
          const frames: Array<{ elapsedMs: number; ready: boolean; top?: number }> = []
          while (performance.now() - started < budgetMs && stableFrames < 12) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
            const scope = document.querySelector(`[data-chat-thread-id="${threadId}"]`)
            const viewport = scope?.querySelector(
              "[data-chat-message-scroll-area] [data-radix-scroll-area-viewport]"
            )
            const tail = scope?.querySelector(`[data-chat-message-id="${lastMessageId}"]`)
            const area = viewport?.getBoundingClientRect()
            const box = tail?.getBoundingClientRect()
            const top = box && area ? box.top - area.top : undefined
            const ready = Boolean(
              area && box && tail &&
              (window as unknown as HistoryWindow).historyRowPresented(tail) &&
              box.height > 0 && box.bottom > area.top && box.top < area.bottom &&
              !tail?.querySelector(
                '[data-function-site-pending], [data-function-site][aria-busy="true"]'
              ) && tail?.textContent?.includes(`HISTORY_CASE_${lastMessageId.split("-").at(-1)}`)
            )
            const stable = ready && top !== undefined && previousTop !== undefined &&
              previousHeight !== undefined && Math.abs(top - previousTop) <= 1 &&
              Math.abs(box!.height - previousHeight) <= 1
            stableFrames = stable ? stableFrames + 1 : 0
            previousTop = top
            previousHeight = box?.height
            frames.push({ elapsedMs: performance.now() - started, ready, top })
          }
          return { stableFrames, frames, elapsedMs: performance.now() - started }
        },
        { threadId, lastMessageId, budgetMs: tailRemaining() }
      )
      assert.equal(stability.stableFrames, 12, "the readable latest tail must remain stable for 12 frames")
      const settled = await tailState()
      record({
        kind: "native-tail-setup",
        method: tailMethod,
        elapsedMs: performance.now() - returnDrag.released,
        stability,
        viewport: settled
      })
      assert(
        settled.ready,
        "native return must expose the actual readable tail inside the viewport"
      )
    } catch (error) {
      record({
        kind: "native-tail-setup-failure",
        method: tailMethod,
        elapsedMs: performance.now() - returnDrag.released,
        viewport: await tailState()
      })
      throw error
    }
    await beginObservation(page, threadId)
    const readable = () =>
      page!.waitForFunction(
        () => {
          const status = (window as unknown as HistoryWindow).historyInteraction.snapshot()
          return status.readable > 0 && status.pending === 0
        },
        undefined,
        { timeout: 5000 }
      )
    await readable()
    const fractions = [0.05, 0.75, 0.25, 0.95, 0.1, 0.5]
    const releaseToReadableMs: number[] = []
    for (const [index, fraction] of fractions.entries()) {
      // Hover reveals the real Radix thumb. No scrollTop assignment simulates this gesture.
      const { before, start, released } = await dragThumb(
        page,
        scroll,
        viewport,
        fraction,
        `thumb-${index}-${fraction}`
      )
      // Release latency is distinct from unreadability while the thumb is still
      // moving. Validate actual visible body geometry here, without depending on
      // an IntersectionObserver update for a newly mounted virtual row.
      await page.waitForFunction(
        (id) => {
          const scope = document.querySelector(`[data-chat-thread-id="${id}"]`)
          const viewport = scope?.querySelector(
            "[data-chat-message-scroll-area] [data-radix-scroll-area-viewport]"
          )
          if (!viewport) return false
          const area = viewport.getBoundingClientRect()
          return [...(scope?.querySelectorAll<HTMLElement>("[data-chat-message-row]") ?? [])].some(
            (row) => {
              if (
                row.querySelector("[data-function-site-pending]") ||
                !row.textContent?.includes("HISTORY_CASE_")
              )
                return false
              const box = row.getBoundingClientRect()
              return box.height > 0 && box.bottom > area.top && box.top < area.bottom
            }
          )
        },
        threadId,
        { timeout: 1000, polling: "raf" }
      )
      const firstReadableMs = performance.now() - released
      releaseToReadableMs.push(firstReadableMs)
      assert(
        firstReadableMs <= 1000,
        "released thumb must show an actually visible readable message within one second"
      )
      await readable()
      if (diagnostic)
        await page.evaluate(() =>
          (window as unknown as HistoryWindow).historyInteraction.phase("readable-settled")
        )
      const after = await viewport.evaluate((node) => node.scrollTop)
      assert(
        Math.abs(after - before) > 100,
        "physical thumb drag must change the real history position"
      )
      record({
        kind: "thumb-drag",
        index,
        fraction,
        pointerMs: released - start,
        firstReadableMs,
        settleMs: performance.now() - released,
        before,
        after
      })
    }
    const input = chat.locator("textarea.composer-textarea").last()
    const inputStart = performance.now()
    await input.click()
    await page.keyboard.type("即时输入检查 history thumb", { delay: 0 })
    assert.equal(await input.inputValue(), "即时输入检查 history thumb")
    const inputMs = performance.now() - inputStart
    assert(inputMs < 1500, "typing after release must not remain blocked")
    const observation = await page.evaluate(() =>
      (window as unknown as HistoryWindow).historyInteraction.stop()
    )
    assert(observation.peakMountedRows < 100, "persisted history must keep a bounded DOM window")
    assert(observation.seenMessages.length > 8, "real drags must expose distinct history regions")
    assert(observation.maxBlankMs < 1500, "history must not remain an empty visible window")
    assert(observation.maxPendingMs < 5000, "protected messages must not remain pending after drag")
    assert(observation.pings.length > 0 && observation.frames.length > 10)
    assert.deepEqual(errors, [])
    record({
      kind: "electron-process-interval",
      ...processObservation(
        processBefore,
        await processSample(app),
        performance.now() - intervalStarted
      )
    })
    record({ kind: "interaction-results", inputMs, releaseToReadableMs, observation })
    await Promise.all(captures)
    await page.screenshot({ path: join(fixture.isolated, "history-thumb.png") })
    passed = true
  } catch (error) {
    record({ kind: "failure", message: error instanceof Error ? error.message : String(error) })
    if (page && !page.isClosed()) {
      try {
        await page.screenshot({ path: join(fixture.isolated, "failure.png") })
      } catch (captureError) {
        record({ kind: "failure-screenshot-error", message: String(captureError) })
      }
    }
    throw error
  } finally {
    await Promise.allSettled(captures)
    mkdirSync(fixture.isolated, { recursive: true })
    writeFileSync(
      join(fixture.isolated, "acceptance.json"),
      JSON.stringify(
        {
          passed,
          mode,
          diagnostic,
          metadataRacePreflight,
          messageCount,
          candidate,
          source,
          displayObservability,
          currentSourceMatchesExecutedArtifact: null,
          requestedCaseAlias: process.env.CHAT_HISTORY_CASE === "guest" ? "guest" : null,
          errors,
          events,
          profile: fixture.isolated,
          acceptanceLane: "native-functional-smoke",
          readabilityMeasurement: {
            candidates: "IntersectionObserver with bounded geometry verification of zero-readable samples",
            maxBlankMs: "Duration without a readable body; may show pending placeholders, not a pixel-blank claim",
            pixelBlankConfirmation: "Only separately captured screenshots confirm pixel appearance"
          },
          fixedMachineTimingPassed: false,
          soakPassed: false,
          wholeApplicationCpuMeasured: false
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ passed, mode, profile: fixture.isolated }))
    await app?.close()
  }
}

async function main() {
  for (let run = 0; run < repetitions; run++) {
    if (!requested || requested === "ordinary") await runCase("ordinary")
    if (!requested || requested === "protected") await runCase("protected")
    if (!requested || requested === "unrelated-approved-guest")
      await runCase("unrelated-approved-guest")
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
