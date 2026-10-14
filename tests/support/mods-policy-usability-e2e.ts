import assert from "node:assert/strict"
import { build } from "esbuild"
import { join, resolve } from "node:path"
import type { Page } from "playwright"

/** Actual React lifecycle in Chromium, with deferred IPC to force a project-switch race. */
export async function verifyPolicyUsability(page: Page, pass: (name: string) => void) {
  const root = resolve(__dirname, "../..")
  const bundle = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
        import {createRoot} from "react-dom/client";
        import {FunctionCompletionPolicy} from ${JSON.stringify(join(root, "src/renderer/src/components/customize/FunctionCompletionPolicy.tsx"))};
        const base={mode:"off",scope:"diff",checks:["code-review"],maxRepairs:2,timeoutMs:120000,modelTokenBudget:8192};
        const policies={a:{...base,mode:"repair"},b:{...base,mode:"report"}};
        let release, releaseProbe, calls=[], ready=true, hold=false, fail=false, reads=0, probes=0;
        const listeners=new Set();
        window.api={mods:{
          completionPolicy:async id=>{reads++;return {source:"application",policy:policies[id]};},
          autobizEnvironment:async()=>{
            probes++;
            if(hold)await new Promise(resolve=>releaseProbe=resolve);
            if(fail)throw Error("环境检查失败");
            return {ready,source:"source",issues:ready?[]:["请安装 Python 3"],stageSupported:true};
          },
          setCompletionPolicy:async(id,plugin,policy)=>{
            calls.push({id,policy});
            if(id==="a")await new Promise(resolve=>release=resolve);
            policies[id]=policy;
            return {source:"application",policy};
          },
          onConfigurationChanged:fn=>{listeners.add(fn);return ()=>listeners.delete(fn)}
        }};
        const host=createRoot(document.getElementById("root"));
        window.fixture={
          switch(){host.render(<FunctionCompletionPolicy threadId="b" plugin="review" disabled={false}/>);},
          release(){release();}, calls(){return calls},
          missing(){ready=false},
          broadcast(){for(const fn of listeners)fn()},
          counts(){return {reads,probes}},
          hold(){hold=true},
          releaseProbe(){hold=false;releaseProbe()},
          fail(value){fail=value}
        };
        host.render(<FunctionCompletionPolicy threadId="a" plugin="review" disabled={false}/>);
      `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": join(root, "src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' }
  })
  await page.evaluate(() => {
    const frame = document.createElement("iframe")
    frame.id = frame.name = "mods-policy-usability"
    frame.srcdoc = '<html><body><div id="root"></div></body></html>'
    document.body.append(frame)
  })
  const frame = page.frameLocator("#mods-policy-usability")
  await frame.locator("#root").waitFor({ state: "attached" })
  const context = page.frame("mods-policy-usability")!
  try {
    await context.evaluate(bundle.outputFiles[0].text)
    await frame.locator("[data-completion-policy] > summary").waitFor()
    assert.deepEqual(await context.evaluate("window.fixture.counts()"), { reads: 0, probes: 0 })
    await frame.locator("[data-completion-policy] > summary").click()
    await frame.getByRole("button", { name: "只给检查报告", exact: true }).click()
    await context.evaluate("window.fixture.broadcast()")
    await context.waitForFunction("window.fixture.counts().reads === 2")
    assert.equal(await context.evaluate("window.fixture.counts().probes"), 0)
    await frame.locator("[data-completion-policy] > summary").click()
    await frame.locator("[data-completion-policy] > summary").click()
    assert.equal(await frame.getByLabel("完成模式", { exact: true }).inputValue(), "report")
    assert.equal(await context.evaluate("window.fixture.counts().reads"), 2)
    pass(
      "collapsed rules perform no IPC; ordinary reads and config broadcasts never probe; collapse preserves draft"
    )
    await frame.getByRole("button", { name: "保存项目规则", exact: true }).click()
    await context.waitForFunction("window.fixture.calls().length === 1")
    await context.evaluate("window.fixture.switch()")
    await frame.locator("[data-completion-policy] > summary").click()
    await frame.getByLabel("完成模式", { exact: true }).selectOption("check")
    await context.evaluate("window.fixture.release()")
    await context.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    )
    assert.equal(await frame.getByLabel("完成模式", { exact: true }).inputValue(), "check")
    assert.equal(await frame.getByRole("status").count(), 0)
    await frame.getByRole("button", { name: "保存项目规则", exact: true }).click()
    await frame.getByRole("status").waitFor()
    const calls = (await context.evaluate("window.fixture.calls()")) as Array<{
      id: string
      policy: { mode: string }
    }>
    assert.deepEqual(
      calls.map((call) => [call.id, call.policy.mode]),
      [
        ["a", "report"],
        ["b", "check"]
      ]
    )
    pass("delayed project A save cannot overwrite project B edits, status or subsequent save")

    await context.evaluate("window.fixture.hold()")
    await frame.getByRole("checkbox", { name: "Autobiz 业务验收", exact: true }).check()
    await context.waitForFunction("window.fixture.counts().probes === 1")
    assert(await frame.getByRole("button", { name: "保存项目规则", exact: true }).isDisabled())
    await frame.getByLabel("完成模式", { exact: true }).selectOption("off")
    assert(await frame.getByRole("button", { name: "保存项目规则", exact: true }).isEnabled())
    await frame.getByRole("button", { name: "保存项目规则", exact: true }).click()
    await frame.getByRole("status").waitFor()
    await context.evaluate("window.fixture.releaseProbe()")
    await frame.getByRole("button", { name: "检查 Autobiz 环境", exact: true }).waitFor()
    await frame.getByLabel("完成模式", { exact: true }).selectOption("check")
    await context.evaluate("window.fixture.fail(true)")
    await frame.getByRole("button", { name: "检查 Autobiz 环境", exact: true }).click()
    await frame.getByText("环境检查失败", { exact: false }).first().waitFor()
    assert(await frame.getByRole("button", { name: "保存项目规则", exact: true }).isDisabled())
    await frame.getByRole("button", { name: "只给检查报告", exact: true }).click()
    assert(await frame.getByRole("button", { name: "保存项目规则", exact: true }).isEnabled())
    await context.evaluate("window.fixture.fail(false)")
    pass(
      "pending and failed probes block active Autobiz but still allow turning rules off or choosing ordinary checks"
    )
    await context.evaluate("window.fixture.missing()")
    await frame.getByRole("button", { name: "检查 Autobiz 环境", exact: true }).click()
    await frame.getByText("请安装 Python 3", { exact: true }).waitFor()
    assert(
      await frame.getByRole("checkbox", { name: "Autobiz 业务验收", exact: true }).isDisabled()
    )
    await frame.getByRole("button", { name: "修复后再完成", exact: true }).click()
    assert.equal(await frame.getByLabel("完成模式", { exact: true }).inputValue(), "repair")
    assert(await frame.getByRole("checkbox", { name: "单元测试", exact: true }).isChecked())
    assert(await frame.getByRole("button", { name: "保存项目规则", exact: true }).isEnabled())
    await frame.locator("[data-completion-budgets] > summary").click()
    assert.equal(
      await frame.getByLabel("模型总预算（tokens）", { exact: true }).inputValue(),
      "8192"
    )
    pass(
      "missing Autobiz dependencies disable its selection while ordinary repair template preserves budgets"
    )
  } finally {
    await page.locator("#mods-policy-usability").evaluate((node) => node.remove())
  }
}
