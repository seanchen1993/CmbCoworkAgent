/**
 * Unit tests for SkillLifecycleRegistry — pure file-system scanning + path resolution.
 *
 * Run:
 *   npx tsx tests/skill-lifecycle.spec.ts
 */

import { existsSync } from "fs"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "fs/promises"
import { tmpdir } from "os"
import { join, sep } from "path"
import { LocalSandbox } from "../src/main/agent/local-sandbox.ts"
import { SkillLifecycleRegistry } from "../src/main/agent/skill-lifecycle/registry.ts"
import type { HookConfig } from "../src/main/hooks/types.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function withTempDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeSkillDoc(
  dir: string,
  relPath: string,
  body: { name?: string; description?: string; raw?: string }
): Promise<string> {
  const fullPath = join(dir, relPath)
  await mkdir(join(fullPath, ".."), { recursive: true })
  if (body.raw) {
    await writeFile(fullPath, body.raw, "utf8")
  } else {
    const fm = ["---", body.name ? `name: ${body.name}` : "", "---", "", "body"]
      .filter(Boolean)
      .join("\n")
    await writeFile(fullPath, fm, "utf8")
  }
  return fullPath
}

function makeHook(
  partial: Partial<HookConfig> & Pick<HookConfig, "event" | "command">
): HookConfig {
  return {
    id: partial.id ?? "test-hook",
    enabled: partial.enabled ?? true,
    type: "command",
    matcher: partial.matcher,
    timeout: 8000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial
  }
}

function nodeCommand(script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64")
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
}

async function testRootSkill(): Promise<void> {
  await withTempDir("skill-root", async (base) => {
    const source = join(base, "skills", "single")
    await writeSkillDoc(source, "SKILL.md", { name: "single-skill" })
    const reg = new SkillLifecycleRegistry([source])
    const match = reg.resolveRead(join(source, "SKILL.md"))
    assert(match !== null, "should match doc path")
    assert(match!.name === "single-skill", `expected name=single-skill got ${match!.name}`)
    assert(match!.rootDir === source, "rootDir should equal source")
  })
}

async function testNestedLayout(): Promise<void> {
  await withTempDir("skill-nested", async (base) => {
    const source = join(base, "skills")
    await writeSkillDoc(source, "alpha/SKILL.md", { name: "alpha" })
    await writeSkillDoc(source, "beta/SKILL.md", { name: "beta" })
    await writeSkillDoc(source, "no-skill-here/README.md", {
      raw: "not a skill"
    })
    const reg = new SkillLifecycleRegistry([source])

    const a = reg.resolveRead(join(source, "alpha", "SKILL.md"))
    const b = reg.resolveRead(join(source, "beta", "SKILL.md"))
    const c = reg.resolveRead(join(source, "no-skill-here", "README.md"))

    assert(a?.name === "alpha", `expected alpha got ${a?.name}`)
    assert(b?.name === "beta", `expected beta got ${b?.name}`)
    assert(c === null, "no-SKILL.md dirs should not match")
  })
}

async function testFallbackName(): Promise<void> {
  await withTempDir("skill-fallback", async (base) => {
    const source = join(base, "skills")
    await writeSkillDoc(source, "weather/SKILL.md", {
      raw: "no frontmatter at all"
    })
    const reg = new SkillLifecycleRegistry([source])
    const match = reg.resolveRead(join(source, "weather", "SKILL.md"))
    assert(match?.name === "weather", `expected basename fallback got ${match?.name}`)
  })
}

async function testFrontmatterCRLF(): Promise<void> {
  await withTempDir("skill-crlf", async (base) => {
    const source = join(base, "skills")
    const file = join(source, "x", "SKILL.md")
    await mkdir(join(source, "x"), { recursive: true })
    // CRLF + Name with mixed case in key
    await writeFile(file, "---\r\nName: My Skill\r\nfoo: bar\r\n---\r\nbody\r\n", "utf8")
    const reg = new SkillLifecycleRegistry([source])
    const match = reg.resolveRead(file)
    assert(match?.name === "My Skill", `expected "My Skill" got "${match?.name}"`)
  })
}

async function testResolveByDocPath(): Promise<void> {
  await withTempDir("skill-docpath", async (base) => {
    const source = join(base, "skills")
    const docPath = await writeSkillDoc(source, "docs/SKILL.md", { name: "docs" })
    const reg = new SkillLifecycleRegistry([source])
    const match = reg.resolveRead(docPath)
    assert(match?.name === "docs", `expected docs got ${match?.name}`)
    assert(match?.path === docPath, `expected path=${docPath} got ${match?.path}`)
  })
}

async function testResolveByRootDir(): Promise<void> {
  await withTempDir("skill-rootdir", async (base) => {
    const source = join(base, "skills")
    await writeSkillDoc(source, "kit/SKILL.md", { name: "kit" })
    const reg = new SkillLifecycleRegistry([source])
    const match = reg.resolveRead(join(source, "kit"))
    assert(match?.name === "kit", "matching rootDir should resolve")
  })
}

async function testResolveBySubFile(): Promise<void> {
  await withTempDir("skill-subfile", async (base) => {
    const source = join(base, "skills")
    await writeSkillDoc(source, "tk/SKILL.md", { name: "tk" })
    await writeFile(join(source, "tk", "helper.py"), "print('hi')", "utf8")
    const reg = new SkillLifecycleRegistry([source])
    const match = reg.resolveRead(join(source, "tk", "helper.py"))
    assert(match?.name === "tk", "files under skill rootDir should resolve")
  })
}

async function testResolveRelativePath(): Promise<void> {
  await withTempDir("skill-rel", async (base) => {
    const source = join(base, "skills")
    await writeSkillDoc(source, "rel/SKILL.md", { name: "rel" })
    const reg = new SkillLifecycleRegistry([source])
    // Pass rawPath as relative — registry should still try to resolve
    const orig = process.cwd()
    try {
      process.chdir(source)
      const match = reg.resolveRead(join("rel", "SKILL.md"))
      assert(match?.name === "rel", "relative path should still resolve")
    } finally {
      process.chdir(orig)
    }
  })
}

async function testUnrelatedPath(): Promise<void> {
  await withTempDir("skill-unrelated", async (base) => {
    const source = join(base, "skills")
    await writeSkillDoc(source, "x/SKILL.md", { name: "x" })
    const reg = new SkillLifecycleRegistry([source])
    const match = reg.resolveRead(join(base, "elsewhere", "file.md"))
    assert(match === null, "unrelated path should return null")
  })
}

async function testDuplicateSourceDedup(): Promise<void> {
  await withTempDir("skill-dedup", async (base) => {
    const source = join(base, "skills")
    await writeSkillDoc(source, "shared/SKILL.md", { name: "shared" })
    // List the same source twice
    const reg = new SkillLifecycleRegistry([source, source])
    const match = reg.resolveRead(join(source, "shared", "SKILL.md"))
    // No way to inspect entries; verify no crash + correct result
    assert(match?.name === "shared", "dedup should not break resolution")
  })
}

async function testMissingSourceIgnored(): Promise<void> {
  await withTempDir("skill-missing", async (base) => {
    const real = join(base, "skills")
    await writeSkillDoc(real, "ok/SKILL.md", { name: "ok" })
    const ghost = join(base, "does-not-exist")
    // Should not throw
    const reg = new SkillLifecycleRegistry([ghost, real])
    const match = reg.resolveRead(join(real, "ok", "SKILL.md"))
    assert(match?.name === "ok", "real source should still load when ghost listed")
  })
}

async function testCaseInsensitiveOnPaths(): Promise<void> {
  await withTempDir("skill-case", async (base) => {
    const source = join(base, "Skills")
    await writeSkillDoc(source, "Cap/SKILL.md", { name: "cap" })
    const reg = new SkillLifecycleRegistry([source])
    // Use lower-case path; normalizePath in registry lowercases for comparison
    const lower = join(base, "skills", "cap", "SKILL.md").split(sep).join(sep)
    const match = reg.resolveRead(lower)
    assert(match?.name === "cap", "case-insensitive normalization should match")
  })
}

async function testSkillReadContentIsNotPolluted(): Promise<void> {
  await withTempDir("skill-read-clean", async (base) => {
    const source = join(base, "skills")
    const skillPath = await writeSkillDoc(source, "clean/SKILL.md", {
      raw: "---\nname: clean\n---\nreal skill body\n"
    })
    const registry = new SkillLifecycleRegistry([source])
    const sandbox = new LocalSandbox({
      rootDir: base,
      skillLifecycleRegistry: registry,
      hooks: [
        makeHook({
          event: "PostSkillUse",
          matcher: "clean",
          command: nodeCommand("console.log(JSON.stringify({additionalContext:'post guidance'}))")
        })
      ]
    })

    const result = await sandbox.read(skillPath)
    assert(result.includes("real skill body"), "read result should include SKILL.md body")
    assert(!result.includes("post guidance"), "read result must not include hook guidance")
    assert(
      sandbox.drainSkillHookContexts().some((ctx) => ctx.includes("post guidance")),
      "post guidance should be queued for system-message injection"
    )
  })
}

async function testPreSkillBlockStopsRead(): Promise<void> {
  await withTempDir("skill-read-block", async (base) => {
    const source = join(base, "skills")
    const skillPath = await writeSkillDoc(source, "blocked/SKILL.md", {
      raw: "---\nname: blocked\n---\nthis should not matter\n"
    })
    const sandbox = new LocalSandbox({
      rootDir: base,
      skillLifecycleRegistry: new SkillLifecycleRegistry([source]),
      hooks: [
        makeHook({
          event: "PreSkillUse",
          matcher: "blocked",
          command: nodeCommand(
            "console.log(JSON.stringify({decision:'block',reason:'blocked by test'}))"
          )
        })
      ]
    })

    const result = await sandbox.read(skillPath)
    assert(result.includes("Error reading skill 'blocked'"), `expected blocked read, got ${result}`)
    assert(result.includes("blocked by test"), `expected block reason, got ${result}`)
  })
}

async function testSameSkillReadFiresOnce(): Promise<void> {
  await withTempDir("skill-read-once", async (base) => {
    const source = join(base, "skills")
    const skillPath = await writeSkillDoc(source, "once/SKILL.md", {
      raw: "---\nname: once\n---\nbody\n"
    })
    const counterPath = join(base, "count.txt")
    const sandbox = new LocalSandbox({
      rootDir: base,
      skillLifecycleRegistry: new SkillLifecycleRegistry([source]),
      hooks: [
        makeHook({
          event: "PreSkillUse",
          matcher: "once",
          command: nodeCommand(`
const fs = require('fs')
const p = ${JSON.stringify(counterPath)}
const n = fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : 0
fs.writeFileSync(p, String(n + 1))
`)
        })
      ]
    })

    await sandbox.read(skillPath)
    await sandbox.read(skillPath)
    const count = existsSync(counterPath) ? (await readFile(counterPath, "utf8")).trim() : "0"
    assert(count === "1", `expected PreSkillUse to fire once, got ${count}`)
  })
}

async function testPostSkillContextQueueAndDrain(): Promise<void> {
  await withTempDir("skill-drain", async (base) => {
    const source = join(base, "skills")
    const skillPath = await writeSkillDoc(source, "queued/SKILL.md", {
      raw: "---\nname: queued\n---\nbody\n"
    })
    const sandbox = new LocalSandbox({
      rootDir: base,
      skillLifecycleRegistry: new SkillLifecycleRegistry([source]),
      hooks: [
        makeHook({
          event: "PostSkillUse",
          matcher: "queued",
          command: nodeCommand("console.log(JSON.stringify({systemMessage:'remember queued'}))")
        })
      ]
    })

    await sandbox.read(skillPath)
    const contexts = sandbox.drainSkillHookContexts()
    assert(contexts.length === 1, `expected one queued context, got ${contexts.length}`)
    assert(contexts[0].includes("Skill: queued"), `expected skill header, got ${contexts[0]}`)
    assert(
      contexts[0].includes(`Skill path: ${skillPath}`),
      `expected skill path, got ${contexts[0]}`
    )
    assert(contexts[0].includes("remember queued"), `expected hook note, got ${contexts[0]}`)
    assert(sandbox.drainSkillHookContexts().length === 0, "drain should clear the queue")
  })
}

async function testNonSkillReadDoesNotFireHooks(): Promise<void> {
  await withTempDir("skill-read-nonskill", async (base) => {
    const source = join(base, "skills")
    await writeSkillDoc(source, "real/SKILL.md", { name: "real" })
    const notesPath = join(base, "notes.md")
    const counterPath = join(base, "count.txt")
    await writeFile(notesPath, "ordinary file\n", "utf8")
    const sandbox = new LocalSandbox({
      rootDir: base,
      skillLifecycleRegistry: new SkillLifecycleRegistry([source]),
      hooks: [
        makeHook({
          event: "PreSkillUse",
          matcher: "*",
          command: nodeCommand(`require('fs').writeFileSync(${JSON.stringify(counterPath)}, '1')`)
        })
      ]
    })

    const result = await sandbox.read(notesPath)
    assert(result.includes("ordinary file"), "ordinary file should still be read")
    assert(!existsSync(counterPath), "non-skill reads should not fire skill hooks")
  })
}

async function run(): Promise<void> {
  await testRootSkill()
  console.log("PASS A1 single SKILL.md at source root")
  await testNestedLayout()
  console.log("PASS A2 nested skill subdirectories")
  await testFallbackName()
  console.log("PASS A3 fallback name when no frontmatter")
  await testFrontmatterCRLF()
  console.log("PASS A4 CRLF + mixed-case frontmatter Name")
  await testResolveByDocPath()
  console.log("PASS A5 resolve by absolute SKILL.md doc path")
  await testResolveByRootDir()
  console.log("PASS A6 resolve by rootDir")
  await testResolveBySubFile()
  console.log("PASS A7 resolve by file under skill rootDir")
  await testResolveRelativePath()
  console.log("PASS A8 resolve relative rawPath")
  await testUnrelatedPath()
  console.log("PASS A9 unrelated path returns null")
  await testDuplicateSourceDedup()
  console.log("PASS A10 duplicate source dedup")
  await testMissingSourceIgnored()
  console.log("PASS A11 missing source ignored")
  await testCaseInsensitiveOnPaths()
  console.log("PASS A11b case-insensitive matching")
  await testSkillReadContentIsNotPolluted()
  console.log("PASS D1 SKILL.md content not polluted")
  await testPreSkillBlockStopsRead()
  console.log("PASS D2 PreSkillUse block stops skill read")
  await testSameSkillReadFiresOnce()
  console.log("PASS D3 same skill read fires hooks once")
  await testPostSkillContextQueueAndDrain()
  console.log("PASS D4/D5 post context queue drains cleanly")
  await testNonSkillReadDoesNotFireHooks()
  console.log("PASS D6 non-skill read does not fire hooks")
}

run().catch((err: Error) => {
  console.error(`FAIL ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
