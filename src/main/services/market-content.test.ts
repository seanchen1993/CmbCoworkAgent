import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  assertOriginalContent,
  assertOriginalDirectory,
  assertOriginalUpload,
  cleanupMarketRuntimeContent,
  isMarketProtectionComplete,
  decodeMarketContent,
  encodeMarketContent,
  findProtectedMarketRoot,
  MARKET_CONTENT_MARKER,
  MARKET_CONTENT_PREFIX,
  materializeMarketRuntimeRoot,
  prepareMarketCommand,
  protectMarketDirectory,
  readContentFile,
  readContentFileSync
} from "./market-content"
import { discoverSkills, discoverSkillsSync } from "../skills/discovery"
import { SkillUsageDetector } from "../agent/skill-evolution/usage-detector"
import { loadAgentProfiles, loadAgentProfilesAsync } from "../agent/agent-registry"
import { readSkillPluginCatalogPage } from "../skill-plugin-catalog/reader"
import {
  issueExternalFileReadGrant,
  resolveExternalFileReadGrant
} from "./external-file-read-tokens"

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cmb-market-content-test-"))
  roots.push(root)
  return root
}

afterEach(() => {
  cleanupMarketRuntimeContent()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("market content storage and runtime", () => {
  it("round-trips Unicode, empty content and every binary byte without guessing plain text", () => {
    for (const content of [
      Buffer.from("企业知识\n🦀"),
      Buffer.alloc(0),
      Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    ]) {
      const encoded = encodeMarketContent(content)
      expect(encoded.toString()).toMatch(/^CMB-MARKET-BASE64-V1\n/)
      expect(decodeMarketContent(encoded)).toEqual(content)
    }
    expect(decodeMarketContent(Buffer.from("ordinary text"))).toEqual(Buffer.from("ordinary text"))
    expect(() => decodeMarketContent(Buffer.from(MARKET_CONTENT_PREFIX + "broken!"))).toThrow(
      "损坏"
    )
    expect(() => decodeMarketContent(Buffer.from(MARKET_CONTENT_PREFIX + "Zh=="))).toThrow("损坏")
  })

  it("round-trips a large binary asset and resumes an interrupted migration", () => {
    const content = Buffer.alloc(2 * 1024 * 1024, 0xff)
    expect(decodeMarketContent(encodeMarketContent(content)).equals(content)).toBe(true)
    const root = fixture()
    writeFileSync(join(root, "SKILL.md"), encodeMarketContent(Buffer.from("encoded")))
    writeFileSync(join(root, "notes.txt"), "not encoded yet")
    writeFileSync(join(root, MARKET_CONTENT_MARKER), '{"complete":false}')
    expect(isMarketProtectionComplete(root)).toBe(false)
    protectMarketDirectory(root)
    expect(isMarketProtectionComplete(root)).toBe(true)
    expect(readContentFileSync(join(root, "SKILL.md"), "utf8")).toBe("encoded")
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toContain(MARKET_CONTENT_PREFIX)
  })

  it("preserves packed Git metadata and read-only indexes in newly protected bundles", () => {
    const root = fixture()
    const repo = join(root, "sys")
    mkdirSync(repo)
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", repo, "-c", "core.hooksPath=", ...args], {
        encoding: "utf8"
      })
    git("init", "--quiet")
    git("config", "user.name", "Market regression")
    git("config", "user.email", "market-test@example.invalid")
    git("config", "core.autocrlf", "false")
    writeFileSync(join(repo, "script.cjs"), "console.log('market-script')\n")
    git("add", "script.cjs")
    git("commit", "--quiet", "-m", "fixture")
    git("gc", "--prune=now", "--quiet")
    const gitRoot = join(repo, ".git")
    const metadata = new Map<string, Buffer>()
    const snapshot = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name)
        if (entry.isDirectory()) snapshot(file)
        else if (entry.isFile()) metadata.set(file, readFileSync(file))
      }
    }
    snapshot(gitRoot)
    const index = [...metadata.keys()].find((file) => file.endsWith(".idx"))!
    expect(index).toBeTruthy()
    expect(statSync(index).mode & 0o200).toBe(0)
    const head = git("rev-parse", "HEAD")
    protectMarketDirectory(root)
    for (const [file, bytes] of metadata) expect(readFileSync(file).equals(bytes)).toBe(true)
    expect(statSync(index).mode & 0o200).toBe(0)
    expect(git("rev-parse", "HEAD")).toBe(head)
    git("fsck", "--full")
    expect(readFileSync(join(repo, "script.cjs"), "utf8")).toContain(MARKET_CONTENT_PREFIX)
    const runtime = materializeMarketRuntimeRoot(root)
    expect(
      execFileSync("git", ["-C", join(runtime, "sys"), "rev-parse", "HEAD"], { encoding: "utf8" })
    ).toBe(head)
  })

  it("leaves gitdir pointer files unchanged in new bundles", () => {
    const root = fixture()
    const repo = join(root, "sys")
    mkdirSync(repo)
    const pointer = "gitdir: ../other-repository/.git/worktrees/sys\n"
    writeFileSync(join(repo, ".git"), pointer)
    writeFileSync(join(repo, "SKILL.md"), "private instructions")
    protectMarketDirectory(root)
    expect(readFileSync(join(repo, ".git"), "utf8")).toBe(pointer)
    expect(readFileSync(join(repo, "SKILL.md"), "utf8")).toContain(MARKET_CONTENT_PREFIX)
    expect(readFileSync(join(materializeMarketRuntimeRoot(root), "sys", ".git"), "utf8")).toBe(
      pointer
    )
  })

  it("encodes every asset once and preserves nested skill discovery and decoded runtime reads", async () => {
    const root = fixture()
    mkdirSync(join(root, "child"))
    const md = "---\nname: 企业分析\ndescription: 分析报告\n---\n机密步骤"
    writeFileSync(join(root, "SKILL.md"), md)
    writeFileSync(join(root, "child", "SKILL.md"), "---\nname: nested\n---\nchild body")
    writeFileSync(join(root, "asset.bin"), Buffer.from([0, 128, 255]))
    protectMarketDirectory(root)
    const encoded = readFileSync(join(root, "SKILL.md"))
    expect(encoded.toString()).not.toContain("机密步骤")
    expect(readFileSync(join(root, "asset.bin"), "utf8")).toContain(MARKET_CONTENT_PREFIX)
    protectMarketDirectory(root)
    expect(readFileSync(join(root, "SKILL.md"))).toEqual(encoded)
    expect(readContentFileSync(join(root, "SKILL.md"), "utf8")).toBe(md)
    expect(await readContentFile(join(root, "asset.bin"))).toEqual(Buffer.from([0, 128, 255]))
    expect((await discoverSkills(root)).map((skill) => skill.name)).toEqual(["企业分析", "nested"])
    expect(discoverSkillsSync(root).map((skill) => skill.name)).toEqual(["企业分析", "nested"])
    expect(findProtectedMarketRoot(join(root, "child", "new.md"))).toBe(root)
    expect(() => assertOriginalContent(join(root, "child", "SKILL.md"))).toThrow("受保护")
  })

  it("runs an external script with its relative binary and text resources, then cleans up", () => {
    const root = fixture()
    writeFileSync(join(root, "data.txt"), "企业知识")
    writeFileSync(join(root, "asset.bin"), Buffer.from([0, 255]))
    writeFileSync(
      join(root, "run.cjs"),
      `const fs = require("fs"); const path = require("path"); console.log(fs.readFileSync(path.join(__dirname, "data.txt"), "utf8")); console.log(fs.readFileSync(path.join(__dirname, "asset.bin")).toString("hex"))`
    )
    protectMarketDirectory(root)
    const runtime = materializeMarketRuntimeRoot(root)
    expect(materializeMarketRuntimeRoot(root)).toBe(runtime)
    expect(execFileSync(process.execPath, [join(runtime, "run.cjs")], { encoding: "utf8" })).toBe(
      "企业知识\n00ff\n"
    )
    const prepared = prepareMarketCommand(`node "${join(root, "run.cjs")}"`, root, [root])
    expect(prepared.command).toContain(runtime)
    expect(prepared.cwd).toBe(runtime)
    expect(readFileSync(join(root, "run.cjs"), "utf8")).toContain(MARKET_CONTENT_PREFIX)
    cleanupMarketRuntimeContent()
    expect(existsSync(runtime)).toBe(false)
  })

  it("keeps originals readable and refuses encoded copies uploaded as originals", () => {
    const root = fixture()
    writeFileSync(join(root, "SKILL.md"), "original")
    assertOriginalDirectory(root)
    expect(readContentFileSync(join(root, "SKILL.md"), "utf8")).toBe("original")
    expect(() =>
      assertOriginalUpload(encodeMarketContent(Buffer.from("secret")), "SKILL.md")
    ).toThrow("受保护")
    expect(() =>
      assertOriginalUpload(Buffer.from("{}"), `plugin/${MARKET_CONTENT_MARKER}`)
    ).toThrow("受保护")
  })

  it("keeps the version in usage attribution for protected skills", () => {
    const root = fixture()
    const skillPath = join(root, "SKILL.md")
    writeFileSync(skillPath, "---\nname: market-usage\nversion: 2.3.4\n---\nprivate")
    protectMarketDirectory(root)
    const detector = new SkillUsageDetector()
    detector.onSkillsMetadata([{ name: "market-usage", path: skillPath }])
    expect(detector.onReadFilePath(skillPath)).toBe(true)
    expect(detector.getUsedSkillNames()).toEqual(["market-usage-v2.3.4"])
  })

  it("loads protected subagents through both registries with the original prompt byte limit", async () => {
    const root = fixture()
    const agentPath = join(root, "agent.md")
    const oversizedPath = join(root, "oversized.md")
    const prompt = "x".repeat(220_000)
    writeFileSync(agentPath, "---\nname: market-agent\ntools: Read\n---\n" + prompt)
    writeFileSync(oversizedPath, "---\nname: oversized-agent\n---\n" + "x".repeat(270_000))
    protectMarketDirectory(root)
    const config = {
      disabledBuiltinSubagents: [],
      customSubagentFiles: [agentPath, oversizedPath]
    }
    for (const profiles of [
      loadAgentProfiles(undefined, config),
      await loadAgentProfilesAsync(undefined, config)
    ]) {
      const profile = profiles.find((item) => item.name === "market-agent")
      expect(profile?.shellAccess).toBe("none")
      expect(profile?.systemPrompt === prompt).toBe(true)
      expect(profiles.some((profile) => profile.name === "oversized-agent")).toBe(false)
    }
  })

  it("does not allow a junction to make protected files editable", () => {
    const root = fixture()
    const target = join(root, "market")
    mkdirSync(target)
    writeFileSync(join(target, "SKILL.md"), "private")
    protectMarketDirectory(target)
    const alias = join(root, "alias")
    symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir")
    expect(() => assertOriginalContent(join(alias, "SKILL.md"))).toThrow("受保护")
  })

  it("preserves catalog metadata when an encoded SKILL exceeds the plain-text byte limit", () => {
    const root = fixture()
    const custom = join(root, "custom")
    mkdirSync(join(root, "builtin"))
    const skillRoot = join(custom, "large")
    mkdirSync(skillRoot, { recursive: true })
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "---\nname: large-market\ndescription: description\nversion: v2.0.0\n---\n" +
        "x".repeat(260_000)
    )
    protectMarketDirectory(skillRoot)
    const page = readSkillPluginCatalogPage(
      {
        builtinSkillsDir: join(root, "builtin"),
        customSkillsDir: custom,
        pluginsStorePath: join(root, "plugins.json"),
        disabledSkillsPath: join(root, "disabled.json"),
        disabledSkillsRevision: 0,
        globalRevision: 0
      },
      { kind: "skills" }
    )
    expect(page.skills[0]).toMatchObject({
      name: "large-market",
      version: "v2.0.0",
      contentOrigin: "market"
    })
  })

  it("rejects generic previews of stored and runtime sources, including old grants", async () => {
    const root = fixture()
    const file = join(root, "SKILL.md")
    writeFileSync(file, "secret")
    const old = issueExternalFileReadGrant(root, 91, ["SKILL.md"], "market-test")
    expect("grant" in old).toBe(true)
    protectMarketDirectory(root)
    expect(issueExternalFileReadGrant(root, 91, ["SKILL.md"], "market-test")).toHaveProperty(
      "error"
    )
    expect(
      await resolveExternalFileReadGrant("grant" in old ? old.grant : "", 91, file)
    ).toHaveProperty("error")
    const runtime = materializeMarketRuntimeRoot(root)
    expect(issueExternalFileReadGrant(runtime, 91, ["SKILL.md"], "market-test")).toHaveProperty(
      "error"
    )
  })
})
