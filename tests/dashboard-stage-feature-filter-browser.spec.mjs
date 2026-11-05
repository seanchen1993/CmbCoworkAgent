import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"

const renderer = resolve("src/renderer/src")
const output = resolve("output/project-execution")
mkdirSync(output, { recursive: true })
const css = await compile(
  readFileSync(join(renderer, "index.css"), "utf8").replace(/^@import "@fontsource[^\n]+\n/gm, ""),
  { base: renderer, onDependency: () => undefined }
)
const scanner = new Scanner({
  sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
})
const bundle = await build({
  stdin: {
    resolveDir: renderer,
    loader: "tsx",
    contents: `
    import React, { useCallback, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { ProjectStageAnalysisDialog } from './components/dashboard/ProjectStageAnalysisDialog';
    const calls = []; const pending = new Map();
    window.stageQA = { calls, finish: key => pending.get(key)?.() };
    function result(key) {
      const metrics = { conversationCount: 10, totalDurationMs: 120000, avgDurationMs: 12000, p95DurationMs: 15000,
        runCost: { toolCalls: 30, modelCalls: 20, totalTokens: 30000, inputTokens: 25000, outputTokens: 5000, userInputRequests: 0, userInputRequestDocs: 10 } };
      return { projectId: 'p', total: metrics, stages: [{ nodeName: key, group: 'Dev', metrics }] };
    }
    function App() {
      const [room, setRoom] = useState('A');
      const [projectId, setProject] = useState('p');
      window.stageQA.setRoom = setRoom; window.stageQA.setProject = setProject;
      const load = useCallback((id, slug) => {
        const key = room + ':' + id + ':' + (slug || 'all'); calls.push(key);
        return new Promise(resolve => pending.set(key, () => resolve(result(key))));
      }, [room]);
      return <ProjectStageAnalysisDialog key={projectId} open onOpenChange={()=>{}} projectId={projectId}
        projectName="客户运营项目" features={[{slug:'login',title:'登录能力完善'}, {slug:'report', title:'经营报表分析'}]} loadAnalysis={load}/>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  alias: { "@": renderer },
  define: { "process.env.NODE_ENV": '"production"' }
})
const browser = await chromium.launch({
  ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }),
  headless: true
})
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1
  })
  const errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.setContent('<div id="root"></div>')
  await page.addStyleTag({ content: css.build(scanner.scan()) })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const waitCall = (key) => page.waitForFunction((k) => window.stageQA.calls.includes(k), key)
  const finish = (key) => page.evaluate((k) => window.stageQA.finish(k), key)
  const hasStage = (key) => page.getByRole("cell", { name: key, exact: false }).waitFor()
  const select = async (name, search) => {
    await page.getByRole("combobox", { name: "筛选阶段耗时特性" }).click()
    if (search) await page.getByRole("textbox", { name: "搜索特性" }).fill(search)
    await page.getByRole("button", { name, exact: true }).click()
  }
  await waitCall("A:p:all")
  await finish("A:p:all")
  await hasStage("A:p:all")
  await select("登录能力完善", "登录")
  await waitCall("A:p:login")
  await select("经营报表分析", "报表")
  await waitCall("A:p:report")
  await finish("A:p:report")
  await hasStage("A:p:report")
  await finish("A:p:login")
  await page.waitForFunction(() => !document.body.textContent.includes("A:p:login"))
  await hasStage("A:p:report")
  // A late reply can be cached, but must not overwrite the selected feature.
  await select("登录能力完善")
  await hasStage("A:p:login")
  assert.equal(
    await page.evaluate(() => window.stageQA.calls.filter((k) => k === "A:p:login").length),
    1
  )
  await select("全部特性")
  await hasStage("A:p:all")
  assert.equal(
    await page.evaluate(() => window.stageQA.calls.filter((k) => k === "A:p:all").length),
    1
  )
  await page.screenshot({ path: join(output, "stage-all.png") })
  await page.getByRole("combobox", { name: "筛选阶段耗时特性" }).click()
  await page.screenshot({ path: join(output, "stage-feature-selector.png") })
  await page.keyboard.press("Escape")
  await page.evaluate(() => window.stageQA.setRoom("B"))
  await waitCall("B:p:all")
  assert.equal(await page.getByRole("cell", { name: "A:p:all", exact: false }).count(), 0)
  await finish("B:p:all")
  await hasStage("B:p:all")
  await page.evaluate(() => window.stageQA.setProject("q"))
  await waitCall("B:q:all")
  await finish("B:q:all")
  await hasStage("B:q:all")
  await page.setViewportSize({ width: 760, height: 650 })
  await page.waitForFunction(() => {
    const rect = document.querySelector('[role="dialog"]')?.getBoundingClientRect()
    return rect && rect.x >= 0 && Math.abs(rect.width - Math.min(innerWidth * 0.95, 1400)) < 1
  })
  const layout = await page.getByRole("dialog").evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const css = getComputedStyle(element)
    return {
      x: rect.x,
      width: rect.width,
      cssWidth: css.width,
      minWidth: css.minWidth,
      classes: element.className,
      viewport: innerWidth,
      transform: css.transform
    }
  })
  console.log("Narrow dialog layout:", JSON.stringify(layout))
  await page.screenshot({ path: join(output, "stage-narrow.png") })
  assert.ok(
    layout.x >= 0 && layout.x + layout.width <= layout.viewport + 1,
    "Dialog must fit the viewport"
  )
  assert.deepEqual(errors, [])
  const calls = await page.evaluate(() => window.stageQA.calls)
  assert.deepEqual(calls, ["A:p:all", "A:p:login", "A:p:report", "B:p:all", "B:q:all"])
  writeFileSync(
    join(output, "result.json"),
    JSON.stringify(
      {
        calls,
        errors,
        assertions: [
          "search",
          "late-response isolation",
          "feature cache",
          "permission-scope cache isolation",
          "project reset"
        ]
      },
      null,
      2
    )
  )
  console.log("Stage feature browser checks passed:", JSON.stringify(calls))
} finally {
  await browser.close()
}
