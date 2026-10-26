/** Actual React/Radix reader with bundled Markdown, no model, network, or business IPC. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output/sparks-audit-20261010", `documentation-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const reader = resolve("src/renderer/src/components/customize/SparksDocumentationLink.tsx")
  const imageComponent = resolve("src/renderer/src/components/customize/SparksDocumentationImage.tsx")
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(), loader: "tsx", contents: `
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {SparksDocumentationLink} from ${JSON.stringify(reader)};
      import {SparksDocumentationImage} from ${JSON.stringify(imageComponent)};
      window.calls=[];window.failExternal=false;
      window.electron={openExternal:async url=>{window.calls.push(url);if(window.failExternal)throw Error('offline')}};
      function Fixture(){const[draft,setDraft]=useState('尚未保存的灵件需求');return <><input aria-label='原草稿' value={draft} onChange={e=>setDraft(e.target.value)}/><SparksDocumentationLink/></>}
      const root=createRoot(document.getElementById('root'));root.render(<Fixture/>);
      window.renderImageChecks=()=>root.render(<div>
        {['https://example.invalid/tracker.png','//example.invalid/tracker.png','file:///private.png',
          'data:image/svg+xml,<svg/>','../assets/current-assistant-run.png',
          'assets/current-assistant-run.png?remote=1','assets/%2e%2e/private.png',
          'assets/missing.png','__proto__','constructor'].map(src=><SparksDocumentationImage key={src} src={src} alt='被阻止的图片'/>)}
        <SparksDocumentationImage src='assets/current-assistant-run.png'/>
      </div>);`
    },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    plugins: [{ name: "external-reference-failure-fixture", setup(builder) {
      builder.onLoad({ filter: /[\\/]docs[\\/]sparks[\\/]reference\.md$/ }, (args) => ({
        contents: readFileSync(args.path, "utf8") +
          "\n[测试外部参考](https://example.invalid/documentation-reference)\n",
        loader: "text"
      }))
    } }],
    alias: { "@": resolve("src/renderer/src") }, loader: { ".md": "text", ".png": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors: string[] = [], requests: string[] = [], checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => { requests.push(route.request().url()); return route.abort() })
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const assets = resolve(process.env.SPARKS_BROWSER_BUILD ?? "out", "renderer/assets")
    const css = existsSync(assets) ? readdirSync(assets).find((name) => /^index-.*\.css$/.test(name)) : undefined
    if (css) await page.addStyleTag({ path: join(assets, css) })
    await page.getByRole("link", { name: /官方说明/ }).click()
    await page.getByRole("dialog", { name: "DevClaw Sparks 官方说明" }).waitFor()
    assert.equal(await page.getByRole("navigation", { name: "说明章节" }).getByRole("button").count(), 16)
    assert.deepEqual(await page.evaluate("window.calls"), [])
    checks.push("All sixteen bundled chapters open without network or business IPC")
    const overview = await page.getByRole("article").innerText()
    assert.match(overview, /聊天中的唯一输入框/)
    assert.match(overview, /普通模式/)
    assert.match(overview, /发送消息/)
    assert.match(overview, /无需先配置模块或任务方案/)
    assert.match(overview, /确认并应用到这段聊天/)
    assert.match(overview, /已保存或绑定的 Flow 不会自动启动/)
    assert.match(overview, /成功启动后恢复普通发送/)
    assert.match(overview, /预检失败会保留输入和选择/)
    assert.match(overview, /任务进展/)
    assert.match(overview, /高级：为下一条消息使用预设任务/)
    assert.doesNotMatch(overview, /开始流程|准备首次任务|其他记录|任务详情|命令与日志|按此步骤执行/)
    checks.push("Offline guidance starts with ordinary send and creator approval; saved plans remain advanced and explicit, with real task-card results")
    const overviewImage = page.getByRole("img", { name: "聊天任务卡中的进度与确认", exact: true })
    await overviewImage.scrollIntoViewIfNeeded()
    await overviewImage.evaluate((image: HTMLImageElement) => image.decode())
    assert.ok(await overviewImage.evaluate((image: HTMLImageElement) => image.naturalWidth >= 300))
    await page.screenshot({ path: join(output, "offline-overview-image.png") })
    await overviewImage.dispatchEvent("error")
    await page.getByRole("img", { name: /聊天任务卡中的进度与确认.*图片无法显示/ }).waitFor()
    assert.equal(await page.getByRole("article").locator("img").count(), 0)
    await page.getByRole("navigation").getByRole("button", { name: "排障与限制", exact: true }).click()
    const troubleshootingImage = page.getByRole("img", { name: /本阶段运行过程：显示/ })
    await troubleshootingImage.scrollIntoViewIfNeeded()
    await troubleshootingImage.evaluate((image: HTMLImageElement) => image.decode())
    assert.ok(await troubleshootingImage.evaluate((image: HTMLImageElement) => image.naturalWidth > 1000))
    await page.getByRole("navigation").getByRole("button", { name: "概览", exact: true }).click()
    await overviewImage.scrollIntoViewIfNeeded()
    await overviewImage.evaluate((image: HTMLImageElement) => image.decode())
    checks.push("Both reviewed screenshots render offline with alt text; failed images show a readable placeholder and can reload after navigation")
    await page.getByRole("article").getByRole("link", { name: "项目能力", exact: true }).click()
    await page.getByRole("heading", { name: "内置功能与项目模式", exact: true }).waitFor()
    for (const name of ["项目会话标题栏的项目能力入口", "窄屏下的项目能力选择面板"]) {
      const image = page.getByRole("img", { name, exact: true })
      await image.scrollIntoViewIfNeeded()
      await image.evaluate((element: HTMLImageElement) => element.decode())
      assert.ok(await image.evaluate((element: HTMLImageElement) => element.naturalWidth > 300))
    }
    assert.equal(await page.getByRole("article").getByRole("img", { name: /图片无法显示/ }).count(), 0)
    await page.screenshot({ path: join(output, "project-composition-guide-images.png") })
    checks.push("Both project composition guide images load from bundled assets without fallback")
    const libraryImage = page.getByRole("img", { name: /成果与经验的交付详情/ })
    await libraryImage.scrollIntoViewIfNeeded()
    await libraryImage.evaluate((image: HTMLImageElement) => image.decode())
    assert.ok(await libraryImage.evaluate((image: HTMLImageElement) => image.naturalWidth > 1000))
    checks.push("New project deliverable screenshot renders from a bundled asset in the user guide")
    await page.getByRole("article").getByRole("link", { name: "制作项目模板", exact: true }).first().click()
    await page.getByRole("heading", { name: "只写技能和节点，制作自己的项目插件", exact: true }).waitFor()
    await page.getByRole("article").getByRole("link", { name: "返回概览", exact: true }).click()
    checks.push("Project platform and authoring chapters are linked offline with honest version and recovery boundaries")
    const addedChapters = [
      ["插件创造与使用", "插件创造、转换、组合与使用说明"],
      ["业务 Mods 组装", "业务 Mods 组装与执行适配"],
      ["试用与版本恢复", "制作、真实试用与版本恢复"],
      ["阶段调试扩展", "第三方阶段调试 Mod 接入协议"],
      ["AutoBiz 组合示例", "AutoBiz 项目组合示例"]
    ]
    for (const [chapter, heading] of addedChapters) {
      await page.getByRole("navigation").getByRole("button", { name: chapter, exact: true }).click()
      await page.getByRole("article").getByRole("heading", { name: heading, exact: true }).waitFor()
      assert.equal(await page.locator('button[aria-current="page"]').textContent(), chapter)
    }
    await page.getByRole("navigation").getByRole("button", { name: "概览", exact: true }).click()
    await page.getByRole("article").getByRole("link", { name: "业务 Mods 组装与执行适配", exact: true }).click()
    await page.getByRole("article").getByRole("heading", { name: "业务 Mods 组装与执行适配", exact: true }).waitFor()
    await page.getByRole("navigation").getByRole("button", { name: "概览", exact: true }).click()
    await page.getByRole("article").getByRole("link", { name: "插件制作、试用、验收与保存", exact: true }).click()
    await page.getByRole("article").getByRole("heading", { name: "插件创造、转换、组合与使用说明", exact: true }).waitFor()
    await page.getByRole("navigation").getByRole("button", { name: "概览", exact: true }).click()
    checks.push("Five complete creator, assembly, lifecycle, recovery and AutoBiz guides are reachable through real bundled chapter entries and overview links")
    await page.getByRole("article").getByRole("link", { name: "查看完整操作示例", exact: true }).click()
    await page.getByRole("heading", { name: "从已有插件创建与组合", exact: true }).waitFor()
    assert.equal(await page.getByRole("article").locator("pre").count(), 3)
    await page.getByRole("heading", { name: "例四：选择 AutoBiz 原流程节点", exact: true }).waitFor()
    await page.getByRole("textbox", { name: "搜索说明章节" }).fill("hello-spark")
    await page.getByRole("navigation").getByRole("button", { name: "插件开发入门", exact: true }).waitFor()
    await page.getByRole("textbox", { name: "搜索说明章节" }).fill("")
    await page.getByRole("navigation").getByRole("button", { name: "概览", exact: true }).click()
    checks.push("Beginner cookbook includes copyable examples, Hook reuse guidance, search and return navigation")
    await page.getByRole("article", { name: "说明正文" }).getByRole("link", { name: "创建与修改", exact: true }).click()
    await page.getByRole("heading", { name: "创建与修改灵件", exact: true }).waitFor()
    assert.equal(await page.locator('button[aria-current="page"]').textContent(), "创建与修改")
    await page.getByRole("button", { name: "下一章", exact: true }).click()
    await page.getByRole("heading", { name: "绘制界面", exact: true }).waitFor()
    await page.getByRole("button", { name: "上一章", exact: true }).click()
    await page.getByRole("heading", { name: "创建与修改灵件", exact: true }).waitFor()
    checks.push("Inline chapter links and previous/next remain in the reader")
    await page.getByRole("textbox", { name: "搜索说明章节" }).fill("ToolResult")
    assert.ok(await page.getByRole("navigation").getByRole("button").count() > 0)
    await page.getByRole("textbox", { name: "搜索说明章节" }).fill("NO_SUCH_SPARKS_CHAPTER")
    await page.getByText("找到 0 个章节", { exact: true }).waitFor()
    await page.getByRole("textbox", { name: "搜索说明章节" }).fill("")
    checks.push("Chapter search covers document body and has a clear empty state")
    await page.getByRole("navigation").getByRole("button", { name: "开发参考", exact: true }).click()
    assert.equal(await page.getByRole("article").locator('a[href*="src/main"]').count(), 0)
    await page.evaluate("window.failExternal=true")
    await page.getByRole("article").getByRole("link", { name: "测试外部参考", exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.deepEqual(await page.evaluate("window.calls"), ["https://example.invalid/documentation-reference"])
    assert.equal(await page.getByRole("dialog").isVisible(), true)
    checks.push("Repository paths cannot navigate the app; external failures preserve offline reading")
    await page.getByRole("navigation").getByRole("button", { name: "安装与复用", exact: true }).click()
    if (css) {
      assert.equal(await page.getByRole("article").locator("ol").first().evaluate((element) => getComputedStyle(element).listStyleType), "decimal")
      assert.ok(await page.getByRole("article").locator("h1").evaluate((element) => parseFloat(getComputedStyle(element).fontSize)) >= 20)
    }
    await page.screenshot({ path: join(output, "desktop-reader.png") })
    await page.setViewportSize({ width: 420, height: 780 })
    await page.getByRole("navigation").getByRole("button", { name: "概览", exact: true }).click()
    await page.getByRole("article").evaluate((element) => { element.scrollTop = 600 })
    await page.getByRole("navigation").getByRole("button", { name: "创建与修改", exact: true }).click()
    await page.waitForFunction(() => document.querySelector('article')?.scrollTop === 0)
    await page.screenshot({ path: join(output, "narrow-reader.png") })
    checks.push("Chapter changes reset reading position; narrow layout remains operable")
    await page.keyboard.press("Escape")
    await page.getByRole("dialog").waitFor({ state: "detached" })
    assert.equal(await page.getByRole("textbox", { name: "原草稿" }).inputValue(), "尚未保存的灵件需求")
    await page.getByRole("link", { name: /官方说明/ }).click()
    await page.getByRole("heading", { name: "DevClaw Sparks 官方说明", exact: true }).first().waitFor()
    checks.push("Escape closes the reader, preserves the editor draft, and allows reopening")
    const docs = resolve("docs/sparks")
    const expectedImages = readdirSync(docs).filter((name) => name.endsWith(".md"))
      .reduce((count, name) => count + [...readFileSync(join(docs, name), "utf8").matchAll(/!\[[^\]]*\]\([^)]+\)/g)].length, 0)
    const chapters = await page.getByRole("navigation", { name: "说明章节" }).getByRole("button").allTextContents()
    let loadedImages = 0
    for (const chapter of chapters) {
      await page.getByRole("navigation").getByRole("button", { name: chapter, exact: true }).click()
      const article = page.getByRole("article")
      assert.doesNotMatch(await article.innerText(), /claude[\s-]*code/iu, chapter)
      assert.equal(await article.getByRole("img", { name: /图片无法显示/ }).count(), 0, chapter)
      for (const image of await article.locator("img").all()) {
        await image.scrollIntoViewIfNeeded()
        await image.evaluate((element: HTMLImageElement) => element.decode())
        assert.ok(await image.evaluate((element: HTMLImageElement) => element.naturalWidth > 0), chapter)
        loadedImages++
      }
    }
    assert.equal(loadedImages, expectedImages, "Every documentation image reference must render offline")
    checks.push(`All ${loadedImages} Markdown image references render across all bundled chapters`)
    await page.evaluate("window.renderImageChecks()")
    await page.getByRole("img", { name: "说明配图", exact: true }).waitFor()
    assert.equal(await page.getByRole("img", { name: "被阻止的图片（图片无法显示）", exact: true }).count(), 10)
    assert.equal(await page.locator("img").count(), 1)
    await page.getByRole("img", { name: "说明配图", exact: true }).evaluate((image: HTMLImageElement) => image.decode())
    checks.push("Remote, data, file, traversal, query, missing and prototype sources never become image requests; missing alt receives an accessible description")
    assert.deepEqual(errors, [])
    assert.deepEqual(requests, [])
    writeFileSync(join(output, "result.json"), JSON.stringify({ checks, errors, requests }, null, 2))
    console.log(JSON.stringify({ output, checks }, null, 2))
  } catch (error) {
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {})
    throw error
  } finally { await browser.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
