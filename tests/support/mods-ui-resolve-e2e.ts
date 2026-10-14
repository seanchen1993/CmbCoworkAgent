import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { FUNCTION_HOST_REVISION, isModObject } from "../../src/shared/mods/v2/contracts"
import type { FunctionUiElement, FunctionUiNode } from "../../src/shared/mods/v2/ui"
import { openModsResults } from "./mods-sidebar-navigation"

/** Real ZIP/approval/utility transport/React and provider HTTP, without direct resolver stubs. */
export async function verifyUiResolve(
  app: ElectronApplication,
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  type Probe = Pick<typeof import("./mods-e2e-entry"),
    "observeUiResolveConfiguration" | "readUiResolveConfigurationFacts" |
    "stopUiResolveConfigurationObserver">
  type Facts = ReturnType<Probe["readUiResolveConfigurationFacts"]>
  assert.equal(FUNCTION_HOST_REVISION, "module-resources-v88")
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const labels: string[] = []
  const installed: Array<{ name: string; pluginId: string; digest: string }> = []
  const evidence: Record<string, unknown> = {
    expectedHostRevision: FUNCTION_HOST_REVISION,
    requests,
    installed,
    labels,
    complete: false
  }
  const record = (label: string) => {
    labels.push(label)
    pass(label)
  }
  let releaseDefault = () => {}
  const defaultGate = new Promise<void>((resolve) => {
    releaseDefault = resolve
  })
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST")
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body: Record<string, unknown> = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const path = req.url ?? ""
      requests.push({ path, body })
      const prompt = JSON.stringify(body.messages)
      const sdkDefault = prompt.includes("[ui-resolve-default]")
      const sdkExplicit = prompt.includes("[ui-resolve-explicit]")
      if (sdkDefault) await defaultGate
      const text = sdkDefault
        ? "UI_RESOLVE_DEFAULT_OK"
        : sdkExplicit
          ? "UI_RESOLVE_EXPLICIT_OK"
          : "UI_RESOLVE_CHAT_OK"
      res.writeHead(200, { "content-type": "text/event-stream" })
      const frame = (choices: unknown[], usage?: Record<string, unknown>) =>
        res.write(
          `data: ${JSON.stringify({
            id: `ui-resolve-${requests.length}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4",
            choices,
            ...(usage ? { usage } : {})
          })}\n\n`
        )
      frame([
        { index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }
      ])
      frame([], {
        prompt_tokens: 20,
        completion_tokens: 3,
        total_tokens: 23,
        prompt_tokens_details: { cached_tokens: 5 }
      })
      res.end("data: [DONE]\n\n")
    } catch (error) {
      evidence.providerError = String(error)
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" })
      res.end("Local UI resolve fixture failed")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}`
  evidence.base = base
  const project = join(workspace, "ui-resolve-project")
  mkdirSync(project, { recursive: true })
  let observerInstalled = false
  try {
    await app.evaluate((_, entry) => {
      const { createRequire } = process.getBuiltinModule("node:module")
      const probe = createRequire(entry)(entry) as Probe
      probe.observeUiResolveConfiguration()
      ;(globalThis as typeof globalThis & { __modsUiResolveProbe?: Probe })
        .__modsUiResolveProbe = probe
    }, fileURLToPath(new URL("../../out/main/mods-e2e.js", import.meta.url)))
    observerInstalled = true
    const id = await page.evaluate(
      async ({ project, base }) => {
        for (const route of ["default", "explicit"]) {
          await window.api.models.setCustomConfig({
            id: `ui-resolve-${route}`,
            name: `UI resolve ${route} fixture`,
            baseUrl: `${base}/${route}/v1`,
            model: "gpt-4",
            apiKey: "local-fixture-key",
            maxTokens: 32000,
            maxOutputTokens: 512
          })
        }
        await window.api.models.setDefault("custom:ui-resolve-default")
        const thread = await window.api.threads.create({
          title: "UI resolve E2E",
          workspacePath: project,
          agentMode: "normal"
        })
        const id = (thread as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, project)
        await window.api.threads.patchMetadata(id, {
          set: { model: "custom:ui-resolve-default", subagentsEnabled: false }
        })
        await window.api.mods.configure(id, true, true)
        return id
      },
      { project, base }
    )
    evidence.threadId = id
    const install = async (
      name: string,
      source: string,
      resultProtocol = false,
      userConfig?: Record<string, unknown>
    ) => {
      const zip = new AdmZip()
      zip.addFile(
        "plugin.json",
        Buffer.from(
          JSON.stringify({
            name,
            version: "1.0.0",
            ...(userConfig ? { userConfig } : {}),
            ...(resultProtocol ? { cmbCompatibility: { modelProtocol: "result-v1" } } : {})
          })
        )
      )
      zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
      zip.addFile("hooks/register.tsx", Buffer.from(source))
      const bytes = zip.toBuffer()
      writeFileSync(join(artifacts, `${name}.zip`), bytes)
      const result = await page.evaluate(
        ({ bytes, name }) =>
          window.api.plugins.install(new Uint8Array(bytes).buffer, `${name}.zip`, "local"),
        { bytes: [...bytes], name }
      )
      assert(result.success, result.error)
      const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
        (row) => row.name === name
      )
      assert(mod?.digest, `Installed source missing: ${name}`)
      await page.evaluate(
        ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
        { id, pluginId: mod.pluginId, digest: mod.digest }
      )
      const ready = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
        (row) => row.name === name
      )
      assert.equal(ready?.state, "ready", JSON.stringify(ready))
      installed.push({ name, pluginId: mod.pluginId, digest: mod.digest })
    }

    await install(
      "ui-resolve-q",
      `export function register(on) {
        let count=0;
        on("session.start",async($,e,next)=>{
          await $.command.register({name:"resolve-open",description:"Open original Q pane",immediate:true});
          await $.command.register({name:"resolve-close",description:"Close original Q pane",immediate:true});
          await $.command.register({name:"resolve-q-state",description:"Inspect actual Q namespace",immediate:true});
          return next(e)
        });
        on("command.run",{command:"resolve-open"},async($)=>{
          await $.ui.open({id:"resolve-pane",title:"Original Q controls"});return {}
        });
        on("command.run",{command:"resolve-close"},async($)=>{
          await $.ui.close({id:"resolve-pane"});return {}
        });
        on("command.run",{command:"resolve-q-state"},async($)=>({text:JSON.stringify({
          count,owner:await $.store.get("constructor-owner")??null,
          models:await $.store.get("constructor-models")??null
        })}));
        on("ui.render",{component:"PromptHint"},($,e,next)=>{
          $.ui.resolve(e);
          return next({...e,props:{...e.props,hint:"UI_RESOLVE_COLD_HINT"}})
        });
        on("ui.render",{component:"Pane",requestId:"resolve-pane"},($,e)=>{
          const {Text,Button}=$.ui.resolve(e);
          return h(Fragment,null,
            h(Text,null,"Q_BODY_"+count),
            h(Button,{key:"q-original",label:"Original Q action",onPress(){
              count++;$.ui.invalidate("ui.render")
            }}),
            <><Text>Q_FRAGMENT_A</Text><Text>Q_FRAGMENT_B</Text></>)
        })
      }`
    )
    await install(
      "ui-resolve-p",
      `export function register(on,options) {
        const tone=options.tone;
        const marker=Date.now().toString(36)+"-"+Math.random().toString(36).slice(2);
        let armed=false,held=false;
        on("session.start",async($,e,next)=>{
          await $.command.register({name:"resolve-p-state",description:"Inspect actual P namespace",immediate:true});
          await $.command.register({name:"resolve-arm",description:"Hold one real constructor continuation",immediate:true});
          return next(e)
        });
        on("command.run",{command:"resolve-arm"},($)=>{
          armed=true;$.ui.invalidate("ui.render");return {}
        });
        on("command.run",{command:"resolve-p-state"},async($)=>({text:JSON.stringify({
          marker,tone,armed,held,
          owner:await $.store.get("constructor-owner")??null,
          models:await $.store.get("constructor-models")??null,
          modelsMarker:await $.store.get("constructor-model-marker")??null,
          error:await $.store.get("constructor-error")??null,
          neverRevive:await $.store.get("never-revive")??null
        })}));
        on("ui.resolve",{component:/^Pane$/},async($,e,next)=>{
          const lower=await next(e);let started=false;
          return {...lower,
            Text:p=>{
              if(armed && !held && String(p.children).includes("Q_BODY_1")){
                held=true;
                void new Promise(()=>{}).then(()=>$.store.set("never-revive",marker))
              }
              if(!started && String(p.children).includes("Q_BODY_0")){
                started=true;
                void $.store.set("constructor-owner","P")
                  .then(()=>$.model.complete({model:"default",prompt:"[ui-resolve-default]",maxTokens:32}))
                  .then(first=>$.model.complete({model:"custom:ui-resolve-explicit",prompt:"[ui-resolve-explicit]",maxTokens:32})
                    .then(second=>$.store.set("constructor-models",{default:first,explicit:second})
                      .then(()=>$.store.set("constructor-model-marker",marker))))
                  .catch(error=>$.store.set("constructor-error",String(error.code||error.message)))
              }
              return lower.Text({...p,children:"P["+tone+":"+marker+":"+p.children+"]"})
            },
            Button:p=>lower.Box({flexDirection:"column",children:[
              lower.Button({...p,label:"Wrapped "+p.label})
            ]})
          }
        })
      }`,
      true,
      {
        tone: {
          type: "string",
          title: "Reply style",
          description: "The constructor style used by this actual plugin instance",
          default: "warm"
        }
      }
    )
    await install(
      "ui-resolve-r",
      `export function register(on) {
        on("ui.resolve",{component:/^Pane$/},async($,e,next)=>{
          const lower=await next(e);
          return {...lower,Text:p=>lower.Text({...p,children:"R["+p.children+"]"})}
        })
      }`
    )
    await install(
      "ui-resolve-false",
      `export function register(on) {
        on("ui.resolve",{component:/^NeverAnActualComponent$/},()=>{
          throw Error("FALSE_RESOLVER_MUST_NOT_RUN")
        });
        on("session.start",async($,e,next)=>{
          await $.command.register({name:"resolve-old-hook",description:"Original hook with all-false resolver",immediate:true});
          return next(e)
        });
        on("command.run",{command:"resolve-old-hook"},()=>({text:"OLD_HOOK_OK"}))
      }`
    )
    record("real Q/P/R and false-matcher ZIPs install and receive current v88 digest approval")

    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("UI resolve E2E", { exact: true }).first().click()
    const composer = page.locator("textarea.composer-textarea")
    await until(
      async () => (await composer.getAttribute("placeholder")) === "UI_RESOLVE_COLD_HINT",
      "actual cold native display mounts before command prewarming"
    )
    assert.equal(requests.length, 0)
    record("cold original composer uses Q full ui.render envelope without command prewarming")
    await openModsResults(page)
    const jobs = () => page.evaluate((id) => window.api.mods.jobs(id), id)
    const run = async (command: string, fromComposer = false) => {
      const before = new Set((await jobs()).map((row) => row.id))
      if (fromComposer) {
        await composer.fill(`/${command}`)
        // A bare slash opens the real picker and intentionally disables the send button.
        // Selecting its actual command row inserts the space that closes the picker.
        const option = page.getByRole("option").filter({ hasText: `/${command}` })
        await option.waitFor()
        assert.equal(await option.count(), 1)
        await option.click()
        await until(
          async () => (await composer.inputValue()) === `/${command} `,
          `actual slash selection ${command}`
        )
        const send = page.locator("form").filter({ has: composer }).locator('button[type="submit"]')
        assert(await send.isEnabled(), `Selected command ${command} cannot be submitted`)
        await send.click()
      } else {
        const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), id)).find(
          (row) => row.command === command
        )
        assert(descriptor, `Missing actual command ${command}`)
        await page.evaluate(
          ({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "" }),
          { id, descriptor }
        )
      }
      await until(
        async () =>
          (await jobs()).some(
            (row) => !before.has(row.id) && !["running", "queued"].includes(row.state)
          ),
        `actual command ${command}`
      )
      const job = (await jobs()).find((row) => !before.has(row.id))!
      assert.equal(job.state, "succeeded", JSON.stringify(job))
      return job.result?.text ?? ""
    }
    const pane = page.locator('[data-function-pane="resolve-pane"]')
    await run("resolve-open", true)
    await until(
      async () =>
        (await pane.count()) === 1 &&
        (await pane.innerText()).includes("Q_BODY_0") &&
        (await pane.innerText()).includes("P[") &&
        (await pane.innerText()).includes("R["),
      "real cross-plugin constructors publish Q pane"
    )
    const snapshots = () => page.evaluate((id) => window.api.mods.panes(id), id)
    const initial = (await snapshots()).find((row) => row.id === "resolve-pane")!
    evidence.initialPane = initial
    assert.equal(initial.tree.type, "fragment")
    const nodes: FunctionUiNode[] = []
    const collect = (node: FunctionUiElement | string): void => {
      if (typeof node === "string" || node.type === "engine") return
      if (node.type !== "fragment") nodes.push(node)
      for (const child of node.children ?? []) collect(child)
    }
    collect(initial.tree)
    const button = nodes.filter((node) => node.type === "Button")
    assert.equal(button.length, 1)
    assert.equal(button[0].props.key, "q-original")
    assert.equal(button[0].press?.plugin, "ui-resolve-q")
    const wrapped = pane.getByRole("button", { name: "Wrapped Original Q action", exact: true })
    assert.equal(await wrapped.count(), 1)
    assert.equal(await wrapped.locator("button").count(), 0)
    const dom = await pane.evaluate((section) => {
      const body = section.querySelector("[data-function-pane-body]")!
      return {
        tags: [...body.children].map((child) => child.tagName),
        text: [...body.children].map((child) => child.textContent)
      }
    })
    assert.deepEqual(dom.tags, ["SPAN", "DIV", "SPAN", "SPAN"])
    assert(dom.text[2]?.includes("Q_FRAGMENT_A") && dom.text[3]?.includes("Q_FRAGMENT_B"))
    await page.screenshot({ path: join(artifacts, "ui-resolve-composed.png") })
    record("P/R Text composition and Button-to-Box wrapper preserve one Q action and transparent React Fragment")

    await until(
      async () => requests.some((row) => JSON.stringify(row.body).includes("[ui-resolve-default]")),
      "actual P constructor continuation reaches held default provider"
    )
    const heldState = JSON.parse(await run("resolve-p-state"))
    evidence.heldPState = heldState
    assert.equal(heldState.owner, "P")
    assert.equal(heldState.models, null)
    assert.equal(heldState.error, null)
    assert.equal((await pane.getByRole("button", { name: "Wrapped Original Q action" }).count()), 1)
    releaseDefault()
    let pState: Record<string, unknown> = {}
    await until(async () => {
      pState = JSON.parse(await run("resolve-p-state"))
      assert.equal(pState.error, null, JSON.stringify(pState))
      return pState.models !== null && pState.modelsMarker === pState.marker
    }, "P retained continuation completes both model routes after original Q publication")
    evidence.pState = pState
    const models = pState.models
    assert(isModObject(models), JSON.stringify(pState))
    for (const [route, text] of [
      ["default", "UI_RESOLVE_DEFAULT_OK"],
      ["explicit", "UI_RESOLVE_EXPLICIT_OK"]
    ]) {
      const model = models[route]
      assert(isModObject(model), JSON.stringify(models))
      assert.equal(model.isAnswered, true)
      assert.equal(model.text, text)
      assert.deepEqual(model.usage, {
        input_tokens: 15,
        output_tokens: 3,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 0
      })
      const wire = requests.filter((row) =>
        JSON.stringify(row.body).includes(`[ui-resolve-${route}]`)
      )
      assert.equal(wire.length, 1)
      assert.equal(wire[0].path, `/${route}/v1/chat/completions`)
    }
    const qState = JSON.parse(await run("resolve-q-state"))
    evidence.qState = qState
    assert.deepEqual(qState, { count: 0, owner: null, models: null })
    record("retained P constructor SDK uses P store and real default/explicit providers after Q returns; Q namespace stays separate")

    await wrapped.click()
    await until(async () => (await pane.innerText()).includes("Q_BODY_1"), "actual original Q callback")
    assert.equal(JSON.parse(await run("resolve-q-state")).count, 1)
    assert.equal(requests.length, 2)
    await page.screenshot({ path: join(artifacts, "ui-resolve-original-action.png") })
    record("clicking the wrapped original button executes Q once and redraws the composed pane")

    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("UI resolve E2E", { exact: true }).first().click()
    await openModsResults(page)
    await until(async () => (await pane.count()) === 1 &&
      (await pane.innerText()).includes("Q_BODY_1"), "renderer reload keeps real warm session")
    assert.equal(JSON.parse(await run("resolve-q-state")).count, 1)
    assert.equal(requests.length, 2)
    record("renderer reload preserves the warm original Q state without rerunning constructor model calls")

    await run("resolve-arm")
    let armedState: Record<string, unknown> = {}
    await until(async () => {
      armedState = JSON.parse(await run("resolve-p-state"))
      return armedState.held === true
    }, "actual P constructor retains its pure pending promise after Q_BODY_1 redraw")
    evidence.armedPState = armedState
    assert.equal(armedState.tone, "warm")
    assert.equal(armedState.marker, pState.marker)
    assert.equal(armedState.neverRevive, null)
    assert.equal(requests.length, 2)
    await run("resolve-close")
    await until(async () => (await pane.count()) === 0, "real Q ui.close removes the drawing")
    const pPlugin = installed.find((row) => row.name === "ui-resolve-p")!
    const beforeConfig = await page.evaluate(
      ({ id, pluginId }) => window.api.mods.userConfig(id, pluginId),
      { id, pluginId: pPlugin.pluginId }
    )
    assert.equal(beforeConfig.state, "applied")
    assert.equal(beforeConfig.savedRevision, beforeConfig.effectiveRevision)
    const readFacts = () => app.evaluate((_, id) => {
      const probe = (globalThis as typeof globalThis & { __modsUiResolveProbe?: Probe })
        .__modsUiResolveProbe
      if (!probe) throw Error("Actual native observer unavailable")
      return probe.readUiResolveConfigurationFacts(id)
    }, id)
    const waitNativeIdle = async (label: string) => {
      const started = Date.now()
      const samples: Array<{ elapsedMs: number; facts: Facts }> = []
      const all = evidence.nativeConfigurationFacts as Record<string, unknown> | undefined
      evidence.nativeConfigurationFacts = { ...all, [label]: samples }
      await until(async () => {
        const facts = await readFacts()
        const elapsedMs = Date.now() - started
        samples.push({ elapsedMs, facts })
        const idle = facts.foregroundSize === 0 && !facts.applying &&
          !facts.configurationBusy && !facts.physicalThreadBusy && !facts.logicalThreadBusy &&
          !facts.assemblyClosed && !facts.assemblyPreparing && facts.calls === 0 &&
          facts.scopes.some((scope) => scope.quiescent && scope.aborted &&
            scope.drawingClosed && scope.pending === 0 && !scope.drained && !scope.releaseAttempted)
        if (elapsedMs > 10000) assert(idle, JSON.stringify(facts))
        return idle
      }, label)
      const facts = samples.at(-1)!.facts
      assert.equal(facts.size, 1, JSON.stringify(facts))
      return facts
    }
    await waitNativeIdle("native closed drawing really became quiescent")
    const saved = await page.evaluate(
      ({ id, view }) => window.api.mods.saveUserConfig(id, view, "tone", "formal"),
      { id, view: beforeConfig }
    )
    assert.equal(saved.state, "pending")
    assert.equal(saved.savedRevision, beforeConfig.savedRevision + 1)
    assert.equal(saved.effectiveRevision, beforeConfig.effectiveRevision)
    const pending = await page.evaluate(
      ({ id, view }) => window.api.mods.applyUserConfig(id, view),
      { id, view: saved }
    )
    assert.equal(pending.state, "pending")
    assert.equal(pending.savedRevision, saved.savedRevision)
    assert.equal(pending.effectiveRevision, beforeConfig.effectiveRevision)
    const oldState = JSON.parse(await run("resolve-p-state"))
    assert.equal(oldState.marker, armedState.marker)
    assert.equal(oldState.tone, "warm")
    assert.equal(oldState.held, true)
    assert.equal(oldState.neverRevive, null)
    evidence.pendingReload = { beforeConfig, saved, pending, oldState }
    const currentConfig = await page.evaluate(
      ({ id, pluginId }) => window.api.mods.userConfig(id, pluginId),
      { id, pluginId: pPlugin.pluginId }
    )
    assert.equal(currentConfig.savedRevision, saved.savedRevision)
    await waitNativeIdle("native thread and foreground are idle before the single explicit reload")
    const reloaded = await page.evaluate(
      ({ id, view }) => window.api.mods.reloadUserConfig(id, view),
      { id, view: currentConfig }
    )
    evidence.reloadAttempt = {
      currentConfig,
      reloaded,
      jobs: await jobs(),
      panes: await snapshots()
    }
    assert.equal(reloaded.state, "applied")
    assert.equal(reloaded.effectiveRevision, saved.savedRevision)
    const newState = JSON.parse(await run("resolve-p-state"))
    assert.equal(typeof newState.marker, "string")
    assert.notEqual(newState.marker, oldState.marker)
    assert.equal(newState.tone, "formal")
    assert.equal(newState.armed, false)
    assert.equal(newState.held, false)
    assert.equal(newState.neverRevive, null)
    assert.equal(requests.length, 2)
    await run("resolve-open", true)
    await until(async () => (await pane.count()) === 1 &&
      (await pane.innerText()).includes(`formal:${newState.marker}:`) &&
      (await pane.innerText()).includes("Q_BODY_0"), "explicit reload publishes the real new module")
    let reloadedState: Record<string, unknown> = {}
    await until(async () => {
      reloadedState = JSON.parse(await run("resolve-p-state"))
      assert.equal(reloadedState.error, null, JSON.stringify(reloadedState))
      return reloadedState.modelsMarker === newState.marker
    }, "new P constructor completes exactly one default and explicit route")
    assert.equal(reloadedState.neverRevive, null)
    for (const route of ["default", "explicit"]) {
      const wire = requests.filter((row) =>
        JSON.stringify(row.body).includes(`[ui-resolve-${route}]`)
      )
      assert.equal(wire.length, 2)
      assert(wire.every((row) => row.path === `/${route}/v1/chat/completions`))
    }
    assert.equal(requests.length, 4)
    assert.equal(JSON.parse(await run("resolve-q-state")).count, 0)
    await wrapped.click()
    await until(async () => (await pane.innerText()).includes("Q_BODY_1"), "new Q callback after real reload")
    assert.equal(JSON.parse(await run("resolve-q-state")).count, 1)
    assert.equal(JSON.parse(await run("resolve-p-state")).neverRevive, null)
    assert.equal(requests.length, 4)
    evidence.explicitReload = { reloaded, newState, reloadedState }
    await page.screenshot({ path: join(artifacts, "ui-resolve-explicit-reload.png") })
    record("closed constructor drawing preserves pending configuration; explicit reload retires the held old VM and uses new parameters without reviving its SDK")

    for (const name of ["ui-resolve-p", "ui-resolve-r"]) {
      await page.evaluate(({ id, name }) => window.api.mods.revokeFunction(id, name), { id, name })
      const row = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
        (row) => row.name === name
      )
      assert.equal(row?.state, "needs-approval", JSON.stringify(row))
    }
    await run("resolve-open", true)
    await until(async () => (await pane.count()) === 1 &&
      (await pane.innerText()).includes("Q_BODY_0"), "original pane after source revocation")
    assert(!(await pane.innerText()).includes("P[") && !(await pane.innerText()).includes("R["))
    const original = pane.getByRole("button", { name: "Original Q action", exact: true })
    assert.equal(await original.count(), 1)
    await original.click()
    await until(async () => (await pane.innerText()).includes("Q_BODY_1"), "no-hook original action")
    assert.equal(await run("resolve-old-hook", true), "OLD_HOOK_OK")
    assert.equal(requests.length, 4)
    evidence.afterRevokePane = (await snapshots()).find((row) => row.id === "resolve-pane")
    await page.screenshot({ path: join(artifacts, "ui-resolve-revoked-fallback.png") })
    record("revoking P/R restores Q controls and the all-false resolver retains old command behavior")

    await composer.fill("UI_RESOLVE_AFTER_REVOKE ordinary chat")
    await composer.press("Enter")
    await until(async () => {
      const stored = JSON.stringify(await page.evaluate((id) => window.api.threads.getMessages(id), id))
      return stored.includes("UI_RESOLVE_AFTER_REVOKE") && stored.includes("UI_RESOLVE_CHAT_OK") &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0
    }, "ordinary real model turn after source revocation")
    assert(requests.some((row) =>
      row.path === "/default/v1/chat/completions" &&
      JSON.stringify(row.body).includes("UI_RESOLVE_AFTER_REVOKE")
    ))
    evidence.messages = await page.evaluate((id) => window.api.threads.getMessages(id), id)
    const hintStarted = Date.now()
    const hintSamples: Array<{ elapsedMs: number; hint: string | null }> = []
    evidence.hintAfterChat = hintSamples
    await until(async () => {
      const hint = await composer.getAttribute("placeholder")
      const elapsedMs = Date.now() - hintStarted
      hintSamples.push({ elapsedMs, hint })
      // isWorking changes at turn completion. The protected site clears its obsolete frame
      // until the actual IPC refresh publishes the new safe hint; no raw fallback is valid.
      if (elapsedMs > 10000) assert.equal(hint, "UI_RESOLVE_COLD_HINT")
      return hint === "UI_RESOLVE_COLD_HINT"
    }, "protected hint republished after the real ordinary turn")
    assert.equal(await composer.getAttribute("placeholder"), "UI_RESOLVE_COLD_HINT")
    await page.screenshot({ path: join(artifacts, "ui-resolve-normal-chat.png") })
    record("ordinary chat still uses the real model/provider after constructor sources are revoked")
    evidence.complete = true
  } catch (error) {
    evidence.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    throw error
  } finally {
    let observerFailure: unknown
    if (observerInstalled) {
      try {
        await app.evaluate(() => {
          const state = globalThis as typeof globalThis & { __modsUiResolveProbe?: Probe }
          try { state.__modsUiResolveProbe?.stopUiResolveConfigurationObserver() }
          finally { delete state.__modsUiResolveProbe }
        })
      } catch (error) {
        observerFailure = error
        evidence.observerCleanupError = String(error)
        evidence.complete = false
      }
    }
    releaseDefault()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    writeFileSync(join(artifacts, "ui-resolve-evidence.json"), JSON.stringify(evidence, null, 2))
    await page.evaluate(() => window.api.models.setDefault("custom:mods-model-fixture")).catch(() => {})
    if (observerFailure && !evidence.error) throw observerFailure
  }
}
