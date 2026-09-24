import { waitUntilMonotonic } from "./mods-monotonic-wait"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { desktopSoakOptions, qualifiesDesktopSoak } from "./mods-desktop-soak-options"
import { summarizeSamples } from "./mods-v2-performance"
import {
  beginDesktopLatency,
  finishDesktopLatency,
  readDesktopLatency
} from "./mods-desktop-latency"
import { verifyDesktopPerformance } from "./mods-desktop-performance-e2e"

/** Whole application workload. No test IPC bridge, direct guest dispatcher or fake store. */
export async function verifyDesktopSoak(
  app: ElectronApplication,
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  performanceOnly = false,
  historyRegression = false
): Promise<void> {
  const options = desktopSoakOptions({ smoke: process.env.CMB_MODS_SOAK_SMOKE })
  const project = join(workspace, "desktop-soak")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Desktop soak",
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
  for (let n = 0; n < 8; n++) {
    const zip = new AdmZip()
    zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: `soak-${n}`, version: "1.0.0" })))
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
    zip.addFile(
      "hooks/register.tsx",
      Buffer.from(`export function register(on){
      ${performanceOnly ? 'on("turn.step",async function*($,e,next){return yield* next(e)});' : ""}
      on("session.start",async($,e,next)=>{await $.command.register({name:"soak-${n}",description:"Soak ${n}",immediate:true});return next(e)});
      on("command.run",{command:"soak-${n}"},async($)=>{
        ${n < 4 ? `await $.ui.open({id:"soak-${n}",title:"Soak ${n}",rows:5,closeOnEscape:true});` : ""}
        return {text:"SOAK_READY_${n}"}
      });
      on("ui.render",{component:"Pane",requestId:"soak-${n}"},async($,e)=>{
        const {Client}=$.ui.resolve(e);const count=await $.store.get("count")||0;
        return <Client key="counter" module="./surface.tsx" props={{count}}/>
      });
      on("ui.message",{element:"counter"},async($,e)=>{
        const current=await $.store.get("count")||0;
        if(e.data.count!==current+1)throw Error("SOAK_NON_SEQUENTIAL_ACK");
        await $.store.set("count",e.data.count);return {props:{count:e.data.count}}
      })
    }`)
    )
    zip.addFile(
      "hooks/surface.tsx",
      Buffer.from(`export default function Board(props,s){
      const {Box,Text,Button,Input}=s.elements;
      if(s.state===undefined)s.setState({count:props.count,note:""});
      return <Box flexDirection="column">
        <Text>ACK_${n}:{props.count}</Text>
        <Button key="increment" label="Soak increment ${n}" onPress={()=>{
          const count=s.state.count+1;s.setState({...s.state,count});s.post({count})
        }}/>
        <Input key="note" label="Soak note ${n}" value={s.state.note}
          onSubmit={value=>s.setState({...s.state,note:value})}/>
      </Box>
    }`)
    )
    const installed = await page.evaluate(
      (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "soak.zip", "local"),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
  }
  const mods = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!
  for (let n = 0; n < 8; n++) {
    const mod = mods.find((mod) => mod.name === `soak-${n}`)!
    assert(mod?.digest)
    await page.evaluate(
      ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id, pluginId: mod.pluginId, digest: mod.digest }
    )
  }
  const counts = [0, 0, 0, 0]
  const samples: Array<{
    event: number
    pane: number
    acknowledgementMs: number
    inputMs: number
    inputPaintMs: number
    clickAcknowledgementMs: number
  }> = []
  const memory: unknown[] = []
  const processes = () => app.evaluate(({ app }) => app.getAppMetrics())
  const modProcesses = async () => (await processes()).filter((p) => p.name === "CMB Function Mods")
  const select = async () => {
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Desktop soak", { exact: true }).first().click()
  }
  const open = async () => {
    const commands = await page.evaluate((id) => window.api.mods.commands(id), id)
    assert.equal(commands.filter((c) => /^soak-[0-7]$/.test(c.command)).length, 8)
    for (let n = 0; n < 8; n++) {
      const descriptor = commands.find((c) => c.command === `soak-${n}`)!
      const job = await page.evaluate(
        ({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "" }),
        { id, descriptor }
      )
      await until(
        async () =>
          (await page.evaluate((id) => window.api.mods.jobs(id), id)).some(
            (j) => j.id === job.id && j.state === "succeeded"
          ),
        "all eight real guests execute commands"
      )
    }
    await until(
      async () => (await page.locator("[data-function-pane]").count()) === 4,
      "four live panes"
    )
    for (let n = 0; n < 4; n++)
      await page.getByText(`ACK_${n}:${counts[n]}`, { exact: true }).waitFor()
    assert((await modProcesses()).length > 0, "named real utility runtime exists")
  }
  const off = async () => {
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await until(
      async () => (await page.locator("[data-function-pane]").count()) === 0,
      "off removes every pane"
    )
    await until(
      async () => (await modProcesses()).length === 0,
      "off terminates owned Mods utilities"
    )
    assert.deepEqual(await page.evaluate((id) => window.api.mods.panes(id), id), [])
    assert.deepEqual(await page.evaluate((id) => window.api.mods.commands(id), id), [])
  }
  const snapshot = async (event: number, phase: string) => {
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send("HeapProfiler.collectGarbage")
      const heap = await cdp.send("Runtime.getHeapUsage")
      memory.push({
        event,
        phase,
        at: new Date().toISOString(),
        rendererAfterGc: heap,
        processes: await processes()
      })
    } finally {
      await cdp.detach()
    }
  }
  let completed = 0
  let cycles = 0
  let status = "running"
  await select()
  await open()
  await page.screenshot({ path: join(artifacts, "desktop-soak-four-panes.png") })
  pass("eight installed and approved guests execute; four real Client panes render")
  if (historyRegression) {
    // Saturate the actual persisted history before exercising Client events. This is a
    // bounded regression scenario, never a substitute for the timed two-hour workload.
    for (let cycle = 0; cycle < 6; cycle++) await open()
    assert.equal((await page.evaluate((id) => window.api.mods.jobs(id), id)).length, 50)
    await until(async () => {
      const sites = page.locator('[data-function-site="CommandOutput"]')
      return (
        (await sites.count()) === 50 &&
        (await sites.filter({ hasText: "插件界面未能绘制" }).count()) === 0
      )
    }, "all retained command outputs render without site capacity errors")
    await page.screenshot({ path: join(artifacts, "desktop-history-fifty-jobs.png") })
    pass("all 50 retained command outputs render with four live Clients")
    for (let event = 1; event <= 200; event++) {
      const pane = (event - 1) % 4
      await page
        .getByRole("textbox", { name: `Soak note ${pane}`, exact: true })
        .fill(`history-${event}`)
      await page.getByRole("button", { name: `Soak increment ${pane}`, exact: true }).click()
      await page.getByText(`ACK_${pane}:${++counts[pane]}`, { exact: true }).waitFor()
    }
    assert.equal(
      await page.getByText("插件界面未能绘制，已恢复默认内容。", { exact: true }).count(),
      0
    )
    await off()
    await page.evaluate(() => window.api.mods.configureGlobal(true))
    await select()
    await open()
    for (let pane = 0; pane < 4; pane++)
      await page.getByText(`ACK_${pane}:50`, { exact: true }).waitFor()
    await off()
    pass("200 Client acknowledgements survive full command history, reload and off")
    return
  }
  if (performanceOnly) {
    await verifyDesktopPerformance({
      app,
      page,
      id,
      artifacts,
      smoke: options.smoke,
      open,
      off,
      select,
      pass
    })
    return
  }
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const save = () =>
    writeFileSync(
      join(artifacts, "desktop-soak-progress.json"),
      JSON.stringify(
        {
          status,
          options,
          startedAt,
          elapsedMs: performance.now() - started,
          completed,
          cycles,
          counts,
          samples,
          memory,
          qualified:
            status === "completed" &&
            qualifiesDesktopSoak(options, performance.now() - started, completed),
          limits: [
            "Acknowledgement and input timings include Playwright IPC and scheduling.",
            "Separate DOM metrics measure trusted input to the second animation frame, and trusted click to the host acknowledgement DOM update; these exclude automation waits.",
            "Only renderer heap is measured after forced GC; process RSS is not post-GC heap proof.",
            "This workload does not measure model TTFT/throughput or five-minute idle CPU.",
            "Qualification confirms workload duration/count, not absence of memory growth or every performance budget."
          ]
        },
        null,
        2
      )
    )
  try {
    await snapshot(0, "loaded")
    for (let event = 1; event <= options.events; event++) {
      if (existsSync(join(artifacts, "STOP"))) throw Error("DESKTOP_SOAK_STOP_REQUESTED")
      const target = started + (options.durationMs * event) / options.events
      await waitUntilMonotonic(target, () => {
        if (existsSync(join(artifacts, "STOP"))) throw Error("DESKTOP_SOAK_STOP_REQUESTED")
      })
      const pane = (event - 1) % 4
      await beginDesktopLatency(page, pane, counts[pane] + 1)
      const input = page.getByRole("textbox", { name: `Soak note ${pane}`, exact: true })
      const inputStart = performance.now()
      await input.fill(`event-${event}`)
      assert.equal(await input.inputValue(), `event-${event}`)
      const inputMs = performance.now() - inputStart
      const begin = performance.now()
      await page.getByRole("button", { name: `Soak increment ${pane}`, exact: true }).click()
      await page.getByText(`ACK_${pane}:${counts[pane] + 1}`, { exact: true }).waitFor()
      const acknowledgementMs = performance.now() - begin
      const domLatency = await finishDesktopLatency(page)
      counts[pane]++
      completed++
      samples.push({ event, pane, inputMs, acknowledgementMs, ...domLatency })
      if (event % Math.max(1, Math.floor(options.reloadEvery / 5)) === 0)
        await snapshot(event, "live")
      if (event % options.reloadEvery === 0) {
        await off()
        await snapshot(event, "off")
        cycles++
        await page.evaluate(() => window.api.mods.configureGlobal(true))
        await select()
        await open()
        await snapshot(event, "reloaded")
      }
      if (event % 100 === 0 || options.smoke) {
        save()
        console.log(JSON.stringify({ completed, cycles, elapsedMs: performance.now() - started }))
      }
    }
    await off()
    await snapshot(completed, "final-off")
    await page.screenshot({ path: join(artifacts, "desktop-soak-off.png") })
    status = "completed"
    save()
    writeFileSync(
      join(artifacts, "desktop-soak-summary.json"),
      JSON.stringify(
        {
          qualified: qualifiesDesktopSoak(options, performance.now() - started, completed),
          completed,
          cycles,
          input: summarizeSamples(samples.map((s) => s.inputMs)),
          acknowledgement: summarizeSamples(samples.map((s) => s.acknowledgementMs)),
          inputEventToSecondFrame: summarizeSamples(samples.map((s) => s.inputPaintMs)),
          clickEventToHostAcknowledgement: summarizeSamples(
            samples.map((s) => s.clickAcknowledgementMs)
          ),
          memoryAssessment:
            "Raw repeated GC windows retained; review separately. No automatic memory acceptance."
        },
        null,
        2
      )
    )
    pass(
      `${options.smoke ? "smoke" : "two-hour"} desktop workload retains acknowledged state across runtime replacement and leaves no Mods utility or pane after off`
    )
  } catch (error) {
    status = "failed"
    save()
    // Preserve the original failure even if the renderer exited before evidence can be read.
    const latency = await readDesktopLatency(page, true).catch(() => ({ unavailable: true }))
    writeFileSync(
      join(artifacts, "desktop-soak-failure.json"),
      JSON.stringify({ completed, counts, latency }, null, 2)
    )
    throw error
  }
}
