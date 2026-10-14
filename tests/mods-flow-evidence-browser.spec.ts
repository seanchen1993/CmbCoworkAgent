/** Real renderer interaction; scoped storage and IPC are covered by separate regressions. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve("output", "mods-harness-20261009", `evidence-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 } })
  const errors: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(
      page,
      `
      let finish,fail; const reads=[];
      const view=runId=>({schemaVersion:1,runId,sourceDigest:'a'.repeat(64),currentArtifacts:'not-rechecked',partial:true,omittedAttempts:1,
        lineage:{state:'linked',rootRunId:'original',parentRunId:'original',resumeCount:1},attempts:[
        {executionId:'model',stepId:'review',source:'agent',status:'passed',historicalValidity:'settled',reusedFrom:{runId:'original',executionId:'first',state:'linked'},receipt:{state:'recorded',coverage:'prompt-and-prior-receipts',originRunId:'original',modelCalls:2},checks:[],omittedChecks:0},
        {executionId:'test',stepId:'test',source:'native-check',status:'passed',historicalValidity:'invalidated',receipt:{state:'absent'},checks:[{id:'native',state:'found',kind:'native-project-test',status:'pass',check:'unit-test'},{id:'opinion',state:'found',kind:'plugin-opinion',status:'pass'},{id:'missing',state:'missing',kind:'unknown'},{id:'limited',state:'limited',kind:'unknown'}],omittedChecks:2},
        {executionId:'approval',stepId:'approve',source:'approval',status:'waiting',historicalValidity:'unsettled',receipt:{state:'absent'},checks:[],omittedChecks:0}]});
      window.api.mods.flowEvidence=(threadId,runId)=>{reads.push([threadId,runId]);return new Promise((resolve,reject)=>{finish=()=>resolve(view(runId));fail=()=>reject(Error('PRIVATE_PROVIDER_CONTENT'))})};
      const show=id=>host.render(<FlowRunView run={{id,threadId:'a',workspace:'a',flow:saved('a'),status:'interrupted',startedAt:1,epoch:0,attempts:[],failureCounts:{}}} busy={false} onCancel={()=>{throw Error('must not cancel')}} onDecide={()=>{throw Error('must not decide')}}/>);
      window.evidenceFixture={show,reads,finish:()=>finish(),fail:()=>fail()};show('first');
    `
    )
    const css = readdirSync(resolve("out/renderer/assets")).find((name) =>
      /^index-.*\.css$/.test(name)
    )
    assert(css)
    await page.addStyleTag({ path: resolve("out/renderer/assets", css) })
    await page.getByRole("button", { name: "展开历史证据" }).waitFor()
    assert.deepEqual(await page.evaluate("window.evidenceFixture.reads"), [])
    checks.push("Opening run history starts no evidence query, preparation, or execution")
    await page.getByRole("button", { name: "展开历史证据" }).click()
    assert(await page.getByRole("button", { name: "正在读取证据…" }).isDisabled())
    await page.evaluate("window.evidenceFixture.show('second')")
    await page.getByRole("button", { name: "展开历史证据" }).waitFor()
    await page.evaluate("window.evidenceFixture.finish()")
    assert.equal(await page.getByRole("list", { name: "历史执行证据列表" }).count(), 0)
    checks.push("Late evidence from another selected run is discarded")
    await page.getByRole("button", { name: "展开历史证据" }).click()
    await page.evaluate("window.evidenceFixture.finish()")
    await page.getByRole("list", { name: "历史执行证据列表" }).waitFor()
    assert(await page.getByText(/当前文件与权限未重新核验/).isVisible())
    assert(await page.getByText(/逻辑模型调用 2 次，不代表网络请求总数/).isVisible())
    assert(await page.getByText(/宿主项目测试 · 已关联历史记录 · 历史结果：通过/).isVisible())
    assert(await page.getByText(/插件意见 · 已关联历史记录 · 历史结果：通过/).isVisible())
    assert(await page.getByText("approve · 人工确认", { exact: true }).isVisible())
    assert(await page.getByText(/复用来源：original/).isVisible())
    assert(await page.getByText(/证据类型未确认 · 记录缺失/).isVisible())
    assert(await page.getByText(/记录超出读取上限/).isVisible())
    checks.push(
      "Model, native test, plugin opinion, approval, copied source and missing coverage remain distinct"
    )
    await page.screenshot({ path: join(output, "evidence-desktop.png"), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    assert(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
    await page.screenshot({ path: join(output, "evidence-narrow.png"), fullPage: true })
    checks.push("Narrow evidence layout stays within viewport")
    await page.getByRole("button", { name: "展开历史证据" }).click()
    await page.evaluate("window.evidenceFixture.fail()")
    await page.getByText("无法读取此运行的证据，请刷新后重试。", { exact: true }).waitFor()
    assert.equal(await page.getByText("PRIVATE_PROVIDER_CONTENT").count(), 0)
    checks.push("Errors are fixed public diagnostics without raw provider content")
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify({ passed: true, checks, errors }, null, 2)
    )
    console.log(JSON.stringify({ passed: true, checks, artifacts: output }))
  } catch (error) {
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true })
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
