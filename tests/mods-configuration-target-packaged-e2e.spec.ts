/** Real renderer selection/application/navigation against an isolated packaged host. No model. */
import assert from "node:assert/strict"
import { appendFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import AdmZip from "adm-zip"
import type { ElectronApplication } from "playwright"
import { openModsProgress } from "./support/mods-sidebar-navigation"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR, "Explicit packaged candidate required")
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.sha256, process.env.CONFIGURATION_E2E_EXPECTED_SHA256)
const fixture = projectCompositionEnvironment(root)
const plugins = ["weather", "replay"].map((name) => {
  const id = `configuration-${name}-fixture`
  const command = `configuration-${name}`
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(
      JSON.stringify({
        name: id,
        version: "1.0.0",
        description: "Isolated configuration target acceptance",
        mods: "mods/manifest.json"
      })
    )
  )
  zip.addFile(
    "mods/manifest.json",
    Buffer.from(
      JSON.stringify({
        apiVersion: "cmb.mods/v2",
        id,
        entry: "main.ts",
        modelProtocol: "result-v1"
      })
    )
  )
  zip.addFile(
    "mods/main.ts",
    Buffer.from(`import type { Register } from "claude-code"
export const register: Register = (on) => {
  on("session.start", async ($, event, next) => {
    await $.command.register({name:"${command}",description:"${name} isolated command"})
    return next(event)
  })
  on("command.run", {command:"${command}"}, async () => ({text:"${name}"}))
}
`)
  )
  const bytes = zip.toBuffer()
  return {
    name,
    id,
    command,
    bytes: [...bytes],
    sha256: createHash("sha256").update(bytes).digest("hex")
  }
})
let app: ElectronApplication | undefined
let passed = false
const errors: string[] = []
const checks: string[] = []
async function main() {
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture)()
    app
      .process()
      .stdout?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
    app
      .process()
      .stderr?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
    const page = await app.firstWindow({ timeout: 60000 })
    page.setDefaultTimeout(30000)
    await page.waitForFunction(() => Boolean(window.api?.mods))
    const setup = await page.evaluate(
      async ({ plugins, workspace }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        for (const plugin of plugins) {
          const result = await window.api.plugins.install(
            new Uint8Array(plugin.bytes).buffer,
            `${plugin.id}.zip`,
            "local"
          )
          if (!result.success) throw Error(result.error)
        }
        const threads = [] as string[]
        for (const title of ["Configuration acceptance A", "Configuration acceptance B"]) {
          const thread = await window.api.threads.create({
            title,
            workspacePath: workspace,
            agentMode: "normal"
          })
          await window.api.workspace.set(thread.thread_id, workspace)
          threads.push(thread.thread_id)
        }
        await window.api.mods.configureGlobal(true)
        let state = await window.api.mods.status(threads[0])
        await window.api.mods.configure(threads[0], true, true, state.workspace)
        for (const plugin of plugins) {
          state = await window.api.mods.status(threads[0])
          const entry = state.functionMods?.find((item) => item.name === plugin.id)
          if (!entry?.digest) throw Error("Missing compiled fixture")
          await window.api.mods.approveFunction(
            threads[0],
            entry.pluginId,
            entry.digest,
            state.workspace
          )
        }
        for (const plugin of plugins) {
          const current = await window.api.mods.clawView(threads[0])
          const source = current.capabilities.find((item) => item.name === plugin.id)!
          await window.api.mods.clawChange(threads[0], {
            kind: "save",
            revision: current.revision,
            workspace: current.workspace,
            profile: {
              id: plugin.name,
              name: `${plugin.name} saved combination`,
              capabilities: [
                { pluginId: source.pluginId, name: source.name, digest: source.digest! }
              ]
            }
          })
        }
        for (const [index, name] of ["weather", "replay"].entries()) {
          const current = await window.api.mods.clawView(threads[index])
          await window.api.mods.clawChange(threads[index], {
            kind: "apply",
            id: name,
            workspace: current.workspace,
            revision: current.revision,
            bindingRevision: current.bindingRevision
          })
        }
        return {
          a: threads[0],
          b: threads[1],
          workspace: state.workspace,
          beforeA: await window.api.mods.clawView(threads[0]),
          beforeB: await window.api.mods.clawView(threads[1])
        }
      },
      { plugins, workspace: fixture.workspace }
    )
    await page.reload()
    await page.getByText("Configuration acceptance A", { exact: true }).first().click()
    const sidebar = await openModsProgress(page, "高级设置")
    await sidebar
      .getByRole("button", { name: /configuration-weather.*weather isolated command/ })
      .waitFor()
    assert.equal(
      await sidebar
        .getByRole("button", { name: /configuration-replay.*replay isolated command/ })
        .count(),
      0
    )
    const manageCombinations = async () => {
      await openModsProgress(page, "高级设置")
      const summary = sidebar.getByText("高级：手动管理组合", { exact: true })
      if (
        !(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open))
      )
        await summary.click()
      await sidebar.getByRole("button", { name: "管理助手组合", exact: true }).click()
    }
    await manageCombinations()
    // Task examples are manual; opening configuration must not start a page tour.
    assert.equal(await page.getByRole("region", { name: "任务示例演练", exact: true }).count(), 0)
    const picker = page.getByRole("combobox", { name: "配置目标聊天", exact: true })
    const chooseB = async () => {
      await picker.click()
      await page
        .getByRole("combobox", { name: "搜索配置聊天", exact: true })
        .fill("Configuration acceptance B")
      await page
        .getByRole("option", {
          name: `Configuration acceptance B · ${fixture.workspace}`,
          exact: true
        })
        .click()
    }
    await chooseB()
    await page.getByText("当前组合：replay saved combination", { exact: true }).waitFor()
    await page.getByText("高级编辑与已保存组合", { exact: true }).click()
    const applySaved = async (name: string) => {
      const card = page
        .getByRole("button", { name: `${name} saved combination`, exact: true })
        .locator("..")
      await card.getByRole("button", { name: "应用到所选聊天", exact: true }).click()
      const preview = page.getByRole("region", { name: "应用变化预览", exact: true })
      await preview.getByRole("button", { name: "确认应用", exact: true }).click()
      await page.getByText(`当前组合：${name} saved combination`, { exact: true }).waitFor()
    }
    // Actually change B, then return it to Replay, through both real preview/application dialogs.
    await applySaved("weather")
    await applySaved("replay")
    const after = await page.evaluate(
      async ({ a, b }) => ({
        a: await window.api.mods.clawView(a),
        b: await window.api.mods.clawView(b)
      }),
      setup
    )
    assert.deepEqual(after.a.active, setup.beforeA.active)
    assert.equal(after.a.bindingRevision, setup.beforeA.bindingRevision)
    assert.equal(after.b.active?.id, "replay")
    assert(after.b.bindingRevision > setup.beforeB.bindingRevision)
    checks.push("B real UI applications change only B binding; A snapshot/revision unchanged")
    await page.getByRole("button", { name: "返回应用", exact: true }).click()
    await sidebar
      .getByRole("button", { name: /configuration-weather.*weather isolated command/ })
      .waitFor()
    assert.equal(
      await sidebar
        .getByRole("button", { name: /configuration-replay.*replay isolated command/ })
        .count(),
      0
    )
    checks.push("Returning from target B leaves actual chat A and Weather command visible")
    await manageCombinations()
    await chooseB()
    await page.getByText("当前组合：replay saved combination", { exact: true }).waitFor()
    await page.getByRole("button", { name: "去这段聊天使用", exact: true }).click()
    await openModsProgress(page, "高级设置")
    await sidebar
      .getByRole("button", { name: /configuration-replay.*replay isolated command/ })
      .waitFor()
    assert.equal(
      await sidebar
        .getByRole("button", { name: /configuration-weather.*weather isolated command/ })
        .count(),
      0
    )
    checks.push("Explicit use navigates B and only Replay command is visible")
    writeFileSync(
      join(fixture.isolated, "bindings.json"),
      JSON.stringify({ setup, after }, null, 2)
    )
    passed = true
    console.log(`PASS real packaged configuration target: ${fixture.isolated}`)
  } catch (error) {
    errors.push(String(error))
    throw error
  } finally {
    await app?.close()
    assert.deepEqual(projectCompositionCandidate(root), candidate, "Candidate changed during E2E")
    writeFileSync(
      join(fixture.isolated, "evidence.json"),
      JSON.stringify(
        {
          candidate,
          passed,
          checks,
          errors,
          modelRequests: 0,
          fixture:
            "Two generated independent ZIP plugins installed unchanged, real authorization and per-thread binding; no external model/service",
          plugins: plugins.map(({ name, id, command, sha256 }) => ({ name, id, command, sha256 }))
        },
        null,
        2
      )
    )
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
