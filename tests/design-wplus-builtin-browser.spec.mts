import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { buildSync } from "esbuild"
import { chromium } from "playwright"
import { listBuiltinTemplateBundle, prepareBuiltinTemplatePreview } from "../src/main/services/design/builtin-template-bundles"
import { DesignTemplatePackages } from "../src/main/services/design/template-packages"
import { DesignTemplatePreview } from "../src/main/services/design/template-preview"
import type { DesignCreationSelection } from "../src/renderer/src/components/design/types"

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wplus-builtin-browser-"))
const packages = new DesignTemplatePackages(path.join(temporary, "library"))
const preview = new DesignTemplatePreview()
const catalog = listBuiltinTemplateBundle(path.resolve("design-templates/market-wplus"), packages)
const bundle = buildSync({
  stdin: {
    resolveDir: process.cwd(), loader: "tsx",
    contents: `
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {DesignTemplateSelector} from './src/renderer/src/components/design/DesignTemplateSelector';
      import {useDesignTemplateSelection} from './src/renderer/src/components/design/use-design-template-selection';
      const systems=[{id:'wplus',name:'市场w+',description:'',path:''},{id:'wealth',name:'财富管理',description:'',path:''}];
      function Fixture(){
        const [id,setId]=useState('wplus');
        const picker=useDesignTemplateSelection(JSON.parse(localStorage.getItem('selection')||'null'),systems.find(s=>s.id===id),systems);
        return <><select aria-label="测试设计系统" value={id} onChange={e=>setId(e.target.value)}>
          {systems.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <DesignTemplateSelector picker={picker} browserPreview={false}/>
          <button disabled={!picker.canConfirm} onClick={()=>localStorage.setItem('selection',JSON.stringify(picker.selection))}>保存选择</button>
          <output data-testid="selection">{JSON.stringify(picker.selection)}</output></>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `
  },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
  tsconfig: "tsconfig.web.json", define: { "process.env.NODE_ENV": '"test"', "import.meta.env": "{}" }
}).outputFiles[0].contents
const server = http.createServer((request, response) => {
  if (request.url === "/app.js") {
    response.setHeader("content-type", "text/javascript")
    response.end(bundle)
  } else response.end('<!doctype html><div id="root"></div><script src="/app.js"></script>')
})
const browser = await chromium.launch({ headless: true, executablePath:
  process.env.CHROMIUM_EXECUTABLE_PATH ||
  (fs.existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined) })
try {
  const prepared = await Promise.all(catalog.map(item => prepareBuiltinTemplatePreview(item, packages, preview)))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(15000)
  const errors: string[] = []
  const remote: string[] = []
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message) })
  await page.route("**/*", route => {
    const url = new URL(route.request().url())
    if (/^https?:$/.test(url.protocol) && url.hostname !== "127.0.0.1") {
      remote.push(url.href)
      return route.abort()
    }
    return route.continue()
  })
  await page.addInitScript("window.__name = (target) => target")
  await page.addInitScript(({ catalog }) => {
    if (window !== window.top) return
    ;(window as unknown as { api: unknown }).api = { design: {
      listTemplates: async () => catalog,
      listImportedTemplates: async () => []
    } }
  }, { catalog: prepared })
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
  const selection = async (): Promise<DesignCreationSelection["template"]> =>
    JSON.parse((await page.getByTestId("selection").textContent())!)
  await page.getByRole("button", { name: "选择市场 W+ · 基础表单模板预览", exact: true }).click()
  await page.frameLocator('iframe[title="市场 W+ · 基础表单模板预览"]').getByRole("heading", { name: "新建经营模板", exact: true }).waitFor()
  assert.equal((await selection()).package?.id, "builtin_market-wplus")
  assert.equal((await selection()).package?.entryPath, "basic-form.html")
  await page.getByRole("button", { name: "下一页模板", exact: true }).click()
  await page.getByRole("button", { name: "选择市场 W+ · 选择列表模板预览", exact: true }).click()
  assert.equal((await selection()).package?.entryPath, "select-list.html")
  await page.getByRole("button", { name: "保存选择", exact: true }).click()
  await page.reload()
  await page.getByRole("button", { name: "选择市场 W+ · 选择列表模板预览", exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "保存选择", exact: true }).isEnabled(), true)
  assert.equal((await selection()).package?.entryPath, "select-list.html")
  await page.getByLabel("测试设计系统").selectOption("wealth")
  await page.getByText("当前设计系统暂无专属模板，可切换到公共模板。", { exact: true }).waitFor()
  assert.equal((await selection()).package, undefined)
  console.log("PASS W+ exclusive cards, shared package selection, pagination, reload and system filtering")

  const headings: Record<string, string> = {
    "basic-form.html": "新建经营模板", "batch-import.html": "批量导入企业",
    "complex-form.html": "新建企业福利活动", "filter-table.html": "企业经营管理",
    "select-list.html": "选择活动奖品"
  }
  for (const item of prepared) {
    await page.goto(item.previewPath)
    await page.locator(".page h1").filter({ hasText: headings[item.package!.entryPath] }).waitFor()
    assert.equal(await page.locator(".boot").count(), 0)
    if (item.package!.entryPath === "basic-form.html") {
      await page.getByPlaceholder("请输入模板名称", { exact: true }).fill("内置模板验证")
      await page.getByRole("button", { name: /重\s*置/ }).click()
      assert.equal(await page.getByPlaceholder("请输入模板名称", { exact: true }).inputValue(), "")
    }
    if (item.package!.entryPath === "batch-import.html") {
      const href = await page.getByRole("link", { name: /下载导入模板/ }).getAttribute("href")
      const spreadsheet = await page.request.get(new URL(href!, item.previewPath).href)
      assert.equal(spreadsheet.status(), 200)
      assert.equal((await spreadsheet.body()).subarray(0, 2).toString(), "PK")
    }
    if (item.package!.entryPath === "filter-table.html") {
      assert.equal(await page.locator(".ant-table-row").count(), 10)
      await page.getByPlaceholder("请输入企业名称", { exact: true }).fill("不存在的企业")
      await page.getByRole("button", { name: /查\s*询/, exact: true }).click()
      await page.locator(".ant-empty").waitFor()
      if (process.env.DESIGN_WPLUS_SCREENSHOT) {
        await page.getByRole("button", { name: /重\s*置/, exact: true }).click()
        await page.locator(".ant-table-row").first().waitFor()
        await page.locator(".ant-spin-spinning").waitFor({ state: "hidden" })
        await page.screenshot({ path: process.env.DESIGN_WPLUS_SCREENSHOT, fullPage: true })
      }
    }
    if (item.package!.entryPath === "select-list.html") {
      await page.getByRole("dialog").waitFor()
      await page.getByPlaceholder("请输入奖品名称或编号").fill("不存在的奖品")
      await page.getByPlaceholder("请输入奖品名称或编号").press("Enter")
      await page.getByRole("dialog").locator(".ant-empty").waitFor()
    }
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(remote, [])
  console.log("PASS all five real React/Ant Design pages load offline; form reset, spreadsheet resource and table/modal searches work")
} finally {
  await browser.close()
  preview.close()
  server.close()
  fs.rmSync(temporary, { recursive: true, force: true })
}
