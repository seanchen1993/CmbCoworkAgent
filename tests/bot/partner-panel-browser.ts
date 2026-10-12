import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"
import type { PartnerDevStatus, PartnerDevRunView } from "../../src/shared/bot/partner-dev"

/** Actual React component in Chromium, deterministic fake IPC for UI only.
 * Backend/actual graph acceptance is the separate partner-http-journey. */
async function main() {
  const root = process.cwd(),
    binary = createRequire(import.meta.url)("electron") as string,
    dir = await mkdtemp(join(tmpdir(), "devclaw-partner-panel-"))
  let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const bundle = await build({
      entryPoints: [resolve("tests/support/partner-dev-panel-fixture.tsx")],
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: { "@": join(root, "src/renderer/src") }
    })
    const html = join(dir, "index.html"),
      entry = join(dir, "main.cjs")
    await writeFile(
      html,
      '<meta charset="UTF-8"><style>body{font:14px system-ui;background:#fff;color:#161b25;margin:0}section{border:1px solid #ddd;border-radius:12px;padding:18px;margin:14px}header{padding:18px}input,textarea,button{font:inherit;padding:6px;margin:4px}svg{width:16px;height:16px}pre{white-space:pre-wrap}button:disabled{opacity:.4}</style><div id="root"></div>'
    )
    await writeFile(
      entry,
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>{const window=new BrowserWindow({width:1200,height:1000,show:false,webPreferences:{backgroundThrottling:false}});window.loadFile(${JSON.stringify(html)})});`
    )
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    delete env.ELECTRON_RUN_AS_NODE
    electron = await _electron.launch({
      executablePath: binary,
      args: [entry],
      env,
      timeout: 30000
    })
    const page = await electron.firstWindow()
    page.setDefaultTimeout(10000)
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    await page.waitForURL(/index\.html$/)
    const status: PartnerDevStatus = {
      configured: false,
      connected: false,
      nodeEnabled: false,
      model: "simulated",
      url: null,
      spaceId: null,
      nodeId: null,
      ownerPrincipalId: null,
      businessPrincipalId: null,
      workspacePath: null,
      groupId: null,
      botId: null,
      lastError: null,
      activeRunId: null,
      lastRunId: null,
      lastTaskNumber: null
    }
    let result: PartnerDevRunView = {
        runId: "run-ui",
        status: "waiting_node",
        version: 1,
        result: null
      },
      sends = 0,
      analyses = 0
    await page.exposeFunction(
      "partnerFixtureCall",
      async (method: string, value?: { mentioned?: boolean; text?: string }) => {
        if (method === "getStatus") return structuredClone(status)
        if (method === "importConnection")
          Object.assign(status, {
            configured: true,
            url: "http://127.0.0.1:32123",
            spaceId: "A",
            nodeId: "node",
            ownerPrincipalId: "owner",
            businessPrincipalId: "business"
          })
        if (method === "chooseWorkspace") status.workspacePath = "/explicit-owner-workspace"
        if (method === "connect") status.connected = true
        if (method === "disconnect") {
          status.connected = false
          status.nodeEnabled = false
        }
        if (method === "createTeam")
          Object.assign(status, { groupId: "group-ui", botId: "expert-ui" })
        if (method === "sendMessage") {
          sends++
          if (!value?.mentioned)
            return { kind: "ignored", notice: "没有结构化 @，伙伴未读取或保存这条群消息。" }
          if (value.text?.startsWith("新任务")) {
            status.lastTaskNumber = "TASK-1"
            return {
              kind: "task",
              taskId: "task-ui",
              taskNumber: "TASK-1",
              taskVersion: 1,
              notice: "任务已创建"
            }
          }
          return {
            kind: "task",
            taskId: "task-ui",
            taskNumber: "TASK-1",
            taskVersion: 2,
            notice: "澄清已保存"
          }
        }
        if (method === "analyzeTask") {
          analyses++
          status.lastRunId = "run-ui"
          return {
            kind: "task",
            taskNumber: "TASK-1",
            runId: "run-ui",
            runStatus: "waiting_node",
            notice: "任务已排队，等待负责人启用节点"
          }
        }
        if (method === "enableNode") {
          status.nodeEnabled = true
          result = {
            runId: "run-ui",
            status: "succeeded",
            version: 3,
            result: {
              outcome: "succeeded",
              text: "[模拟模型返回｜非真实分析]\nTASK-1 需求说明书草稿：权限与范围待确认。",
              settledAt: new Date().toISOString()
            }
          }
        }
        if (method === "stopNode" || method === "revokeTeam") status.nodeEnabled = false
        if (method === "inspectRun") return structuredClone(result)
        return structuredClone(status)
      }
    )
    await page.evaluate(() => {
      const target = window as unknown as {
        api: { partnerDev: Record<string, (value?: unknown) => Promise<unknown>> }
        partnerFixtureCall: (name: string, value?: unknown) => Promise<unknown>
        __name?: (v: unknown) => unknown
      }
      target.__name = (v) => v
      target.api = {
        partnerDev: Object.fromEntries(
          [
            "getStatus",
            "importConnection",
            "chooseWorkspace",
            "connect",
            "disconnect",
            "createTeam",
            "bindTeam",
            "authorizeTeam",
            "revokeTeam",
            "enableNode",
            "stopNode",
            "sendMessage",
            "analyzeTask",
            "inspectRun",
            "cancelPending"
          ].map((name) => [name, (value?: unknown) => target.partnerFixtureCall(name, value)])
        )
      }
    })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    assert.ok(await page.getByText("DevClaw 伙伴 · 开发联调", { exact: true }).isVisible())
    await page.getByRole("button", { name: "导入连接文件", exact: true }).click()
    await page.getByRole("button", { name: "连接服务", exact: true }).click()
    await page.getByRole("button", { name: "选择工作区", exact: true }).click()
    await page.getByRole("button", { name: "创建单专家团队", exact: true }).click()
    await page.getByRole("button", { name: "授权团队使用此节点（24小时）", exact: true }).click()
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    assert.equal(analyses, 0)
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    assert.equal(sends, 2)
    await page.getByRole("button", { name: "分析需求", exact: true }).click()
    await page.getByText("等待负责人节点", { exact: true }).waitFor()
    assert.equal(analyses, 1)
    await page.getByRole("button", { name: "启用本地节点", exact: true }).click()
    await page.getByTestId("partner-result").waitFor()
    assert.ok((await page.getByTestId("partner-result").innerText()).includes("非真实分析"))
    await page.getByRole("button", { name: "停止节点并等待清理", exact: true }).click()
    assert.equal(status.nodeEnabled, false)
    await page.getByRole("button", { name: "断开", exact: true }).click()
    await page.getByRole("button", { name: "连接服务", exact: true }).click()
    await page.getByTestId("partner-result").waitFor()
    assert.equal(status.nodeEnabled, false)
    assert.equal(analyses, 1)
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        stage: "partner-panel-browser",
        actualReactComponent: true,
        actualChromium: true,
        fakeIPC: true,
        ownerConfig: true,
        taskClarification: true,
        offlineWaiting: true,
        simulatedResultVisible: true,
        stopAndReconnect: true,
        autoModelCalls: 0,
        errors: 0
      })
    )
  } finally {
    await electron?.close()
    await rm(dir, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(String(error))
  process.exitCode = 1
})
