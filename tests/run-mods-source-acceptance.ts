import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  prepareModsSourceCandidate,
  readModsSourceCandidate
} from "./support/mods-source-candidate"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"
import { enterModsCreatorChat } from "./support/mods-sidebar-navigation"
import { modsSourceDriverHashes } from "./support/mods-source-driver-hashes"

async function main() {
  const root = resolve(__dirname, "..")
  const option = process.argv.slice(2)
  assert.equal(
    option.length,
    1,
    "Usage: tsx tests/run-mods-source-acceptance.ts --scenario=smoke|original-feature-completion|generic-mod|composition|project|report-derived|autobiz-from-zero|autobiz-derived|desktop-smoke|desktop-performance|desktop-soak"
  )
  assert(option[0].startsWith("--scenario="), "SOURCE_SCENARIO_FLAG_REQUIRED")
  const scenario = option[0].replace(/^--scenario=/, "")
  const live = {
    "generic-mod": "generic-mod-live-native-e2e.spec.ts",
    composition: "generic-mod-composition-live-native-e2e.spec.ts",
    project: "generic-project-creator-live-native-e2e.spec.ts",
    "report-derived": "creator-project-matrix-live-native-e2e.spec.ts",
    "autobiz-from-zero": "creator-project-matrix-live-native-e2e.spec.ts",
    "autobiz-derived": "creator-project-matrix-live-native-e2e.spec.ts"
  }
  const realModel = Object.hasOwn(live, scenario)
  const originalCompletion = scenario === "original-feature-completion"
  assert(
    scenario === "smoke" ||
      originalCompletion ||
      realModel ||
      ["desktop-smoke", "desktop-performance", "desktop-soak"].includes(scenario),
    "UNKNOWN_SOURCE_SCENARIO"
  )
  if (realModel) assert(process.env.CMB_CREATOR_LIVE_MODEL_ID, "REAL_MODEL_EXPLICIT_ID_REQUIRED")
  const output = join(root, "output", `phase3-source-${scenario}-${randomUUID().slice(0, 8)}`)
  mkdirSync(output)
  const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")
  const selected =
    scenario === "smoke"
      ? []
      : [
          scenario.startsWith("desktop-")
            ? "tests/mods-e2e.spec.ts"
            : originalCompletion
              ? "tests/original-feature-source-e2e.spec.ts"
              : `tests/${live[scenario as keyof typeof live]}`
        ]
  const driverHashes = await modsSourceDriverHashes(root, [
    "tests/run-mods-source-acceptance.ts",
    ...selected
  ])
  const candidate = await prepareModsSourceCandidate(root, join(output, "candidate"))
  const proof = {
    scenario,
    output,
    candidate: candidate.path,
    manifestSha256: digest(candidate.path),
    head: candidate.manifest.head,
    realModel,
    startedAt: new Date().toISOString(),
    driverHashes
  }
  writeFileSync(join(output, "run.json"), JSON.stringify(proof, null, 2))
  process.env.COMPOSITION_E2E_SOURCE_CANDIDATE = candidate.path
  process.env.COMPOSITION_E2E_ARTIFACT_ROOT = join(output, "journey")
  process.env.CREATOR_E2E_SOURCE_PREVIEW = "1"
  process.env.CREATOR_E2E_EXPECTED_SHA256 = createHash("sha256")
    .update(readFileSync(candidate.manifest.entry))
    .digest("hex")
  console.log(
    JSON.stringify({
      scenario,
      output,
      candidate: candidate.path,
      head: candidate.manifest.head,
      realModel
    })
  )
  try {
    for (const [file, expected] of Object.entries(driverHashes))
      assert.equal(
        digest(join(root, file)),
        expected,
        `SOURCE_DRIVER_CHANGED_DURING_COMPILE:${file}`
      )
    if (scenario === "smoke") {
      const fixture = projectCompositionEnvironment(root)
      const app = await createHeadlessProjectCompositionLaunch(root, fixture)()
      app
        .process()
        .stdout?.on("data", (bytes) => appendFileSync(join(output, "native-stdout.log"), bytes))
      app
        .process()
        .stderr?.on("data", (bytes) => appendFileSync(join(output, "native-stderr.log"), bytes))
      try {
        const page = await app.firstWindow({ timeout: 60_000 })
        await page.addInitScript("window.__name = value => value")
        await page.evaluate("window.__name = value => value")
        const errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))
        await page.waitForFunction(() => Boolean(window.api?.mods?.development), null, {
          timeout: 60_000
        })
        const native = await app.evaluate(({ app }) => ({
          path: app.getAppPath(),
          version: app.getVersion(),
          packaged: app.isPackaged
        }))
        assert.equal(native.path, candidate.manifest.root)
        assert.equal(native.version, "2.0.0")
        const result = await page.evaluate(async (workspace) => {
          const thread = await window.api.threads.create({
            title: "Current source smoke",
            workspacePath: workspace,
            agentMode: "normal"
          })
          const id =
            (thread as unknown as { thread_id: string }).thread_id ??
            (thread as unknown as { id: string }).id
          await window.api.workspace.set(id, workspace)
          return {
            id,
            status: await window.api.mods.status(id),
            plugins: await window.api.plugins.list(),
            development: await window.api.mods.development.status({ threadId: id })
          }
        }, fixture.workspace)
        assert(result.id && result.development.threadId === result.id)
        await page.reload()
        await page.waitForFunction(() => Boolean(window.api?.mods?.development))
        await page.addLocatorHandler(
          page.locator('[aria-label="插件创作使用指引"], [aria-label="应用使用指引"]').first(),
          async (guide) => guide.getByRole("button", { name: "跳过指引", exact: true }).click()
        )
        await page.getByRole("tab", { name: "对话模式", exact: true }).click()
        const chat = page.locator(`[data-chat-thread-id=${JSON.stringify(result.id)}]`)
        if (!(await chat.isVisible()))
          await page.getByText("Current source smoke", { exact: true }).first().click()
        const composer = chat.locator("textarea.composer-textarea")
        const draft = "保留这条未发送的原始输入：current source smoke"
        await composer.fill(draft)
        const original = await composer.elementHandle()
        assert(original, "NATIVE_PARENT_COMPOSER_REQUIRED")
        try {
          await enterModsCreatorChat(page, result.id, fixture.workspace)
          const panel = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
          if (await panel.isVisible())
            await panel.getByRole("button", { name: "Close", exact: true }).click()
          await chat.getByRole("button", { name: "普通模式", exact: true }).click()
          assert.equal(await composer.inputValue(), draft, "NATIVE_PARENT_DRAFT_LOST")
          assert(
            await original.evaluate(
              (node, id) =>
                node ===
                document.querySelector(
                  `[data-chat-thread-id="${CSS.escape(id)}"] textarea.composer-textarea`
                ),
              result.id
            ),
            "NATIVE_PARENT_COMPOSER_REMOUNTED"
          )
        } finally {
          await original.dispose()
        }
        await page.screenshot({ path: join(output, "native-smoke.png") })
        assert.deepEqual(errors, [])
        readModsSourceCandidate(candidate.path)
        writeFileSync(
          join(output, "result.json"),
          JSON.stringify(
            {
              passed: true,
              scenario,
              native,
              threadId: result.id,
              pluginCount: result.plugins.length,
              errors
            },
            null,
            2
          )
        )
        console.log("PASS current-source native main/preload/renderer/IPC smoke")
      } finally {
        let forced = false
        const timeout = setTimeout(() => {
          if (app.process().exitCode === null) {
            forced = true
            app.process().kill()
          }
        }, 10000)
        try {
          await app.close()
        } finally {
          clearTimeout(timeout)
        }
        assert(!forced, "SOURCE_NATIVE_SHUTDOWN_TIMEOUT")
      }
    } else {
      const desktop = scenario.startsWith("desktop-")
      const env = { ...process.env }
      delete env.CREATOR_E2E_BUILT_PREVIEW
      delete env.COMPOSITION_E2E_PACKAGED_DIR
      delete env.CMB_MODS_SOAK_SMOKE
      delete env.CMB_MODS_SOAK_GC_DIAGNOSTIC
      if (["report-derived", "autobiz-from-zero", "autobiz-derived"].includes(scenario))
        env.CREATOR_LIVE_PROJECT_MATRIX = scenario
      if (desktop)
        Object.assign(env, {
          CMB_MODS_E2E_FOCUS:
            scenario === "desktop-performance" ? "desktop-performance" : "desktop-soak",
          CMB_MODS_E2E_APP_DIR: candidate.manifest.root,
          CMB_MODS_E2E_ARTIFACTS: output,
          ELECTRON_RENDERER_URL: candidate.manifest.rendererUrl,
          ...(scenario === "desktop-smoke" ? { CMB_MODS_SOAK_SMOKE: "1" } : {})
        })
      const script = desktop
        ? "mods-e2e.spec.ts"
        : originalCompletion
          ? "original-feature-source-e2e.spec.ts"
          : live[scenario as keyof typeof live]
      const code = await new Promise<number>((done, fail) => {
        const child = spawn(
          process.execPath,
          [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "tests", script)],
          { cwd: root, env, stdio: "inherit", windowsHide: true }
        )
        child.once("error", fail)
        child.once("exit", (value) => done(value ?? 1))
      })
      readModsSourceCandidate(candidate.path)
      writeFileSync(
        join(output, "exit.json"),
        JSON.stringify({ scenario, code, completedAt: new Date().toISOString() }, null, 2)
      )
      process.exitCode = code
    }
  } finally {
    try {
      assert.equal(digest(candidate.path), proof.manifestSha256, "SOURCE_MANIFEST_CHANGED")
      for (const [file, expected] of Object.entries(driverHashes))
        assert.equal(digest(join(root, file)), expected, `SOURCE_DRIVER_CHANGED:${file}`)
      writeFileSync(
        join(output, "run.json"),
        JSON.stringify(
          { ...proof, finishedAt: new Date().toISOString(), driverIntegrityVerified: true },
          null,
          2
        )
      )
    } finally {
      await candidate.close()
    }
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
