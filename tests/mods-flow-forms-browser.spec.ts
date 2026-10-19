/** Actual React interactions; IPC is controlled here, production IPC is covered by Electron. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium, type Page } from "playwright"
import { mount } from "./mods-flow-browser.spec"

const root = resolve(__dirname, "..")
const artifacts = join(root, "output/mods-flow-forms-browser")
const checks: string[] = []
const measurements: Record<string, unknown> = {}
const pass = (label: string) => {
  checks.push(label)
  console.log("PASS " + label)
}
const a = {
  pluginId: "plugin-a",
  plugin: "provider-a",
  digest: "a".repeat(64),
  actionId: "prepare",
  name: "准备文件",
  command: "prepare",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", title: "文件路径", minLength: 1 },
      limit: { type: "integer", title: "数量", minimum: 0 },
      enabled: { type: "boolean", title: "启用标志" },
      label: { type: "string", title: "备注" },
      choice: { type: "integer", title: "等级", enum: [0, 2] }
    }
  },
  configSchema: { type: "object", properties: { strict: { type: "boolean", title: "严格模式" } } },
  outputSchema: {
    type: "object",
    properties: {
      payload: {
        type: "object",
        properties: { path: { type: "string" }, source: { type: "string" } }
      },
      "a/b": { type: "object", properties: { note: { type: "string" } } },
      text: { type: "string" }
    }
  }
}
const b = {
  pluginId: "plugin-b",
  plugin: "provider-b",
  digest: "b".repeat(64),
  actionId: "review",
  name: "独立检视",
  command: "review",
  inputSchema: {
    type: "object",
    required: ["path", "source"],
    properties: {
      path: { type: "string", title: "文件路径", minLength: 1 },
      source: { type: "string", title: "文件内容", minLength: 1 }
    }
  }
}
const seed = {
  schemaVersion: 1,
  id: "flow_a",
  name: "表单演练",
  plugin: "demo",
  goal: "检视真实文件",
  timeoutMs: 60000,
  maxExecutions: 64,
  steps: [
    {
      id: "prepare",
      enabled: true,
      kind: "plugin-action",
      ...a,
      input: { path: "before.ts", extra: { nested: [0, false, ""] } },
      config: {}
    },
    {
      id: "review",
      enabled: true,
      kind: "plugin-action",
      ...b,
      input: {},
      inputFrom: { stepId: "prepare", path: "/payload" }
    },
    { id: "accept", name: "确认", enabled: true, kind: "approval", prompt: "确认结果" }
  ].map((step) => {
    const clean = { ...step } as Record<string, unknown>
    for (const key of ["inputSchema", "outputSchema", "configSchema", "command", "description"])
      delete clean[key]
    return clean
  })
}
const fixtureBody = `
  catalog.actions=${JSON.stringify([a, b])};
  definitions.set('a',[{definition:${JSON.stringify(seed)},revision:1,digest:'initial',updatedAt:1}]);
  window.formsFixture={changeProvider:()=>{catalog.actions[0]={...catalog.actions[0],digest:'c'.repeat(64)}}};
  host.render(<FlowsPanel threadId='a'/>);
`
async function setup(page: Page) {
  await mount(page, fixtureBody)
  await page.getByRole("button", { name: "表单演练", exact: true }).click()
}
const save = (page: Page) => page.getByRole("button", { name: "保存流程", exact: true })
const run = (page: Page) => page.getByRole("button", { name: "去这段聊天使用", exact: true })
const field = (page: Page, name: string) => page.getByLabel(`动作输入 · ${name}`, { exact: true })
const setting = (page: Page, name: string) =>
  page.getByLabel(`设置 动作输入 · ${name}`, { exact: true })
const saved = (page: Page) =>
  page.evaluate("window.fixture.calls.filter(c=>c[0]==='save').at(-1)?.[2]")

async function typedForms(page: Page) {
  await setup(page)
  await field(page, "文件路径").fill("src/order.ts")
  await setting(page, "数量").check()
  await field(page, "数量").fill("0")
  await setting(page, "启用标志").check()
  await field(page, "启用标志").selectOption("false")
  await setting(page, "备注").check()
  await field(page, "备注").fill("")
  await setting(page, "等级").check()
  const zero = await field(page, "等级")
    .locator("option")
    .evaluateAll((nodes) => {
      const match = nodes.find((node) => node.textContent?.trim() === "0") as
        | HTMLOptionElement
        | undefined
      return match?.value
    })
  assert.notEqual(zero, undefined)
  await field(page, "等级").selectOption(zero!)
  await page.getByLabel("设置 动作配置 · 严格模式", { exact: true }).check()
  await page.getByLabel("动作配置 · 严格模式", { exact: true }).selectOption("false")
  await save(page).click()
  await page.getByText("已保存修订 2，可开始运行。", { exact: true }).waitFor()
  const value = await saved(page)
  assert.deepEqual(value.steps[0].input, {
    path: "src/order.ts",
    extra: { nested: [0, false, ""] },
    limit: 0,
    enabled: false,
    label: "",
    choice: 0
  })
  assert.deepEqual(value.steps[0].config, { strict: false })
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  await page.getByRole("button", { name: "动作输入：JSON", exact: true }).click()
  assert.deepEqual(
    JSON.parse(await page.getByLabel("动作输入", { exact: true }).inputValue()),
    value.steps[0].input
  )
  await page.getByRole("button", { name: "动作输入：表单", exact: true }).click()
  await setting(page, "启用标志").uncheck()
  await save(page).click()
  await page.getByText("已保存修订 3，可开始运行。", { exact: true }).waitFor()
  assert.equal(Object.hasOwn((await saved(page)).steps[0].input, "enabled"), false)
  pass(
    "typed fields preserve false, zero, empty string, absent values and unknown nested data; save never executes"
  )
}

async function draftGuards(page: Page) {
  await setup(page)
  await run(page).waitFor({ state: "visible" })
  assert.equal(await run(page).isEnabled(), true)
  await page.getByRole("button", { name: "动作输入：JSON", exact: true }).click()
  await page.getByLabel("动作输入", { exact: true }).fill("{")
  assert.equal(await save(page).isDisabled(), true)
  assert.equal(await run(page).isDisabled(), true)
  assert.equal(await run(page).count(), 1, "One native entry owns use in chat")
  await run(page).evaluate(element => element.click())
  assert.deepEqual(await page.evaluate("window.fixture.navigation()"), [],
    "Invalid input cannot navigate or select a task through the consolidated entry")
  assert.equal(await page.evaluate("window.fixture.calls.some(c=>c[0]==='start'||c[0]==='save')"), false)
  await page.getByRole("button", { name: "配置步骤：独立检视", exact: true }).click()
  assert.equal(await save(page).isDisabled(), true)
  await page.getByRole("button", { name: "配置步骤：准备文件", exact: true }).click()
  assert.equal(await page.getByLabel("动作输入", { exact: true }).inputValue(), "{")
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByRole("button", { name: "表单演练", exact: true }).click()
  assert.equal(await page.getByLabel("动作输入", { exact: true }).inputValue(), "{")
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "表单演练", exact: true }).click()
  await field(page, "文件路径").waitFor()
  assert.equal(await field(page, "文件路径").inputValue(), "before.ts")
  assert.equal(await run(page).isEnabled(), true)
  assert.equal(
    await page.evaluate("window.fixture.calls.some(c=>c[0]==='start'||c[0]==='save')"),
    false
  )
  pass(
    "invalid-only JSON edits block the saved-step chat entry, survive step switches, reset only after explicit discard"
  )

  await setting(page, "数量").check()
  await field(page, "数量").fill("-")
  assert.equal(await save(page).isDisabled(), true)
  await page.getByRole("button", { name: "动作输入：JSON", exact: true }).click()
  assert.equal(await save(page).isDisabled(), true)
  await page.getByRole("button", { name: "动作输入：表单", exact: true }).click()
  assert.equal(await field(page, "数量").inputValue(), "-")
  await field(page, "数量").fill("2")
  await save(page).click()
  await page.getByText("已保存修订 2，可开始运行。", { exact: true }).waitFor()
  assert.equal((await saved(page)).steps[0].input.limit, 2)
  pass("unfinished numeric drafts cannot save previous values when changing editor modes")
}

async function sources(page: Page) {
  await setup(page)
  await page.getByRole("button", { name: "配置步骤：独立检视", exact: true }).click()
  assert.equal(await run(page).isEnabled(), true)
  const choices = page.getByLabel("输出来源路径", { exact: true })
  assert.equal(await choices.inputValue(), "/payload")
  await choices.selectOption("")
  await choices.selectOption("/payload")
  await page.getByLabel("任务目标", { exact: true }).fill("检视本次真实文件")
  await save(page).click()
  await page.getByText("已保存修订 2，可开始运行。", { exact: true }).waitFor()
  const value = await saved(page)
  assert.deepEqual(value.steps[1].input, {})
  assert.deepEqual(value.steps[1].inputFrom, { stepId: "prepare", path: "/payload" })
  pass(
    "object output path selected without writing JSON; required inputs may come from the preceding step"
  )

  await page.getByRole("button", { name: "配置步骤：准备文件", exact: true }).click()
  await page.evaluate("window.formsFixture.changeProvider()")
  await page.getByRole("button", { name: "刷新项目状态", exact: true }).click()
  await page.getByLabel("动作输入", { exact: true }).waitFor()
  assert.equal(await field(page, "文件路径").count(), 0)
  assert.equal(
    JSON.parse(await page.getByLabel("动作输入", { exact: true }).inputValue()).path,
    "before.ts"
  )
  pass("stale digest retains raw values and never borrows a same-name replacement schema")
}

async function visuals(page: Page) {
  await setup(page)
  const assets = join(root, "out/renderer/assets")
  if (existsSync(assets))
    for (const file of readdirSync(assets).filter((file) => file.endsWith(".css")))
      await page.addStyleTag({ path: join(assets, file) })
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.screenshot({ path: join(artifacts, "forms-light.png"), fullPage: true })
  await page.evaluate("document.documentElement.classList.add('dark')")
  await page.screenshot({ path: join(artifacts, "forms-dark.png"), fullPage: true })
  await page.setViewportSize({ width: 800, height: 960 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: join(artifacts, "forms-800.png"), fullPage: true })
  pass("light/dark screenshots and 800px layout without horizontal overflow")
}

async function disabledSteps(page: Page) {
  const disabled = {
    ...seed,
    steps: [{ ...seed.steps[0], enabled: false, input: {} }, seed.steps[2]]
  }
  await mount(
    page,
    `
    catalog.actions=${JSON.stringify([a, b])};
    definitions.set('a',[{definition:${JSON.stringify(disabled)},revision:1,digest:'disabled',updatedAt:1}]);
    host.render(<FlowsPanel threadId='a'/>);
  `
  )
  await page.getByRole("button", { name: "表单演练", exact: true }).click()
  assert.equal(
    await run(page).isEnabled(),
    true,
    "disabled incomplete actions must not invalidate an existing saved flow"
  )
  await page.getByRole("button", { name: "配置步骤：准备文件", exact: true }).click()
  await page.getByRole("button", { name: "动作输入：JSON", exact: true }).click()
  await page.getByLabel("动作输入", { exact: true }).fill("{")
  assert.equal(await run(page).isDisabled(), true)
  assert.equal(await save(page).isDisabled(), true)
  await page.getByLabel("动作输入", { exact: true }).fill("{}")
  await save(page).click()
  await page.getByText("已保存修订 2，可开始运行。", { exact: true }).waitFor()
  assert.equal((await saved(page)).steps[0].enabled, false)
  assert.deepEqual((await saved(page)).steps[0].input, {})
  pass(
    "disabled incomplete steps keep legacy semantics, while their unfinished raw drafts still block saving"
  )
}

async function scale(page: Page) {
  const large = {
    ...seed,
    steps: Array.from({ length: 64 }, (_, index) => ({ ...seed.steps[0], id: `step_${index}` }))
  }
  await mount(
    page,
    `
    catalog.actions=${JSON.stringify([a, b])};
    const render=value=>host.render(<FlowEditor value={value} catalog={catalog} disabled={false} onChange={render}/>);
    render(${JSON.stringify(large)});
  `
  )
  await field(page, "文件路径").waitFor()
  const samples: number[] = []
  for (let index = 0; index < 23; index++) {
    const started = performance.now()
    await field(page, "文件路径").fill(`src/file-${index}.ts`)
    assert.equal(await field(page, "文件路径").inputValue(), `src/file-${index}.ts`)
    if (index >= 3) samples.push(performance.now() - started)
  }
  samples.sort((left, right) => left - right)
  measurements.editor64Steps = {
    samples: samples.length,
    p50Ms: samples[Math.floor(samples.length / 2)],
    p95Ms: samples[Math.floor(samples.length * 0.95)],
    scope:
      "Local browser interactions including automation round-trip; no model, IPC or runtime performance claim"
  }
  pass("64-step schema form remains editable with 20 measured interactions")
}

async function main() {
  mkdirSync(artifacts, { recursive: true })
  const browser = await chromium.launch({
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }),
    headless: true
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    if (process.argv.includes("--disabled-only")) {
      await disabledSteps(page)
      assert.deepEqual(errors, [])
      return
    }
    await typedForms(page)
    await draftGuards(page)
    await sources(page)
    await disabledSteps(page)
    await visuals(page)
    await scale(page)
    assert.deepEqual(errors, [])
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify({ checks, errors, measurements }, null, 2)
    )
  } catch (error) {
    await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true })
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
