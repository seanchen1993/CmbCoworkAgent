/** Reproducible teaching screenshots, using real UI renderers with clearly labelled fixture data. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "../tests/support/browser-worker-plugin.mjs"

async function main() {
  const renderer = resolve("src/renderer/src")
  const target = resolve("src/renderer/src/assets/guides")
  mkdirSync(target, { recursive: true })
  const cssPath = join(renderer, "index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency: () => undefined
  })
  const contents = `
import React from 'react';import{createRoot}from'react-dom/client';
import{Button}from'@/components/ui/button';
import{Element}from'@/components/chat/FunctionPanes';
import{NativeProjectChatGuide}from'@/components/harness-board/NativeProjectChatGuide';
import{NativeProjectChatGuideContext,NativeProjectChatPresence}from'@/components/harness-board/native-project-chat-context';
import{releaseExamples}from'@/components/guides/release-guide-content';
const kind=new URL(location.href).searchParams.get('kind'),project=kind.startsWith('project'),result=kind.endsWith('result');
const example=releaseExamples[project?1:0];
const tree={type:'Box',props:{padding:2,gap:2,flexDirection:'row',borderStyle:'round'},children:[
 {type:'Box',props:{flexDirection:'column',gap:1},children:[{type:'Text',props:{bold:true},children:['上海 · 晴 22°C']},{type:'Text',props:{dimColor:true},children:['天气 · 最近更新 10:30']}]},
 {type:'Box',props:{flexDirection:'column',gap:1},children:[{type:'Text',props:{bold:true},children:['10:30:25']},{type:'Text',props:{dimColor:true},children:['北京时间 · 每秒更新']}]},
 {type:'Box',props:{flexDirection:'column',gap:1},children:[{type:'Text',props:{bold:true},children:['输入 8,420 · 输出 1,760']},{type:'Text',props:{dimColor:true},children:['本聊天 Token · 示例统计']}]}]};
const guide={stage:'需求3.0转换',plugin:'project-requirements-v3',version:'1.0.0',action:'start',message:'核对项目设置后，填写完整需求并启动。普通讨论不会自动推进阶段。',userGuide:'请准备需求3.0原文，并确认转换规则。此阶段完成后，转换结果交给原来的需求阶段。',route:'需求3.0转换 → 确认需求基线 → 需求与验收定义 → 设计与实施方案 → 代码验证与合并 → 交付准备与归档'};
window.actions=0;
createRoot(document.getElementById('root')).render(<div className="flex h-full flex-col bg-background text-foreground">
 <header className="flex items-center justify-between border-b px-8 py-5"><div className="flex items-center gap-3"><span className="rounded-lg bg-primary px-3 py-1 font-semibold text-primary-foreground">DevClaw</span><span className="text-sm text-muted-foreground">{project&&result?'项目模式 · 新特性':'对话模式'}</span></div><span className="rounded-full border bg-muted/30 px-3 py-1 text-sm">{result?'应用效果示例':'创造者模式'}</span></header>
 <main className="flex min-h-0 flex-1 flex-col px-12 py-8">
 {!result?<><p className="mb-5 text-xs text-muted-foreground">先描述需求，再核对试用版本</p><div className="ml-auto max-w-3xl rounded-2xl bg-muted p-6 text-lg leading-8">{example.prompt}</div><p className="mt-6 text-sm text-muted-foreground">继续在同一对话补充细节，满意后再确认应用。</p></>:project?<NativeProjectChatPresence.Provider value={true}><NativeProjectChatGuideContext.Provider value={{threadId:'demo',guide,actionLabel:'前往项目设置',disabled:false,onAction:()=>window.actions++}}><NativeProjectChatGuide threadId="demo" renderMarkdown={text=><p className="rounded-lg border bg-muted/30 p-4 leading-7">{text}</p>}>{null}</NativeProjectChatGuide></NativeProjectChatGuideContext.Provider></NativeProjectChatPresence.Provider>:<><div className="flex-1"><h2 className="text-xl font-semibold">我的聊天工作台</h2><p className="mt-3 text-sm text-muted-foreground">信息条就在聊天框上方，日常聊天照常使用。</p></div><div className="mb-4 rounded-xl border bg-muted/20 p-4"><Element node={tree} busy={false} act={async()=>{window.actions++}}/></div></>}
 <div className="mt-auto rounded-2xl border bg-background p-5 shadow-sm"><p className="min-h-10 text-sm text-muted-foreground">{result?'输入你的问题，继续聊天…':'描述你希望助手增加或调整的功能…'}</p><div className="mt-3 flex justify-between text-xs text-muted-foreground"><span>本地工作目录</span><span>{result?'普通聊天':'创造者模式'} ↑</span></div></div>
 </main><footer className="flex justify-between border-t px-8 py-3 text-xs text-muted-foreground"><span>界面示例 · 不代表业务已执行</span><span>{project?'新增阶段，原项目流程继续使用':'天气、时间与 Token 为教学示例数据'}</span></footer>
</div>);
`
  const candidates = new Scanner({}).scanFiles([
    { content: contents, extension: "tsx" },
    ...[
      "components/harness-board/NativeProjectChatGuide.tsx",
      "components/chat/FunctionPanes.tsx",
      "components/ui/button.tsx"
    ].map((path) => ({ content: readFileSync(join(renderer, path), "utf8"), extension: "tsx" }))
  ])
  const script = await build({
    stdin: { contents, loader: "tsx", resolveDir: process.cwd() },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": renderer },
    loader: { ".png": "dataurl", ".md": "text" },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": "{}",
      "import.meta.hot": "undefined"
    },
    plugins: [browserWorkerPlugin()]
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const outputs: string[] = []
  try {
    for (const kind of ["status-request", "status-result", "project-request", "project-result"]) {
      const page = await browser.newPage({
        viewport: { width: 1100, height: 650 },
        deviceScaleFactor: 1
      })
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.route("http://guide.local/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<html lang="zh-CN"><meta charset="utf-8"><body><div id="root" style="height:100vh"></div></body></html>'
        })
      )
      await page.goto(`http://guide.local/?kind=${kind}`)
      await page.addStyleTag({ content: compiler.build(candidates) })
      await page.addScriptTag({ content: script.outputFiles[0].text })
      await page.getByText("界面示例 · 不代表业务已执行", { exact: true }).waitFor()
      if (kind === "project-result") await page.getByText("查看项目流程", { exact: true }).click()
      assert.deepEqual(errors, [])
      assert.equal(await page.evaluate("window.actions"), 0)
      if (kind === "status-result") {
        const spacing = await page
          .locator("[data-function-hover-target]")
          .first()
          .evaluate((node) => ({
            gap: getComputedStyle(node).gap,
            padding: getComputedStyle(node).padding
          }))
        assert.deepEqual(spacing, { gap: "16px", padding: "16px" })
      }
      const path = join(target, `release-${kind}.png`)
      await page.screenshot({ path })
      outputs.push(path)
      await page.close()
    }
  } finally {
    await browser.close()
  }
  mkdirSync("output", { recursive: true })
  writeFileSync(
    "output/release-guide-images.json",
    JSON.stringify(
      {
        outputs,
        source:
          "Real FunctionPanes.Element and NativeProjectChatGuide renderers; teaching frame and fixture data, labelled on each image",
        executions: 0
      },
      null,
      2
    )
  )
  console.log(JSON.stringify({ outputs }))
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
