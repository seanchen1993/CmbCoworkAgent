import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"

interface DialogProbe {
  allow: boolean
  requests: Array<{ title?: string; detail?: string }>
  original: unknown
}

/** Real main-process HTTP/argv transport, utilityProcess guest and production approval boundary. */
export async function verifyResources(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  app: ElectronApplication
): Promise<void> {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? "")
    response.setHeader("content-type", "text/plain")
    response.end("REAL_HTTP_RESOURCE")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  let longPid: number | undefined
  let childReaped = false
  try {
    const executable = await app.evaluate(({ dialog }) => {
      const original = dialog.showMessageBox
      const probe: DialogProbe = {
        allow: true,
        requests: [],
        original
      }
      ;(
        globalThis as typeof globalThis & { __modsResourceDialogs: DialogProbe }
      ).__modsResourceDialogs = probe
      const debug = console.debug
      const diagnostics: string[] = []
      ;(
        globalThis as typeof globalThis & {
          __modsTimerDiagnostics: { original: typeof console.debug; messages: string[] }
        }
      ).__modsTimerDiagnostics = { original: debug, messages: diagnostics }
      console.debug = (...args) => {
        if (args[0] === "[Mods] module-resources: MODS_TIMER_FAILED") diagnostics.push(args[0])
        debug(...args)
      }
      dialog.showMessageBox = (async (_owner, options) => {
        probe.requests.push({ title: options.title, detail: options.detail })
        return { response: probe.allow ? 1 : 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      return process.execPath
    })
    const project = join(workspace, "module-resources")
    mkdirSync(project, { recursive: true })
    const id = await page.evaluate(async (project) => {
      const thread = await window.api.threads.create({
        title: "Module Resources",
        workspacePath: project,
        agentMode: "normal"
      })
      const id =
        (thread as unknown as { thread_id: string }).thread_id ??
        (thread as unknown as { id: string }).id
      await window.api.workspace.set(id, project)
      await window.api.mods.configure(id, true, true)
      return id
    }, project)
    const argv = (source: string) => JSON.stringify([executable, "-e", source])
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(JSON.stringify({ name: "module-resources", version: "1.0.0" }))
    )
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
    zip.addFile(
      "hooks/register.ts",
      Buffer.from(`export function register(on) {
      on("session.start",async($,e,next)=>{for(const name of ["resources-http","resources-run","resources-background","resources-long","resources-timer","resources-timer-recovery","resources-stream-budget"])
        await $.command.register({name,description:name,immediate:true});return next(e)});
      on("process.spawn",async function*($,e,next){
        const stream=next(e);for await(const chunk of stream){
          $.ui.log("PROCESS_BUDGET:"+JSON.stringify({ms:next.budget.ms,left:next.budget.remainingMs}));yield chunk;
        }return await stream.result;
      });
      on("http.fetch",($,e,next)=>next({...e,url:e.url+"?rewritten=1"}));
      on("command.run",{command:"resources-http"},async $=>({text:(await $.http.fetch(${JSON.stringify(url)})).text}));
      on("command.run",{command:"resources-run"},async $=>({text:JSON.stringify(await $.process.run(${argv("process.stdout.write('REAL_ARGV_RESOURCE');process.exitCode=7")},{env:{ELECTRON_RUN_AS_NODE:"1"}}))}));
      on("command.run",{command:"resources-stream-budget"},async $=>{
        const stream=$.process.spawn({argv:${argv("process.stdout.write('PIECE_FIRST');setTimeout(()=>process.stdout.write('PIECE_AFTER_WAIT'),11200)")},env:{ELECTRON_RUN_AS_NODE:"1"}});
        let text="";for await(const chunk of stream)text+=chunk.text;
        return {text:text+":"+(await stream.result).code};
      });
      on("command.run",{command:"resources-background"},$=>{
        const stream=$.process.spawn({argv:${argv("setTimeout(()=>process.stdout.write('BACKGROUND_AFTER_RETURN'),250)")},env:{ELECTRON_RUN_AS_NODE:"1"}});
        (async()=>{for await(const chunk of stream)$.ui.log(chunk.text);$.ui.log("RESOURCE_EXIT_"+(await stream.result).code)})().catch(e=>$.ui.log("RESOURCE_ERROR_"+e.message));
        return {text:"creator-returned"};
      });
      on("command.run",{command:"resources-long"},$=>{
        const stream=$.process.spawn({argv:${argv("console.log('RESOURCE_PID_'+process.pid);setInterval(()=>{},1000)")},env:{ELECTRON_RUN_AS_NODE:"1"}});
        (async()=>{for await(const chunk of stream)$.ui.log(chunk.text)})().catch(()=>{});return {text:"long-started"};
      });
      on("command.run",{command:"resources-timer"},$=>{
        $.clock.after(80,()=>$.ui.log("AFTER_CREATOR_RETURN"));let n=0;
        const timer=$.clock.every(30,()=>{n++;$.ui.log("EVERY_"+n);if(n===3)timer.cancel()});
        return {text:"timers-started"};
      });
      on("command.run",{command:"resources-timer-recovery"},$=>{
        let n=0;const timer=$.clock.every(60,async()=>{
          n++;if(n===1){await $.clock.sleep(5);throw new Error("PRIVATE_TIMER_FAILURE")}
          $.ui.log("RECOVERED_PERIOD_"+n);if(n===3)timer.cancel()
        });return {text:"recovery-started"};
      });
    }`)
    )
    const installed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "module-resources.zip", "local"),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
      (row) => row.name === "module-resources"
    )!
    assert(mod?.digest)
    await page.evaluate(
      ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id, pluginId: mod.pluginId, digest: mod.digest! }
    )
    const run = async (command: string, success = true) => {
      const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), id)).find(
        (row) => row.command === command
      )!
      assert(descriptor)
      const job = await page.evaluate(
        ({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "" }),
        { id, descriptor }
      )
      await until(
        async () =>
          (await page.evaluate((id) => window.api.mods.jobs(id), id)).some(
            (row) =>
              row.id === job.id &&
              ["succeeded", "failed", "cancelled", "interrupted"].includes(row.state)
          ),
        command
      )
      const result = (await page.evaluate((id) => window.api.mods.jobs(id), id)).find(
        (row) => row.id === job.id
      )!
      if (success) assert.equal(result.state, "succeeded", JSON.stringify(result))
      else assert.equal(result.state, "failed", JSON.stringify(result))
      return result
    }
    const logs = async () =>
      (await page.evaluate((id) => window.api.mods.logs(id), id)).map((row) => row.text)
    assert.equal((await run("resources-http")).result!.text, "REAL_HTTP_RESOURCE")
    assert.deepEqual(requests, ["/?rewritten=1"])
    assert.deepEqual(JSON.parse((await run("resources-run")).result!.text), {
      exitCode: 7,
      stdout: "REAL_ARGV_RESOURCE",
      stderr: ""
    })
    pass("real HTTP final hook URL is approved and native argv preserves nonzero exit/output")
    const streamJob = await run("resources-stream-budget")
    writeFileSync(
      join(artifacts, "process-budget-diagnostics.json"),
      JSON.stringify(
        {
          streamJob,
          logs: await logs(),
          audit: await page.evaluate((id) => window.api.mods.audit(id), id)
        },
        null,
        2
      )
    )
    assert.equal(streamJob.result!.text, "PIECE_FIRSTPIECE_AFTER_WAIT:0")
    const budgets = (await logs())
      .filter((text) => text.startsWith("PROCESS_BUDGET:"))
      .map((text) => JSON.parse(text.slice("PROCESS_BUDGET:".length)))
    assert(budgets.length >= 2)
    assert(
      budgets.every((row) => row.ms === 10000 && row.left > 7000),
      JSON.stringify(budgets)
    )
    pass(
      "Actual native process pieces use fresh own clocks and retain a wait longer than ten seconds"
    )
    assert.equal((await run("resources-background")).result!.text, "creator-returned")
    await until(
      async () => (await logs()).includes("RESOURCE_EXIT_0"),
      "background stream after command return"
    )
    assert((await logs()).includes("BACKGROUND_AFTER_RETURN"))
    await until(
      async () =>
        (await page.evaluate((id) => window.api.mods.audit(id), id)).some(
          (row) =>
            row.toolId === "process.spawn" &&
            row.status === "succeeded" &&
            row.publication === "published"
        ),
      "spawn final audit publication"
    )
    pass(
      "module-owned process survives creator return and publishes chunks/result with succeeded audit"
    )
    await run("resources-timer")
    await until(
      async () =>
        (await logs()).includes("AFTER_CREATOR_RETURN") && (await logs()).includes("EVERY_3"),
      "after/every callbacks"
    )
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal((await logs()).filter((text) => text.startsWith("EVERY_")).length, 3)
    pass("after/every survive creator return and explicit cancel stops further ticks")
    await run("resources-timer-recovery")
    await until(async () => (await logs()).includes("RECOVERED_PERIOD_3"), "callback recovery")
    await new Promise((resolve) => setTimeout(resolve, 240))
    const recovered = (await logs()).filter((text) => text.startsWith("RECOVERED_PERIOD_"))
    assert.deepEqual(recovered, ["RECOVERED_PERIOD_2", "RECOVERED_PERIOD_3"])
    const diagnostics = await app.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __modsTimerDiagnostics: { messages: string[] }
          }
        ).__modsTimerDiagnostics.messages
    )
    assert.deepEqual(diagnostics, ["[Mods] module-resources: MODS_TIMER_FAILED"])
    writeFileSync(
      join(artifacts, "timer-recovery-evidence.json"),
      JSON.stringify(
        {
          recovered,
          diagnostics,
          scope:
            "Actual async callback rejects once; real module channel then resumes, cancels and logs one fixed diagnostic"
        },
        null,
        2
      )
    )
    await page.screenshot({ path: join(artifacts, "timer-recovered.png") })
    pass(
      "ordinary asynchronous interval failure logs once, resumes future periods and remains cancellable"
    )
    await app.evaluate(() => {
      ;(
        globalThis as typeof globalThis & { __modsResourceDialogs: DialogProbe }
      ).__modsResourceDialogs.allow = false
    })
    await run("resources-http", false)
    assert.equal(requests.length, 1)
    await app.evaluate(() => {
      ;(
        globalThis as typeof globalThis & { __modsResourceDialogs: DialogProbe }
      ).__modsResourceDialogs.allow = true
    })
    pass("denied native network approval performs no request")
    await run("resources-long")
    await until(
      async () => (await logs()).some((text) => text.startsWith("RESOURCE_PID_")),
      "long child PID"
    )
    longPid = Number(
      (await logs())
        .find((text) => text.startsWith("RESOURCE_PID_"))!
        .slice("RESOURCE_PID_".length)
        .trim()
    )
    assert(longPid > 0)
    process.kill(longPid, 0)
    await page.evaluate((id) => window.api.mods.revokeFunction(id, "module-resources"), id)
    await until(async () => {
      try {
        process.kill(longPid!, 0)
        return false
      } catch {
        return true
      }
    }, "revocation reaps process tree")
    childReaped = true
    pass("durable plugin revocation closes module resources and kills the actual running child")
    const approvals = await app.evaluate(
      () =>
        (globalThis as typeof globalThis & { __modsResourceDialogs: DialogProbe })
          .__modsResourceDialogs.requests
    )
    assert(
      approvals.some(
        (row) => row.title === "批准插件网络请求" && row.detail?.includes("rewritten=1")
      )
    )
    assert(
      approvals.some(
        (row) =>
          row.title === "批准插件运行本机命令" && row.detail?.includes("ELECTRON_RUN_AS_NODE")
      )
    )
    writeFileSync(
      join(artifacts, "resources-evidence.json"),
      JSON.stringify({ requests, approvals, longPid }, null, 2)
    )
  } finally {
    await app
      .evaluate(({ dialog }) => {
        const probe = (globalThis as typeof globalThis & { __modsResourceDialogs?: DialogProbe })
          .__modsResourceDialogs
        if (probe) dialog.showMessageBox = probe.original as typeof dialog.showMessageBox
        const diagnostics = (
          globalThis as typeof globalThis & {
            __modsTimerDiagnostics?: { original: typeof console.debug }
          }
        ).__modsTimerDiagnostics
        if (diagnostics) console.debug = diagnostics.original
      })
      .catch(() => {
        /* A crashed app cannot restore its dialog; still close the local server. */
      })
    if (longPid && !childReaped)
      try {
        process.kill(longPid)
      } catch {
        /* Already reaped. */
      }
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
