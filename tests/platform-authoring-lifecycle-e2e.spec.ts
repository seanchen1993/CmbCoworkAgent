/** Actual creator tools, trusted consent, SDK file permissions, upgrade and recovery. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import type { DevelopmentTrialStatus } from "../src/shared/mods/development"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(
  process.env.COMPOSITION_E2E_PACKAGED_DIR || process.env.PLATFORM_G3_BUILT_PREVIEW === "1",
  "Use the coordinator's explicit packaged candidate or built preview"
)
const candidate = projectCompositionCandidate(root)
if (process.env.PLATFORM_G3_EXPECTED_SHA256)
  assert.equal(candidate.sha256, process.env.PLATFORM_G3_EXPECTED_SHA256)
const fixture = projectCompositionEnvironment(root)
const input = join(fixture.workspace, "real-trial-input.txt")
const output = join(fixture.workspace, "real-trial-output.txt")
const original = "G3_ACTUAL_FILE_BYTES_20261015\n"
const written = "G3_REAL_WRITE_CONFIRMED\n"
writeFileSync(input, original)
const readFiles = () => ({
  input: readFileSync(input, "utf8"),
  output: existsSync(output) ? readFileSync(output, "utf8") : null
})
const assertFiles = (expectedOutput: string | null, message?: string) =>
  assert.deepEqual(readFiles(), { input: original, output: expectedOutput }, message)
const files = (revision: number) => [
  {
    path: "plugin.json",
    text: JSON.stringify({
      name: "g3-real-file",
      version: `0.${revision}.0`,
      description: "读取当前目标文件；升级后明确授权写入；显式启动可停止的应用内定时器",
      mods: "mods/manifest.json"
    })
  },
  {
    path: "mods/manifest.json",
    text: JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "g3-real-file",
      entry: "main.ts",
      modelProtocol: "result-v1"
    })
  },
  {
    path: "mods/main.ts",
    text: `import type { Register } from "claude-code"
export const register: Register = (on) => {
  let ticks = 0
  on("session.start", async ($,event,next) => {
    ${revision === 3 ? 'throw Error("G3_REJECT_CANDIDATE")' : ""}
    await $.command.register({name:"g3-file",description:"核对当前目标的真实文件"})
    return next(event)
  })
  on("command.run", {command:"g3-file"}, async ($,event) => {
    if(event.args === "ticks") return {text:"TICKS:"+ticks}
    if(event.args === "timer") {
      $.clock.every(100,()=>{ticks++})
      return {text:"TIMER_STARTED_BY_USER"}
    }
    ${
      revision === 2 || revision === 3
        ? `await $.fs.write(${JSON.stringify(output)},${JSON.stringify(written)})`
        : ""
    }
    return {text:"READBACK:" + await $.fs.read(${JSON.stringify(revision === 1 ? input : output)})}
  })
}`
  }
]
const errors: string[] = [],
  requests: unknown[] = [],
  observations: unknown[] = []
let app: ElectronApplication | undefined, page: Page | undefined
let held = false,
  release: (() => void) | undefined,
  passed = false,
  permissions = 0
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of request) {
      raw += chunk
      assert(raw.length < 3_000_000)
    }
    const body = JSON.parse(raw)
    const messages = body.messages as Array<{ role: string; content: unknown }>
    const at = messages.findLastIndex((message) => message.role === "user")
    const prompt = JSON.stringify(messages[at])
    const revision = Number(/G3_R([1-4])/.exec(prompt)?.[1])
    assert(revision >= 1 && revision <= 4, prompt)
    assert(requests.length < 24, "Bounded loopback model")
    const results = messages.slice(at + 1).filter((message) => message.role === "tool")
    const args =
      results.length === 0
        ? {
            action: "save",
            id: "real-file",
            name: "真实文件试用",
            revision: revision - 1,
            files: files(revision)
          }
        : { action: results.length === 1 ? "check" : "request_trial", id: "real-file", revision }
    const tool = results.length < 3
    if (tool)
      assert(
        body.tools.some(
          (item: { function: { name: string } }) => item.function.name === "mod_authoring"
        )
      )
    requests.push({ revision, tool, args: tool ? args : undefined, results })
    if (!tool && revision === 1) {
      held = true
      await new Promise<void>((done) => {
        release = done
      })
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `g3-${requests.length}`,
              type: "function",
              function: { name: "mod_authoring", arguments: JSON.stringify(args) }
            }
          ]
        }
      : { role: "assistant", content: `G3_READY_${revision}` }
    for (const value of [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: tool ? "tool_calls" : "stop" }
    ])
      response.write(
        `data: ${JSON.stringify({
          id: "g3",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, ...value }]
        })}\n\n`
      )
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    response.writeHead(500).end("fixture rejected")
  }
})
async function poll<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  label: string
): Promise<T> {
  for (let index = 0; index < 320; index++) {
    const value = await read()
    if (ready(value)) return value
    await new Promise((done) => setTimeout(done, 250))
  }
  throw Error(`Timed out: ${label}`)
}
async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => void app?.close(), 300_000)
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture)()
    app
      .process()
      .stdout?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
    app
      .process()
      .stderr?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
    page = await app.firstWindow({ timeout: 60_000 })
    page.setDefaultTimeout(30_000)
    await page.waitForFunction(() => Boolean(window.api?.mods))
    await app.evaluate(
      ({ dialog }, expected) => {
        const originalDialog = dialog.showMessageBox.bind(dialog)
        dialog.showMessageBox = (async (...args: unknown[]) => {
          const options = args.at(-1) as { title?: string; message?: string; detail?: string }
          if (options.title !== "批准插件操作") return Reflect.apply(originalDialog, dialog, args)
          const offset = options.detail?.indexOf("{") ?? -1
          const request = offset >= 0 ? JSON.parse(options.detail!.slice(offset)) : {}
          const allowed =
            options.message?.includes("development:") &&
            options.message.includes("write_file") &&
            String(request.file_path ?? request.filePath)
              .replace(/\\/g, "/")
              .toLowerCase() === expected.output.replace(/\\/g, "/").toLowerCase() &&
            request.content === expected.written &&
            Object.keys(request).length === 2 &&
            Object.keys(request).every((key) => ["file_path", "filePath", "content"].includes(key))
          ;(
            globalThis as typeof globalThis & { g3NativeApprovals?: unknown[] }
          ).g3NativeApprovals ??= []
          ;(
            globalThis as typeof globalThis & { g3NativeApprovals: unknown[] }
          ).g3NativeApprovals.push({ allowed: Boolean(allowed), request })
          console.log(
            "[G3 isolated native approval]",
            JSON.stringify({ allowed: Boolean(allowed), request })
          )
          return { response: allowed ? 1 : 0, checkboxChecked: false }
        }) as typeof dialog.showMessageBox
      },
      { output, written }
    )
    const scope = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "g3-loopback",
          name: "G3 local author model",
          baseUrl: url,
          model: "g3-loopback",
          apiKey: "local-fixture",
          maxTokens: 32000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:g3-loopback")
        const thread = await window.api.threads.create({
          title: "G3 真实作者闭环",
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        await window.api.mods.configureGlobal(true)
        const current = await window.api.mods.status(thread.thread_id)
        await window.api.mods.configure(thread.thread_id, true, true, current.workspace)
        const scope = { threadId: thread.thread_id, expectedWorkspace: current.workspace }
        await window.api.mods.development.setEnabled({ ...scope, enabled: true })
        return scope
      },
      { workspace: fixture.workspace, url: `http://127.0.0.1:${address.port}/v1` }
    )
    await page.reload()
    await page.getByText("G3 真实作者闭环", { exact: true }).first().click()
    const status = () =>
      page!.evaluate((input) => window.api.mods.development.status(input), {
        threadId: scope.threadId
      })
    const trial = async () => (await status()).trials[0]
    const send = async (revision: number) => {
      await page!
        .locator("textarea.composer-textarea")
        .fill(`G3_R${revision} 制作并请求试用当前版本，不自动批准，不自动执行动作。`)
      await page!.getByRole("button", { name: "发送消息", exact: true }).click()
    }
    const record = async (label: string) => {
      const current = await status()
      observations.push({ label, status: current, files: readFiles() })
      return current.trials[0]
    }
    const consent = async (row: DevelopmentTrialStatus) => {
      await page!.getByText(/需授权的真实试用/).waitFor()
      const button = page!.getByRole("button", { name: "确认并应用到这段聊天", exact: true })
      assert(await button.isEnabled())
      assert.equal(await page!.getByRole("checkbox").count(), 0)
      await button.click()
      await page!.keyboard.press("Escape")
      observations.push({
        label: "exact-user-consent",
        revision: row.revision,
        bundleDigest: row.bundleDigest,
        compiledDigest: row.compiledDigest,
        target: scope,
        files: readFiles()
      })
    }
    const run = async (text = "") => {
      const descriptor = await poll(async () => {
        try {
          return await page!.evaluate(async threadId =>
            (await window.api.mods.commands(threadId)).find(row => row.command === "g3-file"), scope.threadId)
        } catch (error) {
          if (String(error).includes("MODS_RUNTIME_SESSION_BUSY")) return undefined
          throw error
        }
      }, Boolean, "native command available after lifecycle settlement")
      assert(descriptor, "G3 native command missing")
      const job = await page!.evaluate(
        async ({ threadId, text, descriptor }) => {
          return window.api.mods.enqueue(threadId, descriptor, { text })
        },
        { ...scope, text, descriptor }
      )
      return poll(
        async () => {
          const allow = page!.getByRole("button", { name: "允许", exact: true })
          if ((await allow.count()) && (await allow.first().isVisible())) {
            permissions++
            await allow.first().click()
          }
          return page!.evaluate(
            async ({ threadId, jobId }) =>
              (await window.api.mods.jobs(threadId)).find((row) => row.id === jobId),
            { threadId: scope.threadId, jobId: job.id }
          )
        },
        (result) => {
          assert(
            !["failed", "unknown", "cancelled"].includes(result?.state ?? ""),
            JSON.stringify(result)
          )
          return result?.state === "succeeded"
        },
        "real SDK file action"
      )
    }
    await send(1)
    await poll(async () => held, Boolean, "creator physically held")
    const first = await poll(
      trial,
      (row) => row?.phase === "needs-approval",
      "real consent required"
    )
    assert.equal(first.validation, "authorized-real")
    assert(first.capabilities.includes("fs.read"))
    assertFiles(null)
    await assert.rejects(
      page.evaluate((input) => window.api.mods.development.approve(input), {
        ...scope,
        id: first.componentId,
        revision: first.revision,
        digest: first.compiledDigest,
        sourceDigest: "f".repeat(64)
      }),
      /DEVELOPMENT_APPROVAL_SOURCE_REQUIRED/
    )
    await consent(first)
    await poll(trial, (row) => row?.phase === "queued", "exact consent queues held creator turn")
    assertFiles(null)
    release!()
    await poll(trial, (row) => row?.phase === "active", "real trial activation")
    const read = await run()
    assert(JSON.stringify(read?.result).includes(original.trim()), JSON.stringify(read))
    assertFiles(null)
    await record("actual-read-confirmed")
    await send(2)
    await page.getByText("G3_READY_2", { exact: true }).waitFor({ timeout: 90_000 })
    const second = await poll(
      trial,
      (row) => row?.revision === 2 && row.phase === "needs-approval",
      "new permission"
    )
    assert.equal(second.activeRevision, 1)
    assert.deepEqual(second.addedCapabilities, ["fs.write"])
    assertFiles(null)
    await run()
    assertFiles(null, "old usable version reads the input and cannot create the output")
    await consent(second)
    await poll(
      trial,
      (row) => row.activeRevision === 2 && row.phase === "active",
      "upgrade activation"
    )
    assertFiles(null, "activation never executes the action")
    const write = await run()
    assertFiles(written)
    assert(JSON.stringify(write?.result).includes(written.trim()))
    const nativeApprovals = await app.evaluate(
      () =>
        (globalThis as typeof globalThis & { g3NativeApprovals?: Array<{ allowed: boolean }> })
          .g3NativeApprovals
    )
    assert(
      nativeApprovals?.length && nativeApprovals.every((row) => row.allowed),
      "Exact native file approvals are required"
    )
    observations.push({ label: "native-operation-approvals", nativeApprovals })
    await record("actual-write-and-readback-confirmed")
    await run("timer")
    await poll(
      trial,
      (row) => (row.diagnostics?.backgroundResources ?? 0) > 0,
      "native timer ownership observed"
    )
    await poll(
      () => run("ticks"),
      (value) => /TICKS:[1-9]/.test(JSON.stringify(value?.result)),
      "actual guest timer callback"
    )
    await record("actual-timer-owned-and-ticking")
    await send(3)
    await page.getByText("G3_READY_3", { exact: true }).waitFor({ timeout: 90_000 })
    const failed = await poll(
      trial,
      (row) => row?.revision === 3 && row.phase === "failed",
      "failed upgrade"
    )
    assert.equal(failed.activeRevision, 2)
    assert(
      (failed.diagnostics?.backgroundResources ?? 0) > 0,
      "failed candidate must preserve the old working resource"
    )
    assertFiles(written)
    await record("failed-upgrade-keeps-usable-version")
    await send(4)
    await page.getByText("G3_READY_4", { exact: true }).waitFor({ timeout: 90_000 })
    await poll(
      trial,
      (row) => row?.activeRevision === 4 && row.phase === "active",
      "explicit source recovery"
    )
    assertFiles(written, "recovery never replays the prior output creation")
    const recoveredRead = await run()
    assert(JSON.stringify(recoveredRead?.result).includes(written.trim()))
    assertFiles(written, "the recovered version only reads the existing output")
    assert.equal(
      (await trial()).diagnostics?.backgroundResources,
      0,
      "successful replacement must retire the old timer"
    )
    assert(
      JSON.stringify((await run("ticks"))?.result).includes("TICKS:0"),
      "old callbacks cannot update the new version"
    )
    await record("recovered-read-only-version")
    await run("timer")
    await poll(
      trial,
      (row) => (row.diagnostics?.backgroundResources ?? 0) > 0,
      "new timer before explicit stop"
    )
    const stopped = await page.evaluate((input) => window.api.mods.development.stop(input), {
      ...scope,
      id: first.componentId
    })
    assert.equal(stopped.trials[0].phase, "stopped")
    assert(
      !(await page.evaluate((id) => window.api.mods.commands(id), scope.threadId)).some((row) =>
        row.modId.startsWith("development:")
      )
    )
    assertFiles(written, "stopping the trial preserves the input and output")
    await record("stopped-and-native-command-detached")
    const formal = await page.evaluate(
      async (input) => {
        const document = await window.api.mods.development.promote(input)
        const prepared = await window.api.mods.authoringInstall.prepare({
          threadId: input.threadId,
          expectedWorkspace: input.expectedWorkspace,
          requestId: crypto.randomUUID(),
          draftId: document.id,
          revision: document.currentRevision,
          sourceDigest: document.source.digest
        })
        if (!prepared.ok) throw Error(prepared.code)
        const installed = await window.api.mods.authoringInstall.apply({
          threadId: input.threadId,
          expectedWorkspace: input.expectedWorkspace,
          handle: prepared.value.handle,
          expectedCatalogDigest: prepared.value.catalogDigest
        })
        if (!installed.ok || installed.value.state !== "settled")
          throw Error("Formal installation not settled")
        const before = await window.api.mods.clawView(input.threadId)
        if (
          before.capabilities.find((row) => row.pluginId === prepared.value.installationId)
            ?.state !== "needs-approval"
        )
          throw Error("Trial consent must not become a formal grant")
        await window.api.mods.approveFunction(
          input.threadId,
          prepared.value.installationId,
          prepared.value.compiledDigest,
          input.expectedWorkspace
        )
        const view = await window.api.mods.clawView(input.threadId)
        const mod = view.capabilities.find((row) => row.pluginId === prepared.value.installationId)
        if (!mod || mod.state !== "ready") throw Error("Formal plugin not approved")
        const profile = {
          id: "g3-formal",
          name: "真实文件正式使用",
          capabilities: [
            ...(view.active?.capabilities ?? []),
            { pluginId: mod.pluginId, name: mod.name, digest: mod.digest! }
          ]
        }
        const saved = await window.api.mods.clawChange(input.threadId, {
          kind: "save",
          workspace: view.workspace,
          revision: view.revision,
          profile
        })
        await window.api.mods.clawChange(input.threadId, {
          kind: "apply",
          workspace: view.workspace,
          revision: saved.revision,
          bindingRevision: view.bindingRevision,
          id: profile.id
        })
        return { prepared: prepared.value, profile }
      },
      { ...scope, id: first.componentId, revision: 4 }
    )
    observations.push({
      label: "formal-version-separately-installed-approved-and-applied",
      formal,
      files: readFiles()
    })
    assert(formal.prepared.review, "Formal installation must expose the native prepared review")
    assert(formal.prepared.review.sdkMethods.includes("fs.read"))
    assert(
      !formal.prepared.review.sdkMethods.includes("fs.write"),
      "Restored read-only source cannot silently retain the previous write capability"
    )
    const formalRead = await run()
    assert(JSON.stringify(formalRead?.result).includes(written.trim()))
    assertFiles(written)
    await record("formal-version-actual-read-confirmed")
    const requestsBeforeRestart = requests.length
    await app.close()
    app = await createHeadlessProjectCompositionLaunch(root, fixture)()
    app
      .process()
      .stdout?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
    app
      .process()
      .stderr?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
    page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForFunction(() => Boolean(window.api?.mods))
    const restarted = await status()
    assert.equal(restarted.enabled, false, "restart cannot restore creator approval")
    assert.equal(restarted.trials[0]?.phase, "stopped")
    assertFiles(written, "restart preserves the input and previously created output")
    assert(
      !(await page.evaluate((id) => window.api.mods.commands(id), scope.threadId)).some((row) =>
        row.modId.startsWith("development:")
      )
    )
    assert.equal(requests.length, requestsBeforeRestart, "restart cannot replay a model/action")
    await record("restart-retains-observation-without-authority-or-replay")
    assert.equal(errors.length, 0, errors.join("\n"))
    passed = true
    console.log(
      `PASS G3 real authoring consent→read/write→upgrade→recovery→stop→restart: ${fixture.isolated}`
    )
  } catch (error) {
    errors.push(String(error))
    if (page)
      writeFileSync(
        join(fixture.isolated, "failure.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => "unavailable")
      )
    throw error
  } finally {
    release?.()
    clearTimeout(watchdog)
    await app?.close()
    await new Promise<void>((done) => server.close(() => done()))
    writeFileSync(
      join(fixture.isolated, "g3-acceptance.json"),
      JSON.stringify(
        {
          passed,
          candidate,
          input,
          output,
          files: readFiles(),
          permissions,
          observations,
          requests,
          errors,
          scope:
            "Real application IPC/creator/QuickJS/SDK/native file permissions, loopback fixed model; no business quality claim"
        },
        null,
        2
      )
    )
    assert.deepEqual(
      projectCompositionCandidate(root),
      candidate,
      "Candidate changed during acceptance"
    )
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
