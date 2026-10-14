/** Real isolated utility-process exit, followed only by explicit existing UI recovery. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFileSync, createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"

const root = resolve(__dirname, "..")
assert(process.env.CMB_MODS_PACKAGED_DIR, "A production package is required")
assert(process.env.CMB_MODS_EXPECTED_ASAR_SHA256, "Pin the unified production ASAR hash")
const artifacts = resolve(
  process.env.CMB_MODS_CORE_E2E_ARTIFACTS ??
    "output/project-platform-20261012/runtime-recovery-final-v7"
)
assert(!existsSync(artifacts), "Preserve existing evidence")
mkdirSync(artifacts, { recursive: true })
const { isolated, workspace, env } = compositionEnvironment(root)
const launch = createModsCoreLauncher(root, isolated, env, artifacts)
const evidence: Record<string, unknown> = { isolated, workspace }
let app: ElectronApplication | undefined
let page: Page | undefined
async function hashAsar() {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(
    join(resolve(process.env.CMB_MODS_PACKAGED_DIR!), "resources/app.asar")
  ))
    hash.update(chunk)
  return hash.digest("hex")
}

async function main() {
  try {
    evidence.asarSha256 = await hashAsar()
    assert.equal(evidence.asarSha256, process.env.CMB_MODS_EXPECTED_ASAR_SHA256)
    evidence.scope =
      "Physical guest exit after one completed UI effect; unknown inflight effects are covered separately by the real-manager integration suite."
    app = await launch(60000)
    for (const stream of [app.process().stdout, app.process().stderr])
      stream?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    page = await app.firstWindow()
    page.setDefaultTimeout(20000)
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.mods))
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(JSON.stringify({ name: "recovery-e2e", version: "1.0.0" }))
    )
    zip.addFile("hooks/hooks.json", Buffer.from('{"modules":["./register.tsx"]}'))
    zip.addFile(
      "hooks/register.tsx",
      Buffer.from(`export function register(on){
      on("session.start",async($,e,next)=>{
        await $.store.set("starts",(await $.store.get("starts")||0)+1);
        await $.command.register({name:"recovery-inspect",description:"Read recovery counters",immediate:true});
        return next(e)
      });
      on("command.run",{command:"recovery-inspect"},async($)=>({text:JSON.stringify({
        starts:await $.store.get("starts")||0,effects:await $.store.get("effects")||0})}));
      on("ui.render",{component:"AbovePrompt"},async($,e)=>{
        const {Box,Text,Button}=$.ui.resolve(e);
        return <Box flexDirection="column"><Text>RECOVERY REAL GUEST</Text>
          <Text>{"STARTS:"+(await $.store.get("starts")||0)+" EFFECTS:"+(await $.store.get("effects")||0)}</Text>
          <Button key="once" label="记录一次测试操作" onPress={async()=>{
            await $.store.set("effects",(await $.store.get("effects")||0)+1);
            await $.ui.invalidate("ui.render")
          }}/></Box>
      })
    }`)
    )
    const setup = await page.evaluate(
      async ({ workspace, bytes }) => {
        await window.api.mods.configureGlobal(true)
        const installed = await window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "recovery.zip",
          "local"
        )
        if (!installed.success) throw Error(installed.error)
        const ids: string[] = []
        for (const title of ["恢复测试目标", "恢复测试健康会话"]) {
          const thread = await window.api.threads.create({
            title,
            workspacePath: workspace,
            agentMode: "normal"
          })
          const id = (thread as unknown as { thread_id: string }).thread_id
          await window.api.workspace.set(id, workspace)
          await window.api.mods.configure(id, true, false)
          ids.push(id)
        }
        const status = await window.api.mods.status(ids[0])
        const plugin = status.functionMods!.find((row) => row.name === "recovery-e2e")!
        if (!plugin?.digest) throw Error("Recovery plugin missing")
        await window.api.mods.approveFunction(ids[0], plugin.pluginId, plugin.digest)
        return { ids, plugin }
      },
      { workspace, bytes: [...zip.toBuffer()] }
    )
    evidence.setup = setup
    const metrics = () => app!.evaluate(({ app }) => app.getAppMetrics())
    // Only initial directory hydration reload; no reload during failure or recovery.
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.evaluate("window.__name = value => value")
    // Configuration is workspace-scoped. Warm the healthy thread before taking the baseline,
    // so opening the target cannot be confused with an unrelated healthy startup.
    await page.getByText("恢复测试健康会话", { exact: true }).first().click()
    await page.getByText("RECOVERY REAL GUEST", { exact: true }).waitFor()
    const before = new Set((await metrics()).map((row) => row.pid))
    evidence.baselinePids = [...before]
    await page.getByText("恢复测试目标", { exact: true }).first().click()
    await page.evaluate(id => window.api.mods.commands(id), setup.ids[0])
    await page.getByText("RECOVERY REAL GUEST", { exact: true }).waitFor()
    const owned = (await metrics()).filter(
      (row) => !before.has(row.pid) && row.name === "CMB Function Mods"
    )
    evidence.newGuests = owned
    assert.equal(owned.length, 1, "Identify exactly one newly created guest of this isolated app")
    const target = owned[0]
    evidence.target = target
    await page.getByRole("button", { name: "记录一次测试操作", exact: true }).click()
    await page.getByText(/^STARTS:\d+ EFFECTS:1$/).waitFor()
    const healthy = await page.evaluate(async (id) => {
      const outcome = await window.api.mods.siteMountOutcome(id, "AssistantMessage")
      if (outcome.state !== "mounted") throw Error("Healthy mount failed")
      const facts = { text: "HEALTHY_HISTORY", isFirstOfReply: true }
      const result = await window.api.mods.siteRender(id, outcome.owner, facts)
      if (!result) throw Error("Healthy drawing missing")
      return { owner: outcome.owner, generation: result.generation, facts }
    }, setup.ids[1])
    evidence.healthyBefore = healthy
    // Kill only the captured utility from this application's own current process metrics.
    await app.evaluate(({ app }, target) => {
      const current = app.getAppMetrics().find((row) => row.pid === target.pid)
      if (
        !current ||
        current.name !== "CMB Function Mods" ||
        current.creationTime !== target.creationTime ||
        current.pid === process.pid
      )
        throw Error("OWNED_GUEST_IDENTITY_CHANGED")
      process.kill(current.pid)
    }, target)
    const exitDeadline = Date.now() + 10000
    while (
      (await metrics()).some(
        (row) => row.pid === target.pid && row.creationTime === target.creationTime
      )
    ) {
      assert(Date.now() < exitDeadline, "Owned guest must physically exit before testing recovery")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // A normal protected read detects the exited guest; it must not create another one.
    await page.evaluate(async (id) => {
      await window.api.mods.commands(id)
    }, setup.ids[0])
    await page.getByRole("button", { name: "查看恢复选项" }).first().waitFor()
    await page.screenshot({ path: join(artifacts, "stopped.png"), fullPage: true })
    const healthyAfter = await page.evaluate(
      ({ id, healthy }) => window.api.mods.siteRender(id, healthy.owner, healthy.facts),
      { id: setup.ids[1], healthy }
    )
    assert.equal(healthyAfter?.generation, healthy.generation, "Healthy owner was not revoked")
    const stopped = await page.evaluate(
      ({ id, plugin }) => window.api.mods.userConfig(id, plugin),
      { id: setup.ids[0], plugin: setup.plugin.pluginId }
    )
    assert.equal(stopped.state, "stopped")
    const beforeRecovery = (await metrics()).filter((row) => row.name === "CMB Function Mods")
    assert.equal(beforeRecovery.length, 1, "Only healthy guest remains; no automatic restart")
    await page.getByRole("button", { name: "查看恢复选项" }).first().click()
    await page.getByText("插件参数", { exact: true }).click()
    await page.getByText(/初始化操作可能再次执行/).waitFor()
    await page.getByRole("button", { name: "重新加载当前组合", exact: true }).click()
    await page.getByText("STARTS:3 EFFECTS:1", { exact: true }).waitFor()
    const finalHealthy = await page.evaluate(
      ({ id, healthy }) => window.api.mods.siteRender(id, healthy.owner, healthy.facts),
      { id: setup.ids[1], healthy }
    )
    assert.equal(finalHealthy?.generation, healthy.generation)
    evidence.after = { healthy: finalHealthy, metrics: await metrics(), starts: 3, effects: 1 }
    await page.screenshot({ path: join(artifacts, "recovered.png"), fullPage: true })
    evidence.pass = true
    console.log(
      "PASS owned guest exit stops one thread; explicit UI reload initializes once without replaying effect or revoking healthy owner"
    )
  } catch (error) {
    evidence.error = error instanceof Error ? error.stack : String(error)
    if (page)
      await page
        .screenshot({ path: join(artifacts, "failure.png"), fullPage: true })
        .catch(() => {})
    throw error
  } finally {
    try {
      if (app) await app.close()
    } finally {
      evidence.asarSha256After = await hashAsar()
      writeFileSync(join(artifacts, "evidence.json"), JSON.stringify(evidence, null, 2))
      assert.equal(
        evidence.asarSha256After,
        process.env.CMB_MODS_EXPECTED_ASAR_SHA256,
        "The unified ASAR must remain unchanged throughout acceptance"
      )
    }
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
