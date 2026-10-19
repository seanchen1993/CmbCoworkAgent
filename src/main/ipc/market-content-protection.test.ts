import AdmZip from "adm-zip"
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  cleanupMarketRuntimeContent,
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

describe("market content IPC regression", () => {
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
    // Migration evidence must not accidentally lock a newly uploaded original.
    expect((await invoke("skills:protectMarketInstalls", [skill.name])).success).toBe(true)
    expect((await invoke("skills:read", skill.path)).success).toBe(true)
  })

  it("encodes legacy market skills based on installation evidence", async () => {
    const root = join(storage.getCustomSkillsDir(), "legacy-market")
    mkdirSync(root)
    writeFileSync(join(root, "SKILL.md"), original("legacy-market"))
    expect((await invoke("skills:protectMarketInstalls", ["legacy-market"])).success).toBe(true)
    expect(readFileSync(join(root, "SKILL.md"), "utf8")).toContain(MARKET_CONTENT_PREFIX)
    expect((await invoke("skills:read", join(root, "SKILL.md"))).success).toBe(false)
  })

  it("protects the complete plugin while preserving runtime components and local plugin editing", async () => {
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
    const installed = await invoke("plugins:install", {
      buffer: bytes(zip.toBuffer()),
      fileName: "plugin.zip",
      origin: "market"
    })
    expect(installed.success, installed.error).toBe(true)
    let plugin = storage.getPlugins().find((item) => item.name === "market-plugin")!
    expect(readFileSync(join(plugin.path, "plugin.json"), "utf8")).toContain(MARKET_CONTENT_PREFIX)
    expect(readFileSync(join(plugin.path, "run.cjs"), "utf8")).toContain(MARKET_CONTENT_PREFIX)
    const detail = await invoke("plugins:getDetail", plugin.id)
    expect(detail.skills).toContain("plugin-action")
    expect(detail.hookCount).toBe(1)
    expect(detail.hooks).toEqual([])
    expect(detail.mcpServerDetails).toEqual([])
    expect(
      storage.getEnabledPluginHookMetadata().some((hook) => hook.command === "echo private-hook")
    ).toBe(true)
    const mcp = storage.getEnabledPluginMcpConfigs()[`plugin:${plugin.id}/local`]
    expect(mcp.args?.[0]).not.toContain(plugin.path)
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

  it("preserves market hook enablement without writing plaintext to disk", async () => {
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
    expect(readFileSync(join(plugin.path, "hooks", "hooks.json"), "utf8")).toContain(
      MARKET_CONTENT_PREFIX
    )
  })

  it("executes an encoded hook with decoded environment and stdin resource paths", async () => {
    const { runHooks } = await import("../hooks/runner")
    const root = mkdtempSync(join(home, "hook-runtime-"))
    writeFileSync(join(root, "notes.txt"), "hook-runtime-secret")
    writeFileSync(
      join(root, "hook.cjs"),
      `const fs = require("fs"), path = require("path"); let input = ""; process.stdin.on("data", value => input += value); process.stdin.on("end", () => { const payload = JSON.parse(input); console.log(fs.readFileSync(path.join(process.env.PLUGIN_ROOT, "notes.txt"), "utf8")); console.log(fs.readFileSync(path.join(payload.plugin_root, "notes.txt"), "utf8")); });`
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
    expect(hookOutput.match(/hook-runtime-secret/g)).toHaveLength(2)
    expect(readFileSync(join(root, "hook.cjs"), "utf8")).toContain(MARKET_CONTENT_PREFIX)
  })

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
})
