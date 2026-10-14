/** Actual React library panel, bounded local mocks, no network or model. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"

async function main() {
  const output = resolve("output/project-platform-20261012", `library-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const entry = resolve("src/renderer/src/components/harness-board/ProjectLibraryPanel.tsx")
  const cssEntry = resolve("src/renderer/src/index.css")
  const compiler = await compile(readFileSync(cssEntry, "utf8"), {
    base: dirname(cssEntry),
    from: cssEntry,
    onDependency: () => undefined
  })
  const scanner = new Scanner({})
  const css = compiler.build(
    scanner.scanFiles([
      { content: readFileSync(entry, "utf8"), extension: "tsx" },
      { content: "bg-background text-foreground p-4 max-w-3xl mx-auto", extension: "html" }
    ])
  )
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
import React from 'react';import{createRoot}from'react-dom/client';
import{ProjectLibraryPanel}from${JSON.stringify(entry)};
const root=createRoot(document.getElementById('root'));
const clone=x=>structuredClone(x), calls=[], rows={a:[],b:[]};
let project='a', serial=0, failRead=false, failSend=false, held='', release, running=false, preview=false;
const projects=[{projectId:'a',name:'订单检查任务',status:'active'},{projectId:'b',name:'退款检查任务',status:'active'}];
const pause=async kind=>{if(held===kind){calls.push(['held',kind]);await new Promise(r=>release=r)}};
window.api={harnessBoard:{localProjects:{list:async()=>clone(projects),library:{
 list:async pid=>{calls.push(['list',pid]);const result=clone(rows[pid]);await pause('list');return result},
 capture:async(pid,input)=>{calls.push(['capture',pid,input]);const record={...input,id:'entry-'+(++serial),projectId:pid,stageId:'check',createdAt:Date.now(),status:'saved',files:[{path:'result.md',size:25,sha256:'digest',status:'pending'},{path:'review.json',size:20,sha256:'digest2',status:'pending'}]};rows[pid].unshift(record);await pause('capture');return clone(record)},
 read:async(pid,id,path)=>{calls.push(['read',pid,id,path]);await pause('read');if(failRead)throw Error('PROJECT_LIBRARY_SNAPSHOT_CHANGED');return{text:path==='result.md'?'# 已核对的订单结果':'{"checked":true}',truncated:false}},
 reuse:async(pid,id,target)=>{calls.push(['reuse',pid,id,target]);const record={...clone(rows[pid].find(x=>x.id===id)),id:'entry-'+(++serial),projectId:target,source:{projectId:pid,entryId:id}};rows[target].unshift(record);return clone(record)},
 send:async(pid,id,input)=>{calls.push(['send',pid,id,input]);await pause('send');if(failSend)throw Error('PROJECT_LIBRARY_BUSY');const record=rows[pid].find(x=>x.id===id);Object.assign(record,input);const attempts=calls.filter(x=>x[0]==='send'&&x[2]===id).length;record.status=attempts===1?'unknown':'sent';record.catalogStatus=attempts===1?'unknown':'uploaded';record.files.forEach((file,i)=>file.status=attempts===1&&i===1?'unknown':'uploaded');record.error=attempts===1?'发送未全部确认，请先核对接收方。':undefined;return clone(record)},
 remove:async(pid,id)=>{calls.push(['remove',pid,id]);rows[pid]=rows[pid].filter(x=>x.id!==id)}
}}}};
const mount=()=>root.render(<main className='max-w-3xl mx-auto p-4'><h1>{projects.find(x=>x.projectId===project).name}</h1><ProjectLibraryPanel view={{project:{...projects.find(x=>x.projectId===project),manifest:{stages:[{id:'check',title:'检查成果'}]}},operations:[{operationId:'checked-'+project,stageId:'check',status:running?'started':'succeeded',updatedAt:Date.now()}],...(preview?{preview:{state:'active'}}:{})}}/></main>);
window.fixture={calls,rows,switch:pid=>{project=pid;mount()},hold:kind=>held=kind,release:()=>{held='';release()},failRead:value=>failRead=value,failSend:value=>failSend=value,running:value=>{running=value;mount()},preview:value=>{preview=value;mount()},unmount:()=>root.render(null),remount:mount};mount();`
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    platform: "browser",
    format: "iife",
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
  const errors: string[] = [],
    requests: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => {
    requests.push(route.request().url())
    return route.abort()
  })
  const call = (expression: string) => page.evaluate(`window.fixture.${expression}`)
  const button = (name: string) => page.getByRole("button", { name, exact: true })
  try {
    await page.setContent('<div id="root"></div>')
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await button("打开成果与经验").click()
    await page.getByText("还没有保存的成果。", { exact: true }).waitFor()
    assert.equal(await button("保存为经验").isDisabled(), true)
    await page.getByRole("textbox", { name: "成果名称", exact: true }).fill("订单校验经验")
    await page
      .getByRole("textbox", { name: "经验说明", exact: true })
      .fill("复用前请核对退款规则。")
    await button("保存为经验").click()
    await page.getByText("经验已保存到本机。", { exact: true }).waitFor()
    await button("订单校验经验").click()
    await button("result.md").click()
    await page.locator("pre").filter({ hasText: "已核对的订单结果" }).waitFor()
    await call("failRead(true)")
    await button("review.json").click()
    await page.getByRole("alert").waitFor()
    assert.equal(
      await page.locator("pre").count(),
      0,
      "Failed reads must not show the previous file as the selected file"
    )
    await call("failRead(false)")
    await button("review.json").click()
    await page.locator("pre").filter({ hasText: '"checked":true' }).waitFor()
    await page.getByRole("combobox", { name: "复用到另一个任务", exact: true }).selectOption("b")
    await button("加入所选任务的经验").click()
    await page.getByText("已加入“退款检查任务”的经验。", { exact: true }).waitFor()
    await call("switch('b')")
    await button("订单校验经验").waitFor()
    await page.getByText(/从其他任务复用/).waitFor()
    assert.equal(await page.locator('[aria-label="成果详情"]').count(), 0)
    await call("switch('a')")
    await page.getByRole("textbox", { name: "成果名称", exact: true }).fill("订单成果交付")
    await button("准备交付").click()
    await button("订单成果交付").click()
    await button("result.md").click()
    await page.locator("pre").waitFor()
    await page
      .getByRole("textbox", { name: "接收服务地址", exact: true })
      .fill("https://delivery.example.invalid/file/upload")
    await page
      .getByRole("textbox", { name: "接收目录", exact: true })
      .fill("orders/DEV/Features/sample")
    assert.equal(await button("确认发送").isDisabled(), true)
    await page.getByRole("checkbox").check()
    await button("确认发送").click()
    await page.getByText("发送未全部确认，请先核对接收方。", { exact: true }).waitFor()
    await page.getByText("目录清单 · 需要核对", { exact: true }).waitFor()
    assert.equal(await button("确认发送未确认部分").isDisabled(), true)
    assert.equal(
      await page
        .getByRole("textbox", { name: "接收服务地址", exact: true })
        .getAttribute("readonly"),
      ""
    )
    await page.screenshot({ path: join(output, "delivery-needs-confirmation.png"), fullPage: true })
    await page.getByRole("checkbox").check()
    await button("确认发送未确认部分").click()
    await page.getByText("交付 · 2 个文件 · 接收方已确认", { exact: true }).waitFor()
    await page.getByText("目录清单 · 接收方已确认", { exact: true }).waitFor()
    assert.equal(await button("确认发送未确认部分").isDisabled(), true)
    assert.equal(await call("calls.filter(x=>x[0]==='send').length"), 2)
    await page.screenshot({ path: join(output, "saved-reused-delivered.png"), fullPage: true })
    checks.push(
      "Save checked knowledge, preview files, recover a read failure, reuse to another task, prepare delivery, confirm, inspect unknown outcome and explicitly retry"
    )
    await button("关闭").click()
    await page.getByRole("textbox", { name: "成果名称", exact: true }).fill("测试发送异常")
    await button("准备交付").click()
    await button("测试发送异常").click()
    await page
      .getByRole("textbox", { name: "接收服务地址", exact: true })
      .fill("https://delivery.example.invalid/file/upload")
    await page.getByRole("textbox", { name: "接收目录", exact: true }).fill("orders")
    await page.getByRole("checkbox").check()
    await call("failSend(true)")
    await button("确认发送").click()
    await page.getByRole("alert").waitFor()
    assert.equal(await page.getByRole("checkbox").isChecked(), false)
    assert.equal(await button("确认发送").isDisabled(), true)
    await call("failSend(false)")
    await call("preview(true)")
    await page.getByRole("checkbox").check()
    assert.equal(await button("确认发送").isDisabled(), true)
    await call("preview(false)")
    await call("running(true)")
    assert.equal(
      await page.getByRole("textbox", { name: "成果名称", exact: true }).isDisabled(),
      true
    )
    await call("running(false)")
    checks.push(
      "IPC send failures consume confirmation; preview send and capture during running operation stay disabled"
    )
    await button("关闭").click()
    await button("订单校验经验").click()
    await call("hold('read')")
    await button("result.md").click()
    await page.waitForFunction(() =>
      (window as unknown as { fixture: { calls: string[][] } }).fixture.calls.some(
        (x) => x[0] === "held" && x[1] === "read"
      )
    )
    await call("switch('b')")
    await button("订单校验经验").waitFor()
    await call("release()")
    assert.equal(await page.locator("pre").count(), 0)
    await call("switch('a')")
    await page.getByRole("textbox", { name: "成果名称", exact: true }).fill("延迟保存")
    await call("hold('capture')")
    await button("保存为经验").click()
    await page.waitForFunction(() =>
      (window as unknown as { fixture: { calls: string[][] } }).fixture.calls.some(
        (x) => x[0] === "held" && x[1] === "capture"
      )
    )
    await call("unmount()")
    await call("release()")
    await call("switch('b')")
    await button("打开成果与经验").click()
    await button("订单校验经验").waitFor()
    assert.equal(await button("延迟保存").count(), 0)
    await button("订单校验经验").click()
    await page.getByText("移除这份本地记录", { exact: true }).click()
    await button("确认移除").click()
    await page.getByText("还没有保存的成果。", { exact: true }).waitFor()
    assert.equal(await call("rows.a.some(x=>x.title==='订单校验经验')"), true)
    checks.push(
      "In-flight reads cannot populate a different task; unmounted capture does not populate remounted project; removing a reused copy preserves the original"
    )
    assert.deepEqual(errors, [])
    assert.deepEqual(requests, [])
    writeFileSync(
      join(output, "result.json"),
      JSON.stringify({ checks, errors, requests }, null, 2)
    )
    console.log(JSON.stringify({ output, checks }, null, 2))
  } catch (error) {
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {})
    throw error
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
