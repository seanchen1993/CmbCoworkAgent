import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { build } from "esbuild"
import { _electron, chromium } from "playwright"
import type { ModelSwitcherFixture } from "./support/model-switcher-fixture"

type FixtureWindow = Window & { modelSwitcherFixture: ModelSwitcherFixture }

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..")
  const require = createRequire(import.meta.url)
  const isolated = mkdtempSync(join(tmpdir(), "cmb-model-switcher-"))
  const mock = join(root, "tests/support/model-switcher-store.ts")
  const bundle = await build({
    entryPoints: [join(root, "tests/support/model-switcher-fixture.tsx")],
    bundle: true,
    platform: "browser",
    nodePaths: process.env.NODE_PATH?.split(delimiter),
    format: "iife",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      "@/lib/store": mock,
      "@/lib/thread-context": mock,
      "@/lib/model-catalog-cache": mock,
      "@": join(root, "src/renderer/src")
    },
    plugins: [
      {
        name: "model-dialog-stub",
        setup(build) {
          build.onResolve({ filter: /^\.\/CustomModelDialog$/ }, () => ({ path: mock }))
          const baseline = process.env.MODEL_SWITCHER_BASELINE_REF
          if (baseline) {
            build.onLoad({ filter: /[/\\]ModelSwitcher\.tsx$/ }, ({ path }) => ({
              contents: execFileSync(
                "git",
                ["show", `${baseline}:src/renderer/src/components/chat/ModelSwitcher.tsx`],
                { cwd: root, encoding: "utf8" }
              ),
              loader: "tsx",
              resolveDir: resolve(path, "..")
            }))
          }
        }
      }
    ]
  })
  const html = join(isolated, "index.html")
  writeFileSync(html, '<div id="root"></div>')
  const entry = join(isolated, "main.cjs")
  writeFileSync(
    entry,
    `const {app,BrowserWindow}=require("electron");app.whenReady().then(()=>new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(html)}));`
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const browserChannel = process.env.MODEL_SWITCHER_BROWSER_CHANNEL
  const app = browserChannel
    ? await chromium.launch({ channel: browserChannel })
    : await _electron.launch({
        executablePath: require("electron"),
        args: [entry, `--user-data-dir=${join(isolated, "profile")}`],
        env,
        timeout: 30_000
      })
  try {
    const page = "firstWindow" in app ? await app.firstWindow() : await app.newPage()
    page.setDefaultTimeout(30_000)
    if (browserChannel) await page.setContent('<div id="root"></div>')
    else await page.waitForURL(/index\.html$/)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const settle = async () => {
      await page.evaluate(() => new Promise((done) => setTimeout(done, 100)))
      const failure = page.getByRole("alert")
      assert.equal(await failure.count(), 0, await failure.allTextContents().then(String))
      return page.evaluate(() => (window as unknown as FixtureWindow).modelSwitcherFixture.read())
    }
    const mount = async (
      metadata: Record<string, unknown>,
      ready = true,
      initialModel = "",
      routingMode: "auto" | "pinned" = "pinned"
    ) => {
      await page.evaluate(
        ({ metadata, ready, initialModel, routingMode }) => {
          ;(window as unknown as FixtureWindow).modelSwitcherFixture.mount(
            metadata,
            ready,
            initialModel,
            routingMode
          )
        },
        { metadata, ready, initialModel, routingMode }
      )
      return settle()
    }

    const staleRouting = {
      model: "custom:local-b",
      routingState: { lastResolvedModelId: "custom:deleted-economy", lastResolvedTier: "economy" }
    }
    await mount(staleRouting)
    await page.getByRole("button", { name: "Local B", exact: true }).click()
    // Exercise the real menu toggle, including the routing IPC call.
    await page.getByRole("dialog").locator("button").first().click()
    const fallback = { currentModel: "custom:local-a", writes: ["custom:local-a"] }
    assert.deepEqual(await settle(), fallback, "enabling routing with a deleted model is stable")
    assert.deepEqual(
      await page.evaluate(() =>
        (window as unknown as FixtureWindow).modelSwitcherFixture.routingWrites()
      ),
      ["auto"]
    )
    await page.evaluate(
      (metadata) => {
        ;(window as unknown as FixtureWindow).modelSwitcherFixture.metadata(metadata)
      },
      { ...staleRouting, model: "custom:local-a" }
    )
    assert.deepEqual(
      await settle(),
      fallback,
      "persisting fallback leaves the old routing snapshot"
    )
    assert.deepEqual(
      await mount(staleRouting, true, "", "auto"),
      fallback,
      "reopening with persisted auto routing must not loop"
    )
    // Pinning a valid model is the config-only recovery for installations without the fix.
    assert.deepEqual(await mount(staleRouting, true, "", "pinned"), {
      currentModel: "custom:local-b",
      writes: []
    })

    assert.deepEqual(await mount({ model: "custom:other-machine" }), {
      currentModel: "custom:local-a",
      writes: ["custom:local-a"]
    })
    assert.deepEqual(
      await settle(),
      {
        currentModel: "custom:local-a",
        writes: ["custom:local-a"]
      },
      "stale metadata must not undo the fallback or retry persistence"
    )

    assert.deepEqual(
      await mount({ model: "custom:model-b" }),
      {
        currentModel: "custom:local-b",
        writes: ["custom:local-b"]
      },
      "legacy model names migrate once"
    )

    assert.deepEqual(
      await mount({ model: "custom:local-b" }),
      {
        currentModel: "custom:local-b",
        writes: []
      },
      "opening a valid model does not write metadata"
    )

    await page.getByRole("button", { name: "Local B", exact: true }).click()
    await page.getByRole("button", { name: /Local A/ }).click()
    assert.deepEqual(
      await settle(),
      {
        currentModel: "custom:local-a",
        writes: ["custom:local-a"]
      },
      "manual selection survives pending metadata persistence"
    )

    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).modelSwitcherFixture.metadata({
        model: "custom:local-a"
      })
    })
    await settle()
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).modelSwitcherFixture.metadata({
        model: "custom:local-b"
      })
    })
    assert.equal(
      (await settle()).currentModel,
      "custom:local-b",
      "new persisted selection is restored"
    )

    assert.deepEqual(
      await mount({ model: "custom:other-machine" }, false),
      {
        currentModel: "",
        writes: []
      },
      "wait for the model catalog"
    )
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).modelSwitcherFixture.catalog(true)
    })
    assert.deepEqual(await settle(), {
      currentModel: "custom:local-a",
      writes: ["custom:local-a"]
    })

    await mount({ model: "custom:other-machine" }, false)
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).modelSwitcherFixture.catalog(true, true)
    })
    assert.equal((await settle()).writes.length, 0, "empty catalog must not persist a replacement")
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).modelSwitcherFixture.catalog(true)
    })
    assert.deepEqual(await settle(), {
      currentModel: "custom:local-a",
      writes: ["custom:local-a"]
    })

    await mount({
      model: "custom:local-a",
      routingState: { lastResolvedModelId: "custom:local-b" }
    })
    await page.getByRole("button", { name: "Local A", exact: true }).click()
    await page.getByRole("dialog").locator("button").first().click()
    assert.deepEqual(
      await settle(),
      {
        currentModel: "custom:local-b",
        writes: []
      },
      "routing mode changes restore the corresponding model without persisting"
    )
    await page.getByRole("dialog").locator("button").first().click()
    assert.deepEqual(
      await settle(),
      { currentModel: "custom:local-a", writes: [] },
      "disabling routing restores the pinned model without persisting"
    )
    assert.deepEqual(
      await page.evaluate(() =>
        (window as unknown as FixtureWindow).modelSwitcherFixture.routingWrites()
      ),
      ["auto", "pinned"]
    )
    console.log(
      "PASS model switcher: smart routing toggles/reopen, imported/legacy IDs, pending writes, manual selection and catalog loading"
    )
    await mount({ model: "custom:local-a" })
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).modelSwitcherFixture.idleCatalog()
    )
    await page.getByRole("button", { name: "Local A", exact: true }).click()
    const idleOption = page.getByRole("button", { name: /闲时模型 Ultra/ })
    assert.equal(await idleOption.isEnabled(), true, "idle hours do not restrict selection")
    await idleOption.click()
    assert.equal((await settle()).currentModel, "builtin:idle-ultra")
    await page.getByRole("button", { name: "闲时模型 Ultra", exact: true }).click()
    assert.equal(await page.getByText(/闲时服务时间：22:00–次日 07:00/).isVisible(), true)
    await page.keyboard.press("Escape")
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).modelSwitcherFixture.showIdleSettings()
    )
    await page.locator('input[value="ultra"]').waitFor()
    assert.equal(await page.locator('input[value="ultra"]').isDisabled(), true)
    assert.equal(await page.locator('input[value="128000"]').isDisabled(), true)
    assert.equal(await page.getByText(/闲时服务时间：22:00–次日 07:00/).isVisible(), true)
    console.log("PASS idle model: selectable, hours notice, locked ultra and 128k context")
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
