import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { openModsResults } from "./mods-sidebar-navigation"
import type { FunctionUiElement } from "../../src/shared/mods/v2/ui"

function textColors(tree: FunctionUiElement | string): Array<[unknown, unknown]> {
  if (typeof tree === "string" || tree.type === "engine") return []
  return tree.type === "Text"
    ? [[tree.props.color ?? null, tree.props.backgroundColor ?? null]]
    : (tree.children ?? []).flatMap(textColors)
}

export async function verifyThemeColors(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const title = "Theme color compatibility"
  const project = join(workspace, "theme-colors")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(
    async ({ project, title }) => {
      const thread = await window.api.threads.create({
        title,
        workspacePath: project,
        agentMode: "normal"
      })
      const id =
        (thread as unknown as { thread_id: string }).thread_id ??
        (thread as unknown as { id: string }).id
      await window.api.workspace.set(id, project)
      await window.api.mods.configure(id, true, true)
      return id
    },
    { project, title }
  )
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name: "theme-colors", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
  zip.addFile(
    "hooks/register.tsx",
    Buffer.from(`export function register(on) {
    on("session.start", async ($, e, next) => {
      await $.command.register({name:"theme-colors",description:"Theme colors",immediate:true});
      return next(e);
    });
    on("command.run", {command:"theme-colors"}, async $ => {
      await $.ui.open({id:"theme-colors",title:"Theme colors",rows:8}); return {};
    });
    on("ui.render", {component:"Pane",requestId:"theme-colors"}, ($,e) => {
      const {Box,Text}=$.ui.resolve(e);
      return <Box flexDirection="column">
        <Text color="error">THEME_ERROR</Text>
        <Text color="success">THEME_SUCCESS</Text>
        <Text color="text">THEME_TEXT</Text>
        <Text backgroundColor="text">THEME_BACKGROUND</Text>
        <Text color="rgb(20, 30, 40)">THEME_RAW</Text>
      </Box>;
    });
  }`)
  )
  const evidence: Array<{ scheme: string; followsTheme: boolean; rawPreserved: boolean }> = []
  const failures: unknown[] = []
  let originalMode: string | undefined
  const pane = () => page.locator('[data-function-pane="theme-colors"]')
  const appearance = async () => {
    await page.getByRole("button", { name: "自定义设置", exact: true }).click()
    await page.getByRole("button", { name: "通用", exact: true }).click()
    await page.getByRole("radiogroup", { name: "外观模式", exact: true }).waitFor()
  }
  const conversation = async () => {
    await page.getByRole("button", { name: "返回会话", exact: true }).click()
    await page.getByText(title, { exact: true }).first().click()
    await openModsResults(page)
    await pane().getByText("THEME_ERROR", { exact: true }).waitFor()
  }
  try {
    const installed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "theme-colors.zip", "local"),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
      (row) => row.name === "theme-colors"
    )
    assert(mod?.digest)
    assert.equal(mod.name, "theme-colors")
    await page.evaluate(
      ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id, pluginId: mod.pluginId, digest: mod.digest }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click()
    await openModsResults(page)
    const beforeMessages = await page.evaluate((id) => window.api.threads.getMessages(id), id)
    const beforeRequests = JSON.stringify(requests)
    const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), id)).find(
      (row) => row.command === "theme-colors"
    )
    assert(descriptor)
    const job = await page.evaluate(
      ({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "" }),
      { id, descriptor }
    )
    await until(
      async () =>
        (await page.evaluate((id) => window.api.mods.jobs(id), id)).some(
          (row) => row.id === job.id && row.state === "succeeded"
        ),
      "theme command succeeds"
    )
    await pane().getByText("THEME_ERROR", { exact: true }).waitFor()
    const snapshot = (await page.evaluate((id) => window.api.mods.panes(id), id)).find(
      (row) => row.id === "theme-colors" && row.plugin === mod.name
    )
    assert(snapshot)
    assert.deepEqual(textColors(snapshot.tree), [
      ["error", null],
      ["success", null],
      ["text", null],
      [null, "text"],
      ["rgb(20, 30, 40)", null]
    ])
    const originalTree = JSON.stringify(snapshot.tree)
    await appearance()
    originalMode = (
      await page
        .getByRole("radiogroup", { name: "外观模式", exact: true })
        .getByRole("radio", { checked: true })
        .innerText()
    ).trim()
    for (const [mode, scheme] of [
      ["深色", "dark"],
      ["浅色", "light"]
    ]) {
      await page
        .getByRole("radiogroup", { name: "外观模式", exact: true })
        .getByRole("radio", { name: mode, exact: true })
        .click()
      await until(
        () =>
          page.evaluate(
            (scheme) => document.documentElement.dataset.colorScheme === scheme,
            scheme
          ),
        `actual ${scheme} theme applied`
      )
      await conversation()
      const colors = await pane().evaluate((element) => {
        const expected = (variable: string) => {
          const probe = document.createElement("span")
          probe.style.color = `var(${variable})`
          document.body.appendChild(probe)
          try {
            return getComputedStyle(probe).color
          } finally {
            probe.remove()
          }
        }
        const read = (label: string, background = false) => {
          const target = [...element.querySelectorAll("span")].find(
            (node) => node.textContent === label
          )
          if (!target) throw Error("THEME_TEXT_NOT_FOUND")
          const style = getComputedStyle(target)
          return background ? style.backgroundColor : style.color
        }
        return {
          followsTheme:
            read("THEME_ERROR") === expected("--status-critical") &&
            read("THEME_SUCCESS") === expected("--status-nominal") &&
            read("THEME_TEXT") === expected("--foreground") &&
            read("THEME_BACKGROUND", true) === expected("--foreground"),
          rawPreserved: read("THEME_RAW") === "rgb(20, 30, 40)"
        }
      })
      assert(colors.followsTheme)
      assert(colors.rawPreserved)
      evidence.push({ scheme, ...colors })
      assert.deepEqual(
        await page.evaluate((id) => window.api.threads.getMessages(id), id),
        beforeMessages
      )
      assert.equal(JSON.stringify(requests), beforeRequests)
      const currentPane = (await page.evaluate((id) => window.api.mods.panes(id), id)).find(
        (row) => row.id === "theme-colors" && row.plugin === mod.name
      )
      assert(currentPane)
      assert.equal(JSON.stringify(currentPane.tree), originalTree)
      await page.screenshot({ path: join(artifacts, `theme-colors-${scheme}.png`) })
      await appearance()
    }
    pass(
      "real Guest color names follow the actual light and dark theme; raw colors, stored messages and model requests stay unchanged"
    )
  } catch (reason) {
    failures.push(reason)
  } finally {
    if (originalMode) {
      try {
        if (!(await page.getByRole("radiogroup", { name: "外观模式", exact: true }).count()))
          await appearance()
        await page
          .getByRole("radiogroup", { name: "外观模式", exact: true })
          .getByRole("radio", { name: originalMode, exact: true })
          .click()
        assert.equal(
          await page
            .getByRole("radiogroup", { name: "外观模式", exact: true })
            .getByRole("radio", { name: originalMode, exact: true })
            .getAttribute("aria-checked"),
          "true"
        )
        await conversation()
      } catch (reason) {
        failures.push(reason)
      }
    }
    try {
      await page.evaluate((id) => window.api.mods.revokeFunction(id, "theme-colors"), id)
      await until(async () => (await pane().count()) === 0, "revoked color pane is removed")
    } catch (reason) {
      failures.push(reason)
    }
    try {
      writeFileSync(
        join(artifacts, "theme-colors-results.json"),
        JSON.stringify(
          {
            complete: failures.length === 0 && evidence.length === 2,
            checks: evidence
          },
          null,
          2
        ) + "\n"
      )
    } catch (reason) {
      failures.push(reason)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "Theme color validation failed")
}
