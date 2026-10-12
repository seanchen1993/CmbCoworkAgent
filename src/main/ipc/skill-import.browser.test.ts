import { EventEmitter } from "node:events"
import { createServer } from "node:http"
import { once } from "node:events"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import AdmZip from "adm-zip"
import { expect, it, vi } from "vitest"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import type { SkillImportRequest, SkillImportResult } from "../../shared/skill-import"

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: { fromWebContents: () => ({}), getAllWindows: () => [] },
  shell: {}
}))

it.skipIf(process.env.CMB_SKILL_IMPORT_UI_TEST !== "1")(
  "imports files, pasted text and URL snapshots through the real renderer and existing installer",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-import-ui-"))
    const oldHome = process.env.CMB_COWORK_AGENT_HOME
    process.env.CMB_COWORK_AGENT_HOME = join(root, "settings")
    const output = resolve("output/skill-import")
    await mkdir(output, { recursive: true })
    const markdown = (name: string) =>
      `---\nname: ${name}\ndescription: 发布前检查变更、测试证据与回退步骤\ncompatibility: Node.js 22；需要项目读取权限\n---\n1. 阅读变更和验证结果。\n2. 核对兼容性与回退步骤。\n3. 整理待决问题，提交人工评审。`
    let remoteBody = markdown("remote-review")
    let remoteRequests = 0
    const server = createServer((request, response) => {
      ++remoteRequests
      response.setHeader("content-type", "text/markdown")
      if (request.url === "/slow") response.write("---\n")
      else response.end(remoteBody)
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing port")
    const base = `http://127.0.0.1:${address.port}`
    const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    try {
      const handlers = new Map<
        string,
        (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
      >()
      const { registerSkillsHandlers } = await import("./skills")
      const { getCustomSkillsDir } = await import("../storage")
      registerSkillsHandlers({
        handle: (key, handler) => handlers.set(key, handler)
      } as unknown as IpcMain)
      const contents = Object.assign(new EventEmitter(), { id: 1, mainFrame: {} })
      const event = {
        sender: contents,
        senderFrame: contents.mainFrame
      } as unknown as IpcMainInvokeEvent
      const renderer = resolve("src/renderer/src")
      const css = await compile(
        (await readFile(join(renderer, "index.css"), "utf8")).replace(
          /^@import "@fontsource[^\n]+\n/gm,
          ""
        ),
        { base: renderer, onDependency: () => {} }
      )
      const scanner = new Scanner({
        sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
      })
      const bundle = await build({
        stdin: {
          contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {UploadSkillDialog} from './src/renderer/src/components/customize/UploadSkillDialog';import {applyThemePreference} from './src/renderer/src/lib/theme-preference';
        window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');
        window.api={skills:{previewImport:async(id,input)=>{const result=await window.previewCall(id,input.kind==='file'?{...input,buffer:Array.from(new Uint8Array(input.buffer))}:input);if(result.success)result.file.buffer=Uint8Array.from(result.file.buffer).buffer;return result;},cancelImport:id=>window.cancelCall(id),upload:(buffer,fileName,options)=>window.uploadCall({buffer:Array.from(new Uint8Array(buffer)),fileName,options})}};
        function Fixture(){const[open,setOpen]=useState(false);const[installed,setInstalled]=useState('');return <div className="p-8 text-foreground"><button onClick={()=>setOpen(true)}>导入技能</button><p role="status">{installed}</p><UploadSkillDialog open={open} onOpenChange={setOpen} onSuccess={setInstalled}/></div>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
          resolveDir: process.cwd(),
          loader: "tsx"
        },
        bundle: true,
        platform: "browser",
        format: "iife",
        write: false,
        outfile: join(root, "ui.js"),
        jsx: "automatic",
        alias: { "@": renderer },
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
      })
      const page = await browser.newPage({ viewport: { width: 1060, height: 860 } })
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.exposeFunction(
        "previewCall",
        async (id: string, raw: SkillImportRequest & { buffer?: number[] }) => {
          const input =
            raw.kind === "file" ? { ...raw, buffer: Uint8Array.from(raw.buffer!).buffer } : raw
          const result = (await handlers.get("skills:previewImport")!(
            event,
            id,
            input
          )) as SkillImportResult
          return result.success
            ? {
                ...result,
                file: { ...result.file, buffer: Array.from(new Uint8Array(result.file.buffer)) }
              }
            : result
        }
      )
      await page.exposeFunction("cancelCall", (id: string) =>
        handlers.get("skills:cancelImport")!(event, id)
      )
      let loseFirstUploadResponse = true
      await page.exposeFunction(
        "uploadCall",
        async (raw: { buffer: number[]; fileName: string; options: unknown }) => {
          const result = await handlers.get("skills:upload")!(event, {
            ...raw,
            buffer: Uint8Array.from(raw.buffer).buffer
          })
          if (loseFirstUploadResponse && (result as { success: boolean }).success) {
            loseFirstUploadResponse = false
            throw new Error("模拟安装成功后应答丢失")
          }
          return result
        }
      )
      await page.route("http://127.0.0.1:39191/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><head><meta charset="utf-8"><style>${css.build(scanner.scan())}</style></head><body><div id="root"></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text.replaceAll("</script", "<\\/script")}</script></body></html>`
        })
      )
      await page.goto("http://127.0.0.1:39191")
      const open = () => page.getByRole("button", { name: "导入技能", exact: true }).click()
      await open()
      const zip = new AdmZip()
      zip.addFile("review/SKILL.md", Buffer.from(markdown("local-review")))
      zip.addFile("review/check.ps1", Buffer.from("throw 'MUST_NOT_EXECUTE'"))
      await page
        .getByLabel("选择技能文件")
        .setInputFiles({ name: "review.zip", mimeType: "application/zip", buffer: zip.toBuffer() })
      await page.getByRole("heading", { name: "local-review" }).waitFor()
      await expect(readFile(join(getCustomSkillsDir(), "local-review/SKILL.md"))).rejects.toThrow()
      await page.screenshot({ path: join(output, "preview-light.png"), animations: "disabled" })
      await page.getByRole("button", { name: "确认导入", exact: true }).click()
      await page.getByRole("alert").filter({ hasText: "模拟安装成功后应答丢失" }).waitFor()
      const { stat } = await import("node:fs/promises")
      const installedBefore = await stat(join(getCustomSkillsDir(), "local-review/SKILL.md"))
      await page.reload()
      await open()
      await page
        .getByLabel("选择技能文件")
        .setInputFiles({ name: "review.zip", mimeType: "application/zip", buffer: zip.toBuffer() })
      await page.getByRole("heading", { name: "local-review" }).waitFor()
      await page.getByRole("button", { name: "确认导入", exact: true }).click()
      await page.getByRole("status").filter({ hasText: "local-review" }).waitFor()
      expect((await stat(join(getCustomSkillsDir(), "local-review/SKILL.md"))).mtimeMs).toBe(
        installedBefore.mtimeMs
      )
      expect(await readFile(join(getCustomSkillsDir(), "local-review/check.ps1"), "utf8")).toBe(
        "throw 'MUST_NOT_EXECUTE'"
      )
      await open()
      await page.getByRole("tab", { name: "链接", exact: true }).click()
      await page.getByLabel("技能文件链接").fill(`${base}/SKILL.md`)
      await page.getByRole("button", { name: "读取并预览" }).click()
      await page.getByRole("heading", { name: "remote-review" }).waitFor()
      remoteBody = markdown("CHANGED_REMOTE_CONTENT")
      await page.evaluate("window.fixtureTheme('codex-dark')")
      await page.screenshot({ path: join(output, "preview-dark.png"), animations: "disabled" })
      await page.getByRole("button", { name: "确认导入", exact: true }).click()
      await page.getByRole("status").filter({ hasText: "remote-review" }).waitFor()
      expect(remoteRequests).toBe(1)
      expect(await readFile(join(getCustomSkillsDir(), "remote-review/SKILL.md"), "utf8")).toBe(
        markdown("remote-review")
      )
      await open()
      await page.getByRole("tab", { name: "粘贴内容", exact: true }).click()
      await page.getByLabel("技能 Markdown 内容").fill(markdown("pasted-review"))
      await page.getByRole("button", { name: "预览技能" }).click()
      await page.getByRole("heading", { name: "pasted-review" }).waitFor()
      await page.getByRole("button", { name: "确认导入", exact: true }).click()
      await page.getByRole("status").filter({ hasText: "pasted-review" }).waitFor()
      await open()
      await page.getByRole("tab", { name: "链接", exact: true }).click()
      await page.getByLabel("技能文件链接").fill(`${base}/slow`)
      await page.getByRole("button", { name: "读取并预览" }).click()
      await page.getByText("正在读取技能…", { exact: true }).waitFor()
      await page.keyboard.press("Escape")
      await page.getByRole("dialog").waitFor({ state: "hidden" })
      await open()
      await page.getByRole("tab", { name: "粘贴内容", exact: true }).click()
      await page.getByLabel("技能 Markdown 内容").fill(markdown("after-cancel"))
      await page.getByRole("button", { name: "预览技能" }).click()
      await page.getByRole("heading", { name: "after-cancel" }).waitFor()
      expect(errors).toEqual([])
      const { readBotSkillCatalog } = await import("../bots/skill-catalog-reader")
      const builtin = join(root, "builtin"),
        plugins = join(root, "plugins.json"),
        disabled = join(root, "disabled.json")
      await mkdir(builtin)
      await writeFile(plugins, "[]")
      await writeFile(disabled, "[]")
      const catalog = await readBotSkillCatalog({
        builtinSkillsDir: builtin,
        customSkillsDir: getCustomSkillsDir(),
        pluginsStorePath: plugins,
        disabledSkillsPath: disabled,
        disabledSkillsRevision: 0,
        globalRevision: 1
      })
      expect(catalog.skills.map((skill) => skill.name).sort()).toEqual([
        "local-review",
        "pasted-review",
        "remote-review"
      ])
      expect(catalog.skills.find((skill) => skill.name === "local-review")?.resources).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "check.ps1" })])
      )
    } finally {
      await browser.close()
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
      if (oldHome === undefined) delete process.env.CMB_COWORK_AGENT_HOME
      else process.env.CMB_COWORK_AGENT_HOME = oldHome
      await rm(root, { recursive: true, force: true })
    }
  },
  45_000
)
