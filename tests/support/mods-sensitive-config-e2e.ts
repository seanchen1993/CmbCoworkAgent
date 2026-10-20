import { openModUserConfig, openModsSettings } from "./mods-sidebar-navigation"
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import type { FunctionUserConfigView } from "../../src/shared/mods/v2/user-config-view"

/** Real Windows OS protection, production IPC, React form, SQLite and utility guest. */
export async function verifySensitiveConfiguration(
  app: ElectronApplication,
  page: Page,
  workspace: string,
  controlPath: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
) {
  assert.equal(await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable()), true)
  const id = await page.evaluate(async (workspace) => {
    const thread = await window.api.threads.create({
      title: "敏感参数验证",
      workspacePath: workspace,
      agentMode: "normal"
    })
    const id = (thread as unknown as { thread_id: string }).thread_id
    await window.api.workspace.set(id, workspace)
    await window.api.mods.configure(id, true, true)
    return id
  }, workspace)
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(
      JSON.stringify({
        name: "sensitive-demo",
        userConfig: {
          token: {
            type: "string",
            sensitive: true,
            required: true,
            title: "服务密钥",
            description: "只交给这个插件；页面不回填原值"
          },
          privateFlag: {
            type: "boolean",
            sensitive: true,
            title: "私有开关",
            description: "关闭也是合法的新值"
          },
          privateNumber: {
            type: "number",
            sensitive: true,
            title: "私有额度",
            description: "零也是合法的新值"
          },
          privateList: {
            type: "string",
            multiple: true,
            sensitive: true,
            title: "私有列表",
            description: "每项独立保存；换行保持原文"
          },
          fallback: {
            type: "string",
            sensitive: true,
            default: "author-default",
            title: "私有默认",
            description: "清除后恢复作者默认"
          },
          tone: {
            type: "string",
            default: "warm",
            title: "普通风格",
            description: "普通参数继续照常使用"
          }
        }
      })
    )
  )
  zip.addFile("hooks/hooks.json", Buffer.from('{"modules":["./register.ts"]}'))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on,options){
    const facts={token:typeof options.token==="string"&&options.token.startsWith("devclaw-os-private-"),
      flag:options.privateFlag===false,zero:options.privateNumber===0,
      list:JSON.stringify(options.privateList)===JSON.stringify(["devclaw-os-list,one\\nline"]),fallback:options.fallback==="author-default"};
    on("session.start",async($,e,next)=>{await $.command.register({name:"secret-check",description:JSON.stringify(facts),immediate:true});return next(e)});
    on("command.run",async($)=>({text:JSON.stringify({facts,rows:(await $.config.list()).map(row=>row.key)})}))
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "sensitive-demo.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "sensitive-demo"
  )!
  assert(mod?.digest)
  const view = () =>
    page.evaluate(({ id, pluginId }) => window.api.mods.userConfig(id, pluginId), {
      id,
      pluginId: mod.pluginId
    })
  const noPlaintext = (value: unknown) =>
    assert(
      !JSON.stringify(value).includes("devclaw-os-private-") &&
        !JSON.stringify(value).includes("devclaw-os-list,")
    )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("敏感参数验证", { exact: true }).first().click()
  await openModsSettings(page)
  const form = await openModUserConfig(page, mod.pluginId)
  const token = form.getByLabel("服务密钥 · 必填", { exact: true })
  await token.waitFor()
  assert.equal(await token.getAttribute("type"), "password")
  assert.equal(await token.inputValue(), "")
  const tokenRow = token.locator("xpath=../..")
  assert(await tokenRow.getByRole("button", { name: "保存", exact: true }).isDisabled())
  await token.fill("devclaw-os-private-initial")
  await tokenRow.getByRole("button", { name: "保存", exact: true }).click()
  await until(
    async () => (await view()).savedRevision === 1 && (await token.inputValue()) === "",
    "actual OS secret save clears input"
  )
  noPlaintext(await view())
  assert.equal((await view()).fields.find((field) => field.key === "token")?.secretState, "saved")
  pass(
    "Actual masked React form safely saves a required secret before code approval and never returns its old value"
  )
  const row = (label: string) => form.getByLabel(label, { exact: true }).locator("xpath=../..")
  await form.getByLabel("私有开关", { exact: true }).selectOption("false")
  await row("私有开关").getByRole("button", { name: "保存", exact: true }).click()
  await until(async () => (await view()).savedRevision === 2, "actual protected false save")
  await form.getByLabel("私有额度", { exact: true }).fill("0")
  await row("私有额度").getByRole("button", { name: "保存", exact: true }).click()
  await until(async () => (await view()).savedRevision === 3, "actual protected zero save")
  const list = form.locator('[data-config-list="privateList"]').locator("xpath=../..")
  await list.getByRole("button", { name: "添加一项", exact: true }).click()
  await form.getByLabel("私有列表 第 1 项", { exact: true }).fill("devclaw-os-list,one\nline")
  await list.getByRole("button", { name: "保存", exact: true }).click()
  await until(
    async () =>
      (await view()).savedRevision === 4 &&
      (await form.getByLabel("私有列表 第 1 项", { exact: true }).count()) === 0,
    "actual protected list clears"
  )
  noPlaintext(await view())
  pass(
    "Actual native set actions preserve protected false, zero and a list item containing comma and newline"
  )
  await page.evaluate(
    ({ id, mod }) => window.api.mods.approveFunction(id, mod.pluginId, mod.digest!),
    { id, mod }
  )
  const commands = () => page.evaluate((id) => window.api.mods.commands(id), id)
  const facts = JSON.parse(
    (await commands()).find((command) => command.command === "secret-check")!.name
  )
  assert.deepEqual(facts, { token: true, flag: true, zero: true, list: true, fallback: true })
  const rows = await page.evaluate((id) => window.api.mods.configList(id), id)
  assert(rows.some((row) => row.key === "sensitive-demo.tone"))
  assert(
    !rows.some(
      (row) => row.key === "sensitive-demo.token" || row.key === "sensitive-demo.privateList"
    )
  )
  noPlaintext(rows)
  pass(
    "Only the explicitly approved utility guest receives the typed secrets; ordinary SDK rows and native views exclude them"
  )
  const otherZip = new AdmZip()
  otherZip.addFile(
    "plugin.json",
    Buffer.from(
      JSON.stringify({
        name: "other-sensitive-demo",
        userConfig: {
          token: {
            type: "string",
            sensitive: true,
            title: "Own token",
            description: "Independent own options"
          }
        }
      })
    )
  )
  otherZip.addFile("hooks/hooks.json", Buffer.from('{"modules":["./register.ts"]}'))
  otherZip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on,options){on("session.start",async($,e,next)=>{
    await $.command.register({name:"other-secret-check",description:JSON.stringify({ownUnset:options.token===""}),immediate:true});return next(e)})}`)
  )
  const otherInstall = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "other-secret-demo.zip", "local"),
    [...otherZip.toBuffer()]
  )
  assert(otherInstall.success, otherInstall.error)
  const other = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "other-sensitive-demo"
  )!
  await page.evaluate(
    ({ id, other }) => window.api.mods.approveFunction(id, other.pluginId, other.digest!),
    { id, other }
  )
  assert.deepEqual(
    JSON.parse(
      (await commands()).find((command) => command.command === "other-secret-check")!.name
    ),
    { ownUnset: true }
  )
  pass(
    "A second actual plugin with the same parameter name does not receive the first plugin's stored secret"
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  const persisted = await view()
  assert.equal(persisted.savedRevision, 4)
  for (const field of persisted.fields.filter((field) => field.sensitive)) {
    assert.equal(field.value, undefined)
    assert.equal(field.effectiveValue, undefined)
    assert.equal(Object.hasOwn(field, "default"), false)
  }
  noPlaintext(persisted)
  assert(
    JSON.parse((await commands()).find((command) => command.command === "secret-check")!.name).token
  )
  pass(
    "Renderer reload retains real encrypted SQLite values and reconstructs protected register options without exposing values to the form"
  )
  const save = async (
    key: string,
    action: { operation: "set"; value: string } | { operation: "clear" }
  ) => {
    const current = await view()
    return page.evaluate(
      ({ id, current, key, action }) =>
        window.api.mods.saveSensitiveUserConfig(id, current, key, action),
      { id, current, key, action }
    )
  }
  await save("fallback", { operation: "set", value: "devclaw-os-private-override" })
  const cleared = await save("fallback", { operation: "clear" })
  assert.equal(cleared.fields.find((field) => field.key === "fallback")?.secretState, "default")
  await until(
    async () =>
      JSON.parse((await commands()).find((command) => command.command === "secret-check")!.name)
        .fallback === true,
    "actual secret clear restores author default"
  )
  noPlaintext(cleared)
  pass(
    "Explicit native clear removes only the saved override and restores the original author default"
  )
  const samples: number[] = []
  for (let index = 0; index < 8; index++) {
    const current = await view()
    const elapsed = await page.evaluate(
      async ({ id, current, index }) => {
        const start = performance.now()
        await window.api.mods.saveSensitiveUserConfig(id, current, "token", {
          operation: "set",
          value: "devclaw-os-private-sample-" + index
        })
        return performance.now() - start
      },
      { id, current, index }
    )
    samples.push(elapsed)
  }
  const ordered = [...samples].sort((a, b) => a - b)
  writeFileSync(
    join(artifacts, "sensitive-save-performance.json"),
    JSON.stringify(
      {
        samples,
        medianMs: ordered[4],
        p95Ms: ordered[7],
        scope:
          "Native IPC, actual OS encrypt/decrypt, source checks, SQLite CAS and safe view; excludes model and painting"
      },
      null,
      2
    )
  )
  pass("Eight actual OS-encrypted saves complete with measured IPC/source/SQLite cost")
  await until(async () => (await view()).state === "applied", "actual sensitive idle adoption")
  noPlaintext(await view())
  for (const suffix of ["", "-wal", "-shm"])
    if (existsSync(controlPath + suffix)) {
      const bytes = readFileSync(controlPath + suffix)
      assert(!bytes.includes(Buffer.from("devclaw-os-private-")))
      assert(!bytes.includes(Buffer.from("devclaw-os-list,")))
    }
  pass(
    "Actual control SQLite and WAL contain no test secret plaintext after protected saves and guest reloads"
  )
  await page.getByText("敏感参数验证", { exact: true }).first().click()
  await openModsSettings(page)
  await openModUserConfig(page, mod.pluginId)
  await token.waitFor()
  assert.equal(await token.inputValue(), "")
  assert(await tokenRow.getByRole("button", { name: "保存", exact: true }).isDisabled())
  await page.screenshot({
    path: join(artifacts, "sensitive-configuration-saved.png"),
    fullPage: true
  })
  const requiredCleared: FunctionUserConfigView = await save("token", { operation: "clear" })
  assert.equal(requiredCleared.fields.find((field) => field.key === "token")?.secretState, "unset")
  const freshThread = await page.evaluate(async (workspace) => {
    const thread = await window.api.threads.create({
      title: "清除后新任务",
      workspacePath: workspace,
      agentMode: "normal"
    })
    const id = (thread as unknown as { thread_id: string }).thread_id
    await window.api.workspace.set(id, workspace)
    return id
  }, workspace)
  await assert.rejects(
    () => page.evaluate((id) => window.api.mods.commands(id), freshThread),
    /token/
  )
  pass(
    "Clearing a required secret without a default prevents a new session from loading until it is filled again"
  )
}
