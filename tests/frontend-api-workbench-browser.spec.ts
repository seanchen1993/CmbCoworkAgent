/** Actual Guest/Pane receipts connected to the production renderer; model run is controlled. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"
import { createFrontendWorkbenchFixture } from "./support/frontend-api-workbench-fixture"

async function main() {
  const output = resolve("output/frontend-api-workbench-browser")
  mkdirSync(output, { recursive: true })
  const f = await createFrontendWorkbenchFixture()
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1080, height: 950 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const server = spawn(
    process.execPath,
    [resolve("examples/frontend-api-workbench/demo/server.cjs")],
    {
      env: { ...process.env, WORKBENCH_DEMO_PORT: "0" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  )
  try {
    const base = await new Promise<string>((yes, no) => {
      let text = ""
      const timer = setTimeout(() => no(Error("Demo server did not start")), 10000)
      server.once("error", (error) => {
        clearTimeout(timer)
        no(error)
      })
      server.once("exit", () => {
        clearTimeout(timer)
        no(Error("Demo server exited"))
      })
      server.stdout.on("data", (chunk) => {
        text += String(chunk)
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(text)
        if (match) {
          clearTimeout(timer)
          yes(match[0])
        }
      })
    })
    await f.session.run("api-workbench", "")
    await page.exposeFunction("readWorkbench", () => f.snapshot())
    await page.exposeFunction(
      "actWorkbench",
      async (key: string, kind: "press" | "change", value?: string) => {
        await f.action(await f.snapshot(), key, kind, value)
        return f.snapshot()
      }
    )
    await mount(
      page,
      `
      import {Element} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionPanes.tsx"))};
      function Workbench() {
        const [pane,setPane]=useState(null),[busy,setBusy]=useState(false);
        useEffect(()=>{window.readWorkbench().then(setPane)},[]);
        window.refreshWorkbench=()=>window.readWorkbench().then(setPane);
        return <main style={{maxWidth:780,margin:'24px auto',padding:16}}>
          {pane&&<Element node={pane.tree} busy={busy} act={async(node,kind,value)=>{
            if(kind!=="change")setBusy(true);
            try{const next=await window.actWorkbench(node.props.key,kind,value);if(kind!=="change")setPane(next)}finally{setBusy(false)}
          }}/>}</main>
      }
      window.showLegacyInput=()=>host.render(<Element busy={false}
        node={{type:'Input',props:{key:'legacy',label:'原有输入',value:''},press:{plugin:'legacy',handle:1}}}
        act={async(node,kind,value)=>{window.legacyInputResult={kind,value}}}/>);
      host.render(<Workbench/>);
    `,
      [browserWorkerPlugin()]
    )
    const renderer = resolve("src/renderer/src")
    const css = await compile(readFileSync(resolve(renderer, "index.css"), "utf8"), {
      base: renderer,
      onDependency: () => undefined
    })
    const candidates = new Scanner({}).scanFiles(
      ["components/chat/FunctionPanes.tsx", "components/ui/button.tsx"].map((file) => ({
        content: readFileSync(resolve(renderer, file), "utf8"),
        extension: "tsx"
      }))
    )
    await page.addStyleTag({ content: css.build(candidates) })
    const start = page.getByRole("button", { name: "补齐代码并联调", exact: true })
    await start.waitFor()
    assert.equal(await page.getByRole("button", { name: "提交", exact: true }).count(), 0)
    await page.getByRole("button", { name: "补充需求（可选）", exact: true }).click()
    const fill = async (label: string, value: string) => {
      await page.getByRole("textbox", { name: label, exact: true }).fill(value)
      await page.waitForFunction(() => !document.querySelector("button:disabled"))
    }
    await fill("源码目录", "/workbench-fixture/source")
    await fill("页面地址", "0.0.0.11")
    await start.click()
    await page.getByText("页面地址需要以", { exact: false }).waitFor()
    assert.equal(f.facts().toolLists, 0)
    await fill("页面地址", base + "/orders")
    await fill(
      "接口文档",
      "GET /api/orders\n响应字段 totalAmountCents 的单位是分。\n期望显示 129.00 元。"
    )
    await fill("本次需求", "金额显示 0，请核对字段与单位。")
    assert.equal(f.queue.size, 0, "Editing does not run a task")
    for (const width of [1080, 380]) {
      await page.setViewportSize({ width, height: 950 })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({ path: resolve(output, `workbench-${width}.png`), fullPage: true })
    }
    await start.click()
    await page.getByRole("button", { name: "正在提交，请勿重复点击…" }).waitFor()
    assert.equal(f.queue.size, 1)
    assert.equal(f.runs.length, 0, "Busy chat must not be preempted")
    await page.getByRole("button", { name: "正在提交，请勿重复点击…" }).click()
    assert.equal(f.queue.size, 1, "Repeated clicks do not enqueue another task")
    f.idle()
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await page.evaluate("window.refreshWorkbench()")
      if ((await page.locator("main").textContent())?.includes("提交已处理")) break
      await new Promise((done) => setTimeout(done, 20))
    }
    assert.match(await page.locator("main").innerText(), /提交已处理/)
    assert.equal(f.runs.length, 1)
    assert.match(String(f.runs[0].text), /totalAmountCents/)
    assert.match(String(f.runs[0].text), /这个聊天当前选择的模型/)
    assert.equal((f.runs[0].origin as { asUser?: boolean }).asUser, true)
    await page.setViewportSize({ width: 1080, height: 950 })
    await page.screenshot({ path: resolve(output, "workbench-started.png"), fullPage: true })
    await page.evaluate("window.showLegacyInput()")
    await page.getByRole("textbox", { name: "原有输入", exact: true }).fill("保留原有行为")
    await page.getByRole("button", { name: "提交", exact: true }).click()
    assert.deepEqual(await page.evaluate("window.legacyInputResult"), {
      kind: "submit",
      value: "保留原有行为"
    })

    // The supplied demo is an actual served page, deliberately containing a field mapping bug.
    const demo = await browser.newPage()
    await demo.goto(base + "/orders")
    await demo.getByText("已加载 3 条订单").waitFor()
    assert.equal(await demo.getByTestId("order-amount").first().innerText(), "0.00")
    const api = await (await demo.request.get(base + "/api/orders")).json()
    assert.equal(api.orders[0].totalAmountCents, 12900)
    assert.match(await (await demo.request.get(base + "/api-docs")).text(), /129.00/)
    await demo.screenshot({ path: resolve(output, "demo-orders.png"), fullPage: true })
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          errors,
          widths: [1080, 380],
          duplicateSubmissions: 0,
          realGuestAndRenderer: true,
          demoApiAmountCents: 12900,
          demoVisibleAmount: "0.00",
          limits:
            "Controlled current-chat run boundary; no live model or Electron in-app-browser MCP call in this test."
        },
        null,
        2
      ) + "\n"
    )
    console.log(
      "PASS actual workbench Guest + renderer, input/start/error state, duplicate prevention and real demo page"
    )
  } finally {
    server.kill()
    await browser.close()
    await f.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
