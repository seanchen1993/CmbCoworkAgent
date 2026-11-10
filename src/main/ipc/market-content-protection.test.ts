import AdmZip from "adm-zip"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import {
  cleanupMarketRuntimeContent,
  encodeMarketContent,
  MARKET_CONTENT_MARKER,
  MARKET_CONTENT_PREFIX,
  protectMarketDirectory,
  readContentFileSync
} from "../services/market-content"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { trashItem: vi.fn() },
  ipcMain: { handle: () => undefined }
}))

type IpcResult = {
  success: boolean
  error?: string
  content?: string
  skills?: string[]
  hookCount?: number
  hooks?: unknown[]
  mcpServerDetails?: unknown[]
}
type Handler = (event: unknown, ...args: unknown[]) => Promise<IpcResult>
const handlers = new Map<string, Handler>()
const previousHome = process.env.CMB_COWORK_AGENT_HOME
let home: string
let sourceAccessPolicy: typeof import("../services/market-source-access")
let storage: typeof import("../storage")
let skills: typeof import("./skills")
const original = (name: string): string =>
  `---\nname: ${name}\ndescription: example\nversion: v1.2.0\n---\n企业内部知识步骤`
const bytes = (value: Buffer): ArrayBuffer => Uint8Array.from(value).buffer
const invoke = (channel: string, ...args: unknown[]): Promise<IpcResult> =>
  handlers.get(channel)!(null, ...args)

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "cmb-market-ipc-"))
  process.env.CMB_COWORK_AGENT_HOME = home
  storage = await import("../storage")
  // Fail before registering handlers if an eager import captured the real user's data root.
  expect(storage.getOpenworkDir()).toBe(home)
  sourceAccessPolicy = await import("../services/market-source-access")
  skills = await import("./skills")
  const plugins = await import("./plugins")
  const files = await import("./plugin-files")
  const ipc = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }
  skills.registerSkillsHandlers(ipc as never)
  plugins.registerPluginHandlers(ipc as never)
  files.registerPluginFileHandlers(ipc as never)
}, 60_000)

afterAll(() => {
  cleanupMarketRuntimeContent()
  if (previousHome === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

afterEach(() => vi.restoreAllMocks())

describe("market content IPC regression", () => {
  it.each(["owner", "whitelist"] as const)("installs %s market plugins as editable originals and rechecks reinstalls", async (access) => {
    const policy = vi.spyOn(sourceAccessPolicy, "resolveMarketSourceAccess").mockResolvedValue(undefined)
    const marketplace = { name: "source-" + access, id: "source-" + access }
    const zip = new AdmZip()
    zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: marketplace.name })))
    zip.addFile("skills/action/SKILL.md", Buffer.from(original(marketplace.name)))
    zip.addFile("run.cjs", Buffer.from("console.log('plain')"))
    const payload = { buffer: bytes(zip.toBuffer()), fileName: "source.zip", origin: "market", marketplace,
      sourceAccess: "owner" } // Renderer claims must not bypass main's policy.
    expect((await invoke("plugins:install", payload)).success).toBe(true)
    expect(policy).toHaveBeenCalledWith("plugin", marketplace, payload.buffer)
    const previous = storage.getPlugins().find((p) => p.marketplace?.id === marketplace.id)!
    expect(previous.sourceAccess).toBeUndefined()
    expect((await invoke("plugins:listFiles", previous.id)).success).toBe(false)
    policy.mockResolvedValue(access)
    expect((await invoke("plugins:install", payload)).success).toBe(true)
    const plugin = storage.getPlugins().find((p) => p.id === previous.id)!
    expect(plugin).toMatchObject({ origin: "market", sourceAccess: access, marketplace, path: previous.path })
    expect(existsSync(join(plugin.path, MARKET_CONTENT_MARKER))).toBe(false)
    const md = join(plugin.path, "skills/action/SKILL.md")
    expect(readFileSync(md, "utf8")).toBe(original(marketplace.name))
    expect((await invoke("plugins:listFiles", plugin.id)).success).toBe(true)
    expect((await invoke("plugins:write", { pluginId: plugin.id, filePath: md, content: original(marketplace.name) + "\nedit" })).success).toBe(true)
    expect((await invoke("plugins:exportForMarket", plugin.id)).success).toBe(true)
    expect((await skills.listPluginSkills()).find((skill) => skill.pluginId === plugin.id)?.contentOrigin).toBe("local")
    policy.mockResolvedValue(undefined)
    expect((await invoke("plugins:install", payload)).success).toBe(true)
    expect(storage.getPlugins().find((p) => p.id === plugin.id)?.sourceAccess).toBeUndefined()
    expect(readFileSync(md, "utf8")).toContain(MARKET_CONTENT_PREFIX)
    expect(readFileSync(join(plugin.path, "run.cjs"), "utf8")).toBe("console.log('plain')")
    expect((await invoke("plugins:listFiles", plugin.id)).success).toBe(false)
  })

  it.each(["owner", "whitelist"] as const)("allows %s skill source editing after a market installation", async (access) => {
    const policy = vi.spyOn(sourceAccessPolicy, "resolveMarketSourceAccess").mockResolvedValue(access)
    const name = "source-skill-" + access
    const md = original(name)
    const zip = new AdmZip()
    zip.addFile("SKILL.md", Buffer.from(md))
    const buffer = access === "owner" ? Buffer.from(md) : zip.toBuffer()
    expect((await invoke("skills:upload", { buffer: bytes(buffer), fileName: access === "owner" ? "SKILL.md" : "skill.zip",
      options: { origin: "market", marketplace: { name } } })).success).toBe(true)
    expect(policy).toHaveBeenCalledWith("skill", { name }, bytes(buffer))
    const skill = (await skills.listAllSkills()).find((item) => item.name === name)!
    expect(skill.contentOrigin).toBe("local")
    expect(readFileSync(skill.path, "utf8")).toBe(md)
    expect((await invoke("skills:read", skill.path)).content).toBe(md)
    expect((await invoke("skills:write", { skillPath: skill.path, content: md + "\nedit" })).success).toBe(true)
    expect((await invoke("skills:exportForMarket", skill.path)).success).toBe(true)
  })

  it("persists market identity across renamed project plugin updates and clears it for originals", async () => {
    const marketplace = { name: "市场项目模式插件", id: "project-market-id" }
    const install = async (name: string, origin = "market") => {
      const zip = new AdmZip()
      zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name, author: "uploader" })))
      zip.addFile("skills/action/SKILL.md", Buffer.from(original(name)))
      return invoke("plugins:install", {
        buffer: bytes(zip.toBuffer()),
        fileName: "project.zip",
        origin,
        marketplace
      })
    }
    expect((await install("internal-project-plugin")).success).toBe(true)
    const first = storage.getPlugins().find((p) => p.marketplace?.id === marketplace.id)!
    expect(first.marketplace).toEqual(marketplace)
    expect((await install("renamed-internal-project-plugin")).success).toBe(true)
    const installed = storage.getPlugins().filter((p) => p.marketplace?.id === marketplace.id)
    expect(installed).toHaveLength(1)
    expect(installed[0]).toMatchObject({
      id: first.id,
      path: first.path,
      name: "renamed-internal-project-plugin"
    })
    expect(
      JSON.parse(readFileSync(join(home, "plugins.json"), "utf8")).find(
        (p: { id: string }) => p.id === first.id
      ).marketplace
    ).toEqual(marketplace)
    expect((await install("renamed-internal-project-plugin", "local")).success).toBe(true)
    expect(storage.getPlugins().find((p) => p.id === first.id)?.marketplace).toBeUndefined()
    expect((await invoke("plugins:delete", first.id)).success).toBe(true)
    expect(storage.getPlugins().some((p) => p.id === first.id)).toBe(false)
  })

  it("pulls project constraints into the plugin directory and previews them after runtime cleanup", async () => {
    const { syncHarnessProjectConstraints } = await import("../harness-board/service")
    const { readHarnessKnowledgePreview } =
      await import("../harness-board/knowledge-preview-reader")
    const { authorizeKnowledgePreview } = await import("../harness-board/knowledge-preview-grant")
    const { resolveExternalFileReadGrant, revokeExternalFileReadGrantsForOwner } =
      await import("../services/external-file-read-tokens")
    const { readPreviewTextPage } = await import("../workspace-file-preview/reader")
    const zip = new AdmZip()
    zip.addFile("plugin.json", Buffer.from('{"name":"public-constraints-plugin"}'))
    zip.addFile("skills/action/SKILL.md", Buffer.from(original("public-constraints-plugin")))
    zip.addFile(
      "board_core/board_config.json",
      Buffer.from(
        JSON.stringify({
          apiVersion: 1,
          inspectCommands: {
            [process.platform]: {
              knowledge_path: "${pluginPath}/knowledge",
              pull_knowledge: `"${process.execPath}" "\${pluginPath}/pull.cjs"`
            }
          }
        })
      )
    )
    zip.addFile(
      "pull.cjs",
      Buffer.from(`const fs=require("node:fs"),path=require("node:path")
const root=path.join(__dirname,"knowledge")
fs.mkdirSync(root,{recursive:true})
fs.writeFileSync(path.join(root,"AGENTS.md"),"# 公共系统约束\\n可预览")
console.log(JSON.stringify({ok:true,path:root}))`)
    )
    expect(
      (
        await invoke("plugins:install", {
          buffer: bytes(zip.toBuffer()),
          fileName: "public.zip",
          origin: "market"
        })
      ).success
    ).toBe(true)
    const plugin = storage.getPlugins().find((p) => p.name === "public-constraints-plugin")!
    const result = await syncHarnessProjectConstraints(plugin.id)
    expect(result.path).toBe(join(plugin.path, "knowledge"))
    const stored = join(plugin.path, "knowledge", "AGENTS.md")
    expect(readFileSync(stored, "utf8")).toContain(MARKET_CONTENT_PREFIX)
    cleanupMarketRuntimeContent()
    const preview = authorizeKnowledgePreview(
      readHarnessKnowledgePreview(
        plugin.id,
        {
          openworkDir: home,
          pluginStorePath: join(home, "plugins.json"),
          leanTokenStorePath: join(home, "leanstar-config.json")
        },
        512 * 1024
      ),
      92
    )
    expect(preview.error).toBeUndefined()
    expect(preview.previewGrant).toBeTruthy()
    const resolved = await resolveExternalFileReadGrant(preview.previewGrant, 92, stored)
    expect(resolved).not.toHaveProperty("error")
    if ("error" in resolved) throw new Error(resolved.error)
    const page = await readPreviewTextPage(
      { externalFullPath: resolved.filePath, trustedRootPath: resolved.rootPath },
      undefined,
      0,
      new Int32Array(new SharedArrayBuffer(4))
    )
    expect(page.result.content).toBe("# 公共系统约束\n可预览")
    expect(await resolveExternalFileReadGrant(preview.previewGrant, 93, stored)).toHaveProperty(
      "error",
      "Sender mismatch"
    )
    expect(
      await resolveExternalFileReadGrant(
        preview.previewGrant,
        92,
        join(plugin.path, "skills/action/SKILL.md")
      )
    ).toHaveProperty("error")
    revokeExternalFileReadGrantsForOwner(92)
  }, 60_000)

  it("protects market skills and rejects all original-file access endpoints", async () => {
    const zip = new AdmZip()
    zip.addFile("SKILL.md", Buffer.from(original("market-analysis")))
    zip.addFile("notes.txt", Buffer.from("private reference"))
    zip.addFile(
      "run.cjs",
      Buffer.from(
        'console.log(require("fs").readFileSync(require("path").join(__dirname, "notes.txt"), "utf8"))'
      )
    )
    zip.addFile("nested/SKILL.md", Buffer.from(original("nested-market")))
    zip.addFile("asset.bin", Buffer.from([0, 255]))
    const result = await invoke("skills:upload", {
      buffer: bytes(zip.toBuffer()),
      fileName: "skill.zip",
      options: { origin: "market" }
    })
    expect(result.success, result.error).toBe(true)
    const skill = (await skills.listAllSkills()).find((item) => item.name === "market-analysis")!
    expect(skill.contentOrigin).toBe("market")
    expect(
      (await skills.listAllSkills()).find((item) => item.name === "nested-market")?.contentOrigin
    ).toBe("market")
    expect(readFileSync(skill.path, "utf8")).toContain(MARKET_CONTENT_PREFIX)
    expect(
      readFileSync(join(storage.getCustomSkillsDir(), "market-analysis", "notes.txt"), "utf8")
    ).toBe("private reference")
    expect(
      readFileSync(join(storage.getCustomSkillsDir(), "market-analysis", "asset.bin"))
    ).toEqual(Buffer.from([0, 255]))
    expect(readContentFileSync(skill.path, "utf8")).toContain("企业内部知识步骤")
    for (const channel of [
      "skills:read",
      "skills:readBinary",
      "skills:listFiles",
      "skills:readTextBundle",
      "skills:exportForMarket"
    ]) {
      const denied = await invoke(channel, skill.path)
      expect(denied.success, channel).toBe(false)
      expect(denied.error).toContain("受保护")
    }
    expect(
      (await invoke("skills:write", { skillPath: skill.path, content: "changed" })).success
    ).toBe(false)
    expect(
      (
        await invoke("skills:backupForCloudEvolution", {
          skillPath: skill.path,
          candidateId: "candidate",
          skillName: skill.name
        })
      ).success
    ).toBe(false)
  })

  it("keeps original uploads plain, viewable, editable and exportable", async () => {
    const md = original("original-analysis")
    expect(
      (await invoke("skills:upload", { buffer: bytes(Buffer.from(md)), fileName: "original.md" }))
        .success
    ).toBe(true)
    const skill = (await skills.listAllSkills()).find((item) => item.name === "original-analysis")!
    expect(skill.contentOrigin).toBe("local")
    expect(readFileSync(skill.path, "utf8")).toBe(md)
    expect((await invoke("skills:read", skill.path)).content).toBe(md)
    expect(
      (await invoke("skills:write", { skillPath: skill.path, content: md + "\nedit" })).success
    ).toBe(true)
    expect((await invoke("skills:exportForMarket", skill.path)).success).toBe(true)
  })

  it("keeps installed legacy skills unchanged when reading the catalog", async () => {
    const root = join(storage.getCustomSkillsDir(), "legacy-market")
    mkdirSync(root)
    writeFileSync(join(root, "SKILL.md"), original("legacy-market"))
    const content = readFileSync(join(root, "SKILL.md"))
    await skills.listAllSkills()
    expect(readFileSync(join(root, "SKILL.md"))).toEqual(content)
    expect(handlers.has("skills:protectMarketInstalls")).toBe(false)
  })

  it("encodes plugin Markdown while keeping executable assets and configuration plain", async () => {
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(JSON.stringify({ name: "market-plugin", version: "1.0.0" }))
    )
    zip.addFile("skills/action/SKILL.md", Buffer.from(original("plugin-action")))
    zip.addFile(
      "hooks/hooks.json",
      Buffer.from(
        JSON.stringify([
          { id: "pre", event: "PreToolUse", type: "command", command: "echo private-hook" }
        ])
      )
    )
    zip.addFile(
      ".mcp.json",
      Buffer.from(
        JSON.stringify({ mcpServers: { local: { command: "node", args: ["./run.cjs"] } } })
      )
    )
    zip.addFile("run.cjs", Buffer.from("console.log('working')"))
    zip.addFile(".git/config", Buffer.from("[core]\nrepositoryformatversion = 0\n"))
    zip.addFile("sys/.git", Buffer.from("gitdir: ../.git/modules/sys\n"))
    const installed = await invoke("plugins:install", {
      buffer: bytes(zip.toBuffer()),
      fileName: "plugin.zip",
      origin: "market"
    })
    expect(installed.success, installed.error).toBe(true)
    let plugin = storage.getPlugins().find((item) => item.name === "market-plugin")!
    expect(JSON.parse(readFileSync(join(plugin.path, "plugin.json"), "utf8"))).toMatchObject({
      name: "market-plugin"
    })
    expect(readFileSync(join(plugin.path, "skills/action/SKILL.md"), "utf8")).toContain(
      MARKET_CONTENT_PREFIX
    )
    expect(readFileSync(join(plugin.path, "run.cjs"), "utf8")).toBe("console.log('working')")
    expect(JSON.parse(readFileSync(join(plugin.path, ".mcp.json"), "utf8"))).toHaveProperty(
      "mcpServers.local.command",
      "node"
    )
    expect(readFileSync(join(plugin.path, ".git", "config"), "utf8")).toBe(
      "[core]\nrepositoryformatversion = 0\n"
    )
    expect(readFileSync(join(plugin.path, "sys", ".git"), "utf8")).toBe(
      "gitdir: ../.git/modules/sys\n"
    )
    const detail = await invoke("plugins:getDetail", plugin.id)
    expect(detail.skills).toContain("plugin-action")
    expect(detail.hookCount).toBe(1)
    expect(detail.hooks).toEqual([])
    expect(detail.mcpServerDetails).toEqual([])
    expect(
      storage.getEnabledPluginHookMetadata().some((hook) => hook.command === "echo private-hook")
    ).toBe(true)
    const mcp = storage.getEnabledPluginMcpConfigs()[`plugin:${plugin.id}/local`]
    expect(mcp.args?.[0]).not.toBe(join(plugin.path, "run.cjs"))
    expect(readFileSync(mcp.args![0], "utf8")).toBe("console.log('working')")
    for (const [channel, payload] of [
      ["plugins:listFiles", plugin.id],
      ["plugins:read", { pluginId: plugin.id, filePath: join(plugin.path, "plugin.json") }],
      [
        "plugins:write",
        { pluginId: plugin.id, filePath: join(plugin.path, "plugin.json"), content: "{}" }
      ],
      ["plugins:exportForMarket", plugin.id]
    ] as const)
      expect((await invoke(channel, payload)).success, channel).toBe(false)
    await invoke("plugins:setOriginsBatch", { updates: [{ id: plugin.id, origin: "local" }] })
    expect(storage.getPlugins().find((item) => item.id === plugin.id)?.origin).toBe("market")
    // A real original ZIP is still allowed to replace an installed market version.
    expect(
      (
        await invoke("plugins:install", {
          buffer: bytes(zip.toBuffer()),
          fileName: "original.zip",
          origin: "local"
        })
      ).success
    ).toBe(true)
    plugin = storage.getPlugins().find((item) => item.name === "market-plugin")!
    expect(plugin.origin).toBe("local")
    expect((await invoke("plugins:listFiles", plugin.id)).success).toBe(true)
    expect(
      (
        await invoke("plugins:read", {
          pluginId: plugin.id,
          filePath: join(plugin.path, "run.cjs")
        })
      ).content
    ).toContain("working")
    expect(
      (
        await invoke("plugins:write", {
          pluginId: plugin.id,
          filePath: join(plugin.path, "run.cjs"),
          content: "original edited"
        })
      ).success
    ).toBe(true)
  })

  it("refuses to import copied encoded resources as originals", async () => {
    const skill = (await skills.listAllSkills()).find((item) => item.name === "market-analysis")!
    const result = await invoke("skills:upload", {
      buffer: bytes(readFileSync(skill.path)),
      fileName: "copy.md"
    })
    expect(result.success).toBe(false)
    const zip = new AdmZip()
    zip.addLocalFolder(join(storage.getCustomSkillsDir(), "market-analysis"))
    const copied = await invoke("skills:upload", {
      buffer: bytes(zip.toBuffer()),
      fileName: "copy.zip"
    })
    expect(copied.success).toBe(false)
    expect(copied.error).toContain("受保护")
    expect(existsSync(skill.path)).toBe(true)
  })

  it.each(["plugin", "skill"])(
    "keeps workspace reports plain when a market %s script copies Markdown templates",
    async (kind) => {
      const { LocalSandbox } = await import("../agent/local-sandbox")
      const name = `markdown-output-${kind}`
      const zip = new AdmZip()
      zip.addFile("SKILL.md", Buffer.from(original(name)))
      zip.addFile("template.md", Buffer.from("# 工作报告\n模板内容\n"))
      zip.addFile(
        "run.cjs",
        Buffer.from(`const fs = require("node:fs"), path = require("node:path")
fs.copyFileSync(path.join(__dirname, "template.md"), path.join(process.cwd(), "copied.md"))
fs.writeFileSync(path.join(process.cwd(), "rendered.md"), fs.readFileSync(path.join(__dirname, "template.md"), "utf8") + "Result")
if (process.env.PLUGIN_ROOT) fs.copyFileSync(path.join(process.env.PLUGIN_ROOT, "template.md"), path.join(process.cwd(), "env.md"))`)
      )
      if (kind === "plugin") {
        zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name })))
        zip.addFile(
          ".mcp.json",
          Buffer.from(
            JSON.stringify({
              mcpServers: {
                local: {
                  command: process.execPath,
                  args: ["./run.cjs"],
                  env: { PLUGIN_ROOT: "${PLUGIN_ROOT}" }
                }
              }
            })
          )
        )
      }
      const installed = await invoke(kind === "plugin" ? "plugins:install" : "skills:upload", {
        buffer: bytes(zip.toBuffer()),
        fileName: `${name}.zip`,
        ...(kind === "plugin" ? { origin: "market" } : { options: { origin: "market" } })
      })
      expect(installed.success, installed.error).toBe(true)
      const plugin = storage.getPlugins().find((item) => item.name === name)
      const root = plugin?.path ?? join(storage.getCustomSkillsDir(), name)
      const workspace = join(home, `${name}-workspace`)
      mkdirSync(workspace)
      const sandbox = new LocalSandbox({
        rootDir: workspace,
        runId: name,
        windowsSandbox: "none",
        ...(plugin ? { pluginRoot: plugin.path } : {})
      })
      const prefix = /(?:pwsh|powershell)(?:\.exe)?$/i.test(LocalSandbox.resolvedShell())
        ? "& "
        : ""
      const result = await sandbox.executeRaw(
        `${prefix}"${process.execPath}" "${join(root, "run.cjs")}"`
      )
      expect(result.exitCode, result.output).toBe(0)
      expect(readFileSync(join(workspace, "copied.md"), "utf8")).toBe("# 工作报告\n模板内容\n")
      expect(readFileSync(join(workspace, "rendered.md"), "utf8")).toBe(
        "# 工作报告\n模板内容\nResult"
      )
      if (plugin) {
        expect(readFileSync(join(workspace, "env.md"), "utf8")).toBe("# 工作报告\n模板内容\n")
        const mcpWorkspace = join(home, `${name}-mcp-workspace`)
        mkdirSync(mcpWorkspace)
        const mcp = storage.getEnabledPluginMcpConfigs()[`plugin:${plugin.id}/local`]
        execFileSync(mcp.command!, mcp.args!, {
          cwd: mcpWorkspace,
          env: { ...process.env, ...mcp.env }
        })
        expect(readFileSync(join(mcpWorkspace, "copied.md"), "utf8")).toBe("# 工作报告\n模板内容\n")
        expect(readFileSync(join(mcpWorkspace, "env.md"), "utf8")).toBe("# 工作报告\n模板内容\n")
      }
      expect(readFileSync(join(root, "template.md"), "utf8")).toContain(MARKET_CONTENT_PREFIX)
      expect(readFileSync(join(root, "run.cjs"), "utf8")).not.toContain(MARKET_CONTENT_PREFIX)
    },
    60_000
  )

  it("permits original plugin evolution before any standalone skill is installed", async () => {
    const customDir = storage.getCustomSkillsDir()
    const saved = customDir + "-saved"
    renameSync(customDir, saved)
    try {
      const plugin = storage.getPlugins().find((item) => item.name === "market-plugin")!
      const skillPath = join(plugin.path, "skills", "action", "SKILL.md")
      const evolved = original("plugin-action") + "\noriginal update"
      const result = await invoke("skills:applyPluginSkillEvolution", {
        skillPath,
        candidateId: "fresh-original",
        skillName: "plugin-action",
        buffer: bytes(Buffer.from(evolved)),
        fileName: "SKILL.md"
      })
      expect(result.success, result.error).toBe(true)
      expect(readFileSync(skillPath, "utf8")).toBe(evolved)
    } finally {
      renameSync(saved, customDir)
    }
  })

  it("lets the agent discover and read protected skills while rejecting mutations", async () => {
    const { LocalSandbox } = await import("../agent/local-sandbox")
    const skill = (await skills.listAllSkills()).find((item) => item.name === "market-analysis")!
    const sandbox = new LocalSandbox({
      rootDir: home,
      runId: "market-regression",
      windowsSandbox: "none"
    })
    expect(await sandbox.read(skill.path)).toContain("企业内部知识步骤")
    const [downloaded] = await sandbox.downloadFiles([skill.path])
    expect(Buffer.from(downloaded.content!).toString()).toBe(original("market-analysis"))
    expect((await sandbox.edit(skill.path, "企业", "changed")).error).toBeTruthy()
    expect(
      (await sandbox.write(join(storage.getCustomSkillsDir(), "market-analysis", "new.txt"), "new"))
        .error
    ).toBeTruthy()
    expect((await sandbox.uploadFiles([[skill.path, Buffer.from("new")]]))[0].error).toBeTruthy()
    expect(
      await sandbox.grepRaw(
        "企业内部知识步骤",
        join(storage.getCustomSkillsDir(), "market-analysis")
      )
    ).toEqual(expect.arrayContaining([expect.objectContaining({ text: "企业内部知识步骤" })]))
    await LocalSandbox.ensureShellReady("none")
    const prefix = /(?:pwsh|powershell)(?:\.exe)?$/i.test(LocalSandbox.resolvedShell()) ? "& " : ""
    const execution = await sandbox.executeRaw(
      `${prefix}"${process.execPath}" "${join(storage.getCustomSkillsDir(), "market-analysis", "run.cjs")}"`
    )
    expect(execution.exitCode, execution.output).toBe(0)
    expect(execution.output).toContain("private reference")
  }, 60_000)

  it("preserves market hook enablement in plain JSON configuration", async () => {
    const zip = new AdmZip()
    zip.addFile("plugin.json", Buffer.from('{"name":"hook-protected"}'))
    zip.addFile(
      "hooks/hooks.json",
      Buffer.from(
        JSON.stringify([
          {
            id: "pre",
            enabled: true,
            event: "PreToolUse",
            type: "command",
            command: "echo private-hook"
          }
        ])
      )
    )
    expect(
      (
        await invoke("plugins:install", {
          buffer: bytes(zip.toBuffer()),
          fileName: "hook.zip",
          origin: "market"
        })
      ).success
    ).toBe(true)
    const plugin = storage.getPlugins().find((item) => item.name === "hook-protected")!
    const hook = storage.getPluginHooks(plugin.id)[0]
    storage.setPluginHookEnabled(plugin.id, hook.id, false)
    expect(storage.getPluginHooks(plugin.id)[0].enabled).toBe(false)
    expect(
      JSON.parse(readFileSync(join(plugin.path, "hooks", "hooks.json"), "utf8"))[0].enabled
    ).toBe(false)
  })

  it("lets hooks copy decoded Markdown into the workspace via environment and payload paths", async () => {
    const { runHooks } = await import("../hooks/runner")
    const root = mkdtempSync(join(home, "hook-runtime-"))
    writeFileSync(join(root, "notes.md"), "hook-runtime-secret")
    writeFileSync(
      join(root, "hook.cjs"),
      `const fs = require("fs"), path = require("path"); let input = ""; process.stdin.on("data", value => input += value); process.stdin.on("end", () => { const payload = JSON.parse(input); fs.copyFileSync(path.join(process.env.PLUGIN_ROOT, "notes.md"), path.join(process.cwd(), "hook-env.md")); fs.copyFileSync(path.join(payload.plugin_root, "notes.md"), path.join(process.cwd(), "hook-payload.md")); console.log(fs.readFileSync(path.join(__dirname, "notes.md"), "utf8")); });`
    )
    protectMarketDirectory(root)
    let hookOutput = ""
    const result = await runHooks(
      [
        {
          id: "market-runtime",
          event: "PreToolUse",
          matcher: "*",
          type: "command",
          enabled: true,
          command: `"${process.execPath}" "${join(root, "hook.cjs")}"`,
          createdAt: "2026-10-19",
          updatedAt: "2026-10-19"
        }
      ],
      "PreToolUse",
      { pluginRoot: root, workspacePath: home, toolName: "read_file" },
      (_event, _hook, result) => {
        hookOutput = result.stdout
      }
    )
    expect(result?.exitCode, result?.stderr).toBe(0)
    expect(hookOutput).toContain("hook-runtime-secret")
    expect(readFileSync(join(home, "hook-env.md"), "utf8")).toBe("hook-runtime-secret")
    expect(readFileSync(join(home, "hook-payload.md"), "utf8")).toBe("hook-runtime-secret")
    expect(readFileSync(join(root, "notes.md"), "utf8")).toContain(MARKET_CONTENT_PREFIX)
    expect(readFileSync(join(root, "hook.cjs"), "utf8")).not.toContain(MARKET_CONTENT_PREFIX)
  })

  it.each(["hooks.json", "hooks.md"])(
    "keeps the correct encoding when toggling CC hooks in %s",
    async (hookFile) => {
      const zip = new AdmZip()
      const name = "cc-" + hookFile.replace(".", "-")
      zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name, hooks: hookFile })))
      zip.addFile(
        hookFile,
        Buffer.from(
          JSON.stringify({
            hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo cc-hook" }] }] }
          })
        )
      )
      const installed = await invoke("plugins:install", {
        buffer: bytes(zip.toBuffer()),
        fileName: "cc.zip",
        origin: "market"
      })
      expect(installed.success, installed.error).toBe(true)
      const plugin = storage.getPlugins().find((item) => item.name === name)!
      const hook = storage.getPluginHooks(plugin.id)[0]
      storage.setPluginHookEnabled(plugin.id, hook.id, false)
      expect(storage.getPluginHooks(plugin.id)[0].enabled).toBe(false)
      const stored = readFileSync(join(plugin.path, hookFile), "utf8")
      expect(stored.startsWith(MARKET_CONTENT_PREFIX)).toBe(hookFile.endsWith(".md"))
      expect(
        JSON.parse(readContentFileSync(join(plugin.path, hookFile), "utf8")).hooks.PreToolUse[0]
          .hooks[0].enabled
      ).toBe(false)
    }
  )

  it.skipIf(process.platform !== "win32")(
    "preserves project hook execution after runtime path mapping",
    async () => {
      const { LocalSandbox } = await import("../agent/local-sandbox")
      const plugin = storage.getPlugins().find((item) => item.name === "hook-protected")!
      const hookPath = join(plugin.path, "hooks", "run.cjs")
      writeFileSync(hookPath, "console.log('protected-project-hook')")
      protectMarketDirectory(plugin.path)
      const sandbox = new LocalSandbox({
        rootDir: home,
        runId: "protected-project-hook",
        windowsSandbox: "readonly",
        pluginRoot: plugin.path
      })
      const prefix = /(?:pwsh|powershell)(?:\.exe)?$/i.test(LocalSandbox.resolvedShell())
        ? "& "
        : ""
      const result = await sandbox.executeRaw(`${prefix}"${process.execPath}" "${hookPath}"`)
      expect(result.exitCode, result.output).toBe(0)
      expect(result.output).toContain("protected-project-hook")
    }
  )

  it("executes ordinary commands before a custom skills directory exists", async () => {
    const { LocalSandbox } = await import("../agent/local-sandbox")
    const custom = storage.getCustomSkillsDir()
    const backup = `${custom}-test-backup`
    renameSync(custom, backup)
    try {
      const sandbox = new LocalSandbox({
        rootDir: home,
        runId: "fresh-install",
        windowsSandbox: "none"
      })
      const result = await sandbox.executeRaw("echo fresh-install")
      expect(result.exitCode, result.output).toBe(0)
      expect(result.output).toContain("fresh-install")
    } finally {
      renameSync(backup, custom)
    }
  })

  it("restores old encoded assets at registration without protecting unmarked legacy installs", async () => {
    const skillRoot = join(storage.getCustomSkillsDir(), "encoded-old-skill")
    mkdirSync(skillRoot)
    writeFileSync(
      join(skillRoot, MARKET_CONTENT_MARKER),
      '{"version":1,"origin":"market","complete":true}'
    )
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      encodeMarketContent(Buffer.from(original("encoded-old-skill")))
    )
    writeFileSync(join(skillRoot, "script.py"), encodeMarketContent(Buffer.from("print('works')")))
    const pluginRoot = join(storage.getPluginsDir(), "encoded-old-plugin")
    mkdirSync(pluginRoot)
    writeFileSync(
      join(pluginRoot, MARKET_CONTENT_MARKER),
      '{"version":1,"origin":"market","complete":true}'
    )
    writeFileSync(
      join(pluginRoot, "plugin.json"),
      encodeMarketContent(Buffer.from('{"name":"encoded-old-plugin"}'))
    )
    writeFileSync(
      join(pluginRoot, "SKILL.md"),
      encodeMarketContent(Buffer.from(original("encoded-old-plugin")))
    )
    storage.upsertPlugin({
      id: "encoded-old-plugin",
      name: "encoded-old-plugin",
      path: pluginRoot,
      origin: "market",
      version: "1.0.0",
      description: "",
      author: "",
      enabled: true,
      skillCount: 1,
      mcpServerCount: 0,
      createdAt: "",
      updatedAt: ""
    })
    const ipc = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }
    const { registerPluginHandlers } = await import("./plugins")
    skills.registerSkillsHandlers(ipc as never)
    registerPluginHandlers(ipc as never)
    expect(readFileSync(join(skillRoot, "script.py"), "utf8")).toBe("print('works')")
    expect(JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8"))).toMatchObject({
      name: "encoded-old-plugin"
    })
    expect(readFileSync(join(pluginRoot, "SKILL.md"), "utf8")).toContain(MARKET_CONTENT_PREFIX)
    expect((await invoke("skills:read", join(skillRoot, "SKILL.md"))).success).toBe(false)
  })

  it("registers downstream IPC without migrating legacy or partially protected plugins", async () => {
    const snapshots = new Map<string, Buffer>()
    const record = (file: string, content: Buffer | string): void => {
      writeFileSync(file, content)
      snapshots.set(file, readFileSync(file))
    }
    const roots: string[] = []
    for (const name of ["legacy-plain", "legacy-partial", "legacy-failing", "legacy-unknown"]) {
      const root = join(storage.getPluginsDir(), name)
      roots.push(root)
      mkdirSync(join(root, "sys", ".git", "objects", "pack"), { recursive: true })
      record(join(root, "plugin.json"), JSON.stringify({ name }))
      record(join(root, "SKILL.md"), original(name))
      record(join(root, "sys", ".git", "objects", "pack", "fixture.idx"), "git metadata")
      if (name === "legacy-partial") {
        record(
          join(root, "SKILL.md"),
          MARKET_CONTENT_PREFIX + Buffer.from(original(name)).toString("base64")
        )
        record(join(root, ".cmb-market-content.json"), '{"version":1,"complete":false}')
        record(
          join(root, "sys", ".git", "objects", "pack", "fixture.idx"),
          MARKET_CONTENT_PREFIX + Buffer.from("git metadata").toString("base64")
        )
      } else if (name === "legacy-failing") {
        // The old startup migration throws when trying to overwrite this path.
        mkdirSync(join(root, ".cmb-market-content.json"))
      }
      storage.upsertPlugin({
        id: name,
        name,
        version: "1.0.0",
        description: "",
        author: "",
        path: root,
        enabled: true,
        skillCount: 1,
        mcpServerCount: 0,
        ...(name === "legacy-unknown" ? {} : { origin: "market" as const }),
        createdAt: "",
        updatedAt: ""
      })
    }
    const channels = new Map<string, (...args: unknown[]) => unknown>()
    const ipc = {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        channels.set(channel, handler),
      on: vi.fn()
    }
    const { registerPluginHandlers } = await import("./plugins")
    const { registerPluginFileHandlers } = await import("./plugin-files")
    const { registerSandboxHandlers } = await import("./sandbox")
    const { registerHooksHandlers } = await import("./hooks")
    const { registerRoutingHandlers } = await import("./routing")
    const { registerNotificationHandlers } = await import("./notifications")
    const { registerLspHandlers } = await import("./lsp")
    registerPluginHandlers(ipc as never)
    registerPluginFileHandlers(ipc as never)
    registerSandboxHandlers(ipc as never)
    registerHooksHandlers(ipc as never)
    registerRoutingHandlers(ipc as never)
    registerNotificationHandlers(ipc as never)
    registerLspHandlers(ipc as never)
    for (const channel of [
      "plugins:list",
      "plugins:listFiles",
      "sandbox:getMode",
      "hooks:list",
      "routing:getMode",
      "appNotifications:list",
      "lsp:getConfig"
    ]) {
      expect(channels.has(channel), channel).toBe(true)
    }
    storage.setPluginOriginsBatch([{ id: "legacy-unknown", origin: "market" }])
    for (const [file, content] of snapshots) expect(readFileSync(file).equals(content)).toBe(true)
    expect(existsSync(join(roots[0], ".cmb-market-content.json"))).toBe(false)
    expect(existsSync(join(roots[3], ".cmb-market-content.json"))).toBe(false)
  }, 60_000)
})
