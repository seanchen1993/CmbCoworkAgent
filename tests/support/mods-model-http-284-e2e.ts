import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import type { Socket } from "node:net"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"

/** Production ZIP → IPC → QuickJS → approved host/provider HTTP; no model host stubs. */
export async function verifyModelHttp284(
  app: ElectronApplication,
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const requests: Array<Record<string, unknown>> = []
  const httpRequests: Array<{ path: string; encoding?: string }> = []
  const sockets = new Set<Socket>()
  let stalled = 0
  let closedStalled = 0
  let markFirstStall = () => {}
  const firstStall = new Promise<void>((resolve) => {
    markFirstStall = resolve
  })
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      httpRequests.push({ path: req.url!, encoding: req.headers["accept-encoding"] })
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/compressed", "content-encoding": "unknown" })
        res.end("redirect body is not an entity to decode")
      } else {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" })
        res.end(gzipSync("HTTP_284 中文😀 sk-http-fixture-secret-123456789"))
      }
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    requests.push(body)
    const prompt = JSON.stringify(body.messages)
    if (prompt.includes("[284-cancel-stall]") || prompt.includes("[284-parent-")) {
      stalled++
      res.once("close", () => {
        closedStalled++
      })
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.flushHeaders()
      markFirstStall()
      return
    }
    if (prompt.includes("[284-cancel-sibling]")) await firstStall
    if (prompt.includes("[284-error]")) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: {
            message: "DO_NOT_LEAK_PROVIDER_284 sk-provider-fixture-secret-123456789",
            type: "invalid_request_error"
          }
        })
      )
      return
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const frame = (choices: unknown[], usage?: unknown) =>
      res.write(
        `data: ${JSON.stringify({
          id: `model-284-${requests.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4",
          choices,
          ...(usage ? { usage } : {})
        })}\n\n`
      )
    frame([
      {
        index: 0,
        delta: { role: "assistant", content: prompt.includes("[284-empty]") ? "" : "MODEL_284_OK" },
        finish_reason: "stop"
      }
    ])
    frame([], {
      prompt_tokens: 20,
      completion_tokens: 3,
      total_tokens: 23,
      prompt_tokens_details: { cached_tokens: 5 }
    })
    res.end("data: [DONE]\n\n")
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const project = join(workspace, "model-http-284")
  mkdirSync(project)
  const evidence: Record<string, unknown> = { base, requests, httpRequests }
  let dialogPatched = false
  try {
    const threadId = await page.evaluate(
      async ({ project, base }) => {
        await window.api.models.setCustomConfig({
          id: "model-http-284",
          name: "Model HTTP 284 fixture",
          baseUrl: base + "/v1",
          model: "gpt-4",
          apiKey: "local-fixture-key",
          maxTokens: 32000,
          maxOutputTokens: 512
        })
        await window.api.models.setDefault("custom:model-http-284")
        const thread = await window.api.threads.create({
          title: "Model HTTP 284 E2E",
          workspacePath: project,
          agentMode: "normal"
        })
        const id =
          (thread as unknown as { thread_id?: string; id: string }).thread_id ??
          (thread as unknown as { id: string }).id
        await window.api.workspace.set(id, project)
        await window.api.threads.patchMetadata(id, {
          set: { model: "custom:model-http-284", subagentsEnabled: false }
        })
        await window.api.mods.configure(id, true, true)
        return id
      },
      { project, base }
    )
    const install = async (name: string, resultProtocol: boolean, source: string) => {
      const zip = new AdmZip()
      zip.addFile(
        "plugin.json",
        Buffer.from(
          JSON.stringify({
            name,
            version: "1.0.0",
            ...(resultProtocol ? { cmbCompatibility: { modelProtocol: "result-v1" } } : {})
          })
        )
      )
      zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
      zip.addFile("hooks/register.ts", Buffer.from(source))
      const result = await page.evaluate(
        ({ bytes, name }) =>
          window.api.plugins.install(new Uint8Array(bytes).buffer, name + ".zip", "local"),
        { bytes: [...zip.toBuffer()], name }
      )
      assert(result.success, result.error)
      const mod = (
        await page.evaluate((id) => window.api.mods.status(id), threadId)
      ).functionMods!.find((row) => row.name === name)!
      assert(mod?.digest, `Missing installed source ${name}`)
      await page.evaluate(
        ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
        { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
      )
      return mod
    }
    await install(
      "model-result-284",
      true,
      `export function register(on){
      on("session.start",async($,e,next)=>{await $.command.register({name:"result-284",description:"Real 284 model and HTTP"});return next(e)});
      on("command.run",{command:"result-284"},async($,e)=>{
        try {
          let value;
          if(e.args==="pre-cancel")value=await $.model.complete({model:"default",prompt:"NEVER_SEND_PRE_CANCEL"},{signal:AbortSignal.abort()});
          else if(e.args==="cancel"){
            const stop=new AbortController();
            const first=$.model.complete({model:"default",prompt:"[284-cancel-stall]",maxTokens:32},{signal:stop.signal});
            const sibling=await $.model.complete({model:"default",prompt:"[284-cancel-sibling]",maxTokens:32});
            stop.abort();value={cancelled:await first,sibling,session:await $.session.id()};
          }
          else if(e.args==="parent-cancel")value=await Promise.all([
            $.model.complete({model:"default",prompt:"[284-parent-a]",maxTokens:32}),
            $.model.complete({model:"default",prompt:"[284-parent-b]",maxTokens:32})]);
          else if(e.args==="fork")value=await $.model.fork({prompt:"[284-fork]"});
          else if(e.args==="http")value=await $.http.fetch(${JSON.stringify(base + "/redirect")},{headers:{"Accept-Encoding":"identity"}});
          else value=await $.model.complete({model:"default",prompt:"[284-"+e.args+"]",maxTokens:32});
          return {text:"RESULT_284:"+JSON.stringify(value)}
        }catch(error){return {text:"RESULT_ERROR_284:"+(error.code||error.message)}}
      });
      on("http.fetch",async($,e,next)=>{
        const r=await next(e);
        if(r.value.text.includes("sk-http"))throw Error("UNPROTECTED_HTTP_284");
        return {...r,value:{...r.value,text:r.value.text+" AFTER_284"}}
      });
    }`
    )
    await install(
      "model-legacy-284",
      false,
      `export function register(on){
      on("session.start",async($,e,next)=>{await $.command.register({name:"legacy-284",description:"Original model string"});return next(e)});
      on("command.run",{command:"legacy-284"},async($)=>({text:"LEGACY_284:"+JSON.stringify(await $.model.complete({model:"default",prompt:"[284-legacy]",maxTokens:32}))}));
    }`
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Model HTTP 284 E2E", { exact: true }).first().click()
    await app.evaluate(({ dialog }, base) => {
      const state = globalThis as unknown as {
        model284OriginalDialog: typeof dialog.showMessageBox
        model284Approvals: string[]
      }
      state.model284OriginalDialog = dialog.showMessageBox
      state.model284Approvals = []
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const description = JSON.stringify(args.slice(1))
        state.model284Approvals.push(description)
        return {
          response: description.includes(base) && description.includes("批准插件网络请求") ? 1 : 0,
          checkboxChecked: false
        }
      }) as typeof dialog.showMessageBox
    }, base)
    dialogPatched = true
    const jobs = () => page.evaluate((id) => window.api.mods.jobs(id), threadId)
    const command = async (name: string, args = "") => {
      const before = new Set((await jobs()).map((job) => job.id))
      const composer = page.locator("textarea.composer-textarea")
      await composer.fill(`/${name} ${args}`.trim())
      await page.locator("form").filter({ has: composer }).locator('button[type="submit"]').click()
      await until(
        async () =>
          (await jobs()).some(
            (job) => !before.has(job.id) && !["running", "queued"].includes(job.state)
          ),
        `284 command ${name} ${args}`
      )
      const job = (await jobs()).find((job) => !before.has(job.id))!
      return job.result?.text ?? job.error ?? JSON.stringify(job)
    }
    const result = async (args: string) => {
      const text = await command("result-284", args)
      assert(text.startsWith("RESULT_284:"), text)
      return JSON.parse(text.slice("RESULT_284:".length))
    }
    evidence.fork = await result("fork")
    assert.deepEqual(evidence.fork, { isAnswered: false, reason: "nothing-to-fork" })
    assert.equal(requests.length, 0)
    pass(
      "result-v1 cold fork returns nothing-to-fork through the real installed command with zero provider requests"
    )

    evidence.success = await result("success")
    assert.deepEqual(evidence.success, {
      isAnswered: true,
      text: "MODEL_284_OK",
      usage: {
        input_tokens: 15,
        output_tokens: 3,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 0
      }
    })
    assert.equal(requests.length, 1)
    pass(
      "result-v1 command reaches the real provider HTTP and returns text with all four normalized usage fields"
    )

    evidence.empty = await result("empty")
    assert.equal((evidence.empty as { reason: string }).reason, "empty-reply")
    assert.equal((evidence.empty as { isAnswered: boolean }).isAnswered, false)
    evidence.apiError = await result("error")
    assert.equal((evidence.apiError as { reason: string }).reason, "api-error")
    assert.equal((evidence.apiError as { status: number }).status, 400)
    assert.equal((evidence.apiError as { error: string }).error, "invalid_request")
    assert(!JSON.stringify(evidence.apiError).includes("DO_NOT_LEAK_PROVIDER_284"))
    pass(
      "actual empty and HTTP 400 provider replies become distinct bounded results without leaking provider error text"
    )

    const legacy = await command("legacy-284", "normal")
    assert.equal(legacy, 'LEGACY_284:"MODEL_284_OK"')
    evidence.legacy = legacy
    pass("an unchanged legacy plugin installed alongside result-v1 still receives a string")

    const beforeHttp = requests.length
    evidence.http = await result("http")
    assert.equal((evidence.http as { text: string }).text, "HTTP_284 中文😀 [REDACTED] AFTER_284")
    assert.equal(requests.length, beforeHttp)
    assert.deepEqual(
      httpRequests.map((request) => request.path),
      ["/redirect", "/compressed"]
    )
    assert(httpRequests.every((request) => request.encoding === "gzip, deflate, br"))
    evidence.approvals = await app.evaluate(
      () => (globalThis as unknown as { model284Approvals: string[] }).model284Approvals
    )
    assert.equal((evidence.approvals as string[]).length, 2)
    pass(
      "real plugin HTTP follows separately approved redirects, decodes gzip and protects secrets before its after-hook"
    )
    const beforeCancel = requests.length
    evidence.preCancelled = await result("pre-cancel")
    assert.equal((evidence.preCancelled as { reason: string }).reason, "aborted")
    assert.equal(requests.length, beforeCancel)
    evidence.independentCancel = await result("cancel")
    const cancelled = evidence.independentCancel as {
      cancelled: { reason: string }
      sibling: { isAnswered: boolean; text: string }
      session: string
    }
    assert.equal(cancelled.cancelled.reason, "aborted")
    assert.equal(cancelled.sibling.isAnswered, true)
    assert.equal(cancelled.sibling.text, "MODEL_284_OK")
    assert.equal(cancelled.session, threadId)
    assert.equal(requests.length, beforeCancel + 2)
    await until(
      async () => closedStalled === 1,
      "independent model HTTP closes after utility cancel"
    )
    const cancellationAudit = await page.evaluate((id) => window.api.mods.audit(id), threadId)
    assert(
      cancellationAudit.some(
        (row) =>
          row.toolId === "model.complete" &&
          row.status === "unknown" &&
          row.publication === "blocked"
      )
    )
    evidence.cancellationAudit = cancellationAudit
    pass(
      "installed result-v1 independent cancel crosses utility IPC, closes only its HTTP request and preserves unknown accounting"
    )

    const beforeParent = new Set((await jobs()).map((job) => job.id))
    const composer = page.locator("textarea.composer-textarea")
    await composer.fill("/result-284 parent-cancel")
    await page.locator("form").filter({ has: composer }).locator('button[type="submit"]').click()
    await until(async () => stalled === 3, "both parent-owned model HTTP requests started")
    const parentJob = (await jobs()).find((job) => !beforeParent.has(job.id))!
    await page.evaluate(({ id, job }) => window.api.mods.cancelJob(id, job), {
      id: threadId,
      job: parentJob.id
    })
    await until(async () => closedStalled === 3, "parent cancel closes both HTTP requests")
    await until(
      async () =>
        (await jobs()).some(
          (job) =>
            job.id === parentJob.id &&
            job.state === "unknown" &&
            job.error === "MODS_CANCELLED" &&
            typeof job.finishedAt === "number" &&
            job.result === undefined
        ),
      "cancelled running parent settles without claiming external effects were rolled back"
    )
    evidence.cancelledParent = (await jobs()).find((job) => job.id === parentJob.id)
    evidence.afterCancel = await result("success")
    assert.equal((evidence.afterCancel as { isAnswered: boolean }).isAnswered, true)
    pass(
      "parent cancellation closes all utility model requests without publishing late results; a subsequent request still succeeds"
    )
    await page.screenshot({ path: join(artifacts, "model-http-284-results.png") })

    await install(
      "model-conflict-284",
      false,
      `export function register(on){
      on("model.complete",{prompt:"NEVER_MATCH_THIS_284"},async($,e,next)=>{await $.ui.log("CONFLICT_284_HANDLER_RAN");return next(e)});
    }`
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Model HTTP 284 E2E", { exact: true }).first().click()
    const beforeConflict = requests.length
    evidence.conflict = await command("result-284", "conflict")
    assert.match(
      String(evidence.conflict),
      /MODS_MODEL_PROTOCOL_CONFLICT|conflicts with model-conflict-284/
    )
    assert.equal(requests.length, beforeConflict)
    const logs = await page.evaluate((id) => window.api.mods.logs(id), threadId)
    assert(!logs.some((row) => row.text === "CONFLICT_284_HANDLER_RAN"))
    pass(
      "mixed-protocol observer conflict is rejected before its false matcher/handler and before any provider request"
    )
    evidence.audit = await page.evaluate((id) => window.api.mods.audit(id), threadId)
    await page.screenshot({ path: join(artifacts, "model-http-284-conflict.png") })
  } finally {
    writeFileSync(
      join(artifacts, "model-http-284-evidence.json"),
      JSON.stringify(evidence, null, 2)
    )
    if (dialogPatched)
      await app
        .evaluate(({ dialog }) => {
          dialog.showMessageBox = (
            globalThis as unknown as { model284OriginalDialog: typeof dialog.showMessageBox }
          ).model284OriginalDialog
        })
        .catch(() => {})
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
