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
import * as iconv from "iconv-lite"
import { LocalSandbox } from "../src/main/agent/local-sandbox.ts"
import { activateSkillLifecycle } from "../src/main/agent/skill-lifecycle/activation.ts"
import { parseSkillUseBlock } from "../src/main/agent/skill-lifecycle/marker.ts"
import { SkillLifecycleRegistry } from "../src/main/agent/skill-lifecycle/registry.ts"
import { createSkillUseTracker } from "../src/main/agent/skill-lifecycle/tracker.ts"
import { createHookScope, mergeHookScopeSnapshot } from "../src/main/hooks/scope.ts"
import { isHookHaltError } from "../src/main/hooks/halt.ts"
import {
  discoverSkillsSync,
  expandSkillMiddlewareSourceDirs
} from "../src/main/skills/discovery.ts"
import {
  isDiscoveredSkillDisabled,
  removeDisabledSkillEntriesForSkills,
  resolveDisabledSkillIds
} from "../src/main/skills/ids.ts"
import { decodeArchiveEntryName, selectRootSkillMarkdownEntry } from "../src/main/skills/archive.ts"
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

async function testDeepNestedLayout(): Promise<void> {
  await withTempDir("skill-deep-nested", async (base) => {
    const source = join(base, "skills")
    await writeSkillDoc(source, "office/SKILL.md", { name: "office" })
    await writeSkillDoc(source, "office/pdf/SKILL.md", { name: "pdf" })
    await writeSkillDoc(source, "office/pdf/extract/SKILL.md", { name: "pdf-extract" })
    await writeSkillDoc(source, "office/pdf/extract/deeper/SKILL.md", { name: "too-deep" })
    await writeFile(join(source, "office", "pdf", "extract", "helper.txt"), "helper", "utf8")

    const reg = new SkillLifecycleRegistry([source])
    const parent = reg.resolveRead(join(source, "office", "SKILL.md"))
    const child = reg.resolveRead(join(source, "office", "pdf", "SKILL.md"))
    const grandchild = reg.resolveRead(join(source, "office", "pdf", "extract", "helper.txt"))
    const tooDeep = reg.resolveRead(join(source, "office", "pdf", "extract", "deeper", "SKILL.md"))

    assert(parent?.name === "office", `expected office got ${parent?.name}`)
    assert(child?.name === "pdf", `expected pdf got ${child?.name}`)
    assert(grandchild?.name === "pdf-extract", `expected pdf-extract got ${grandchild?.name}`)
    assert(
      tooDeep?.name === "pdf-extract",
      `too-deep skill should not be discovered, got ${tooDeep?.name}`
    )
  })
}

async function testSkillMiddlewareSourceExpansion(): Promise<void> {
  await withTempDir("skill-source-expansion", async (base) => {
    const source = join(base, "skills")
    await writeSkillDoc(source, "office/SKILL.md", { name: "office" })
    await writeSkillDoc(source, "office/pdf/SKILL.md", { name: "pdf" })
    await writeSkillDoc(source, "office/pdf/extract/SKILL.md", { name: "pdf-extract" })

    const expanded = await expandSkillMiddlewareSourceDirs([source])
    assert(expanded.includes(source), "expanded sources should include root skills dir")
    assert(
      expanded.includes(join(source, "office")),
      "expanded sources should include parent dir for second-level skills"
    )
    assert(
      expanded.includes(join(source, "office", "pdf")),
      "expanded sources should include parent dir for third-level skills"
    )
  })
}

async function testDisabledSkillIdsResolveByPathAndLegacyName(): Promise<void> {
  await withTempDir("skill-disabled-ids", async (base) => {
    const source = join(base, "skills")
    await writeSkillDoc(source, "office/pdf/SKILL.md", { name: "shared-pdf" })
    await writeSkillDoc(source, "reports/pdf/SKILL.md", { name: "shared-pdf" })

    const skills = discoverSkillsSync(source)
    const disabledByPath = resolveDisabledSkillIds(["office/pdf"], skills)
    assert(
      disabledByPath.includes("office/pdf"),
      "path id should disable the targeted nested skill"
    )
    assert(
      !disabledByPath.includes("reports/pdf"),
      "path id should not disable a same-name nested sibling"
    )

    const disabledByLegacyName = resolveDisabledSkillIds(["shared-pdf"], skills)
    assert(
      disabledByLegacyName.includes("office/pdf") && disabledByLegacyName.includes("reports/pdf"),
      `legacy name should expand to all matching skill ids, got ${disabledByLegacyName.join(",")}`
    )
  })
}

async function testDeletedSkillDisabledEntriesArePruned(): Promise<void> {
  await withTempDir("skill-disabled-prune", async (base) => {
    const source = join(base, "skills")
    await writeSkillDoc(source, "alpha/SKILL.md", { name: "shared-name" })
    await writeSkillDoc(source, "alpha/child/SKILL.md", { name: "alpha-child" })
    await writeSkillDoc(source, "beta/SKILL.md", { name: "shared-name" })

    const skills = discoverSkillsSync(source)
    const removing = skills.filter((skill) => skill.relativePath.startsWith("alpha"))
    const remaining = skills.filter((skill) => !skill.relativePath.startsWith("alpha"))
    const next = removeDisabledSkillEntriesForSkills(
      ["alpha", "alpha/child", "shared-name", "beta"],
      removing,
      remaining
    )

    assert(!next.includes("alpha"), "deleted root skill id should be removed")
    assert(!next.includes("alpha/child"), "deleted nested skill id should be removed")
    assert(next.includes("shared-name"), "legacy alias still used by remaining skill should stay")
    assert(next.includes("beta"), "unrelated disabled skill should stay")
  })
}

async function testAncestorDisabledSkillDisablesNestedSkills(): Promise<void> {
  await withTempDir("skill-disabled-ancestor", async (base) => {
    const source = join(base, "skills")
    await writeSkillDoc(source, "office/SKILL.md", { name: "office" })
    await writeSkillDoc(source, "office/pdf/SKILL.md", { name: "pdf" })

    const skills = discoverSkillsSync(source)
    const disabled = new Set(resolveDisabledSkillIds(["office"], skills))
    const child = skills.find((skill) => skill.relativePath === "office/pdf")

    assert(child, "child skill should be discovered")
    assert(
      isDiscoveredSkillDisabled(child!, disabled),
      "disabled parent skill id should disable nested child skills"
    )
  })
}

async function testZipRootSkillSelectionPrefersShallowSkillMd(): Promise<void> {
  const entries = [
    { entry: { isDirectory: false }, decodedName: "skill/imagegen/scope-plain-skill/SKILL.md" },
    { entry: { isDirectory: false }, decodedName: "skill/imagegen/SKILL.md" },
    { entry: { isDirectory: false }, decodedName: "../SKILL.md" },
    { entry: { isDirectory: false }, decodedName: "skill/SKILL.md" }
  ]
  const selected = selectRootSkillMarkdownEntry(entries, (item) => item.entry.isDirectory)
  assert(
    selected?.decodedName === "skill/SKILL.md",
    `expected root skill/SKILL.md got ${selected?.decodedName}`
  )
}

async function testZipEntryNameDecodesGbkPluginSkillPath(): Promise<void> {
  const rawName =
    "Code-Review-Helper - 副本/skills/架构红线高整改等级问题智能检测与修复/imagegen/SKILL.md"
  const decoded = decodeArchiveEntryName({
    entryName: "Code-Review-Helper - ����/skills/�ܹ����߸����ĵȼ��������ܼ�����޸�/imagegen/SKILL.md",
    rawEntryName: iconv.encode(rawName, "gb18030"),
    header: { flags_efs: false }
  })

  assert(decoded === rawName, `expected GBK zip path to decode, got ${decoded}`)
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

async function testSkillUseMarkerParsesTrailingBlock(): Promise<void> {
  const block = [
    "<CMBDEVCLAW-SKILL-USE-V1>",
    "<instruction>read it</instruction>",
    "<name>pdf</name>",
    "<path>C:/skills/office/pdf/SKILL.md</path>",
    "</CMBDEVCLAW-SKILL-USE-V1>"
  ].join("\n")
  const parsed = parseSkillUseBlock(`请用这个技能\n\n${block}`)
  assert(parsed?.skillName === "pdf", `expected marker skillName=pdf got ${parsed?.skillName}`)
  assert(
    parsed?.skillPath === "C:/skills/office/pdf/SKILL.md",
    `expected marker skillPath to round-trip got ${parsed?.skillPath}`
  )
  assert(parsed?.rest === "请用这个技能", `expected rest to preserve user text got ${parsed?.rest}`)
  assert(parsed?.block === block, "parsed block should preserve the exact marker payload")
}

async function testResolveExplicitPrefersExactNestedSkillPath(): Promise<void> {
  await withTempDir("skill-explicit-nested", async (base) => {
    const source = join(base, "skills")
    const parentDoc = await writeSkillDoc(source, "office/SKILL.md", { name: "office" })
    const childDoc = await writeSkillDoc(source, "office/pdf/SKILL.md", { name: "pdf" })
    const reg = new SkillLifecycleRegistry([source])

    const byChildDoc = reg.resolveExplicit({ skillName: "office", skillPath: childDoc })
    const byChildRoot = reg.resolveExplicit({
      skillPath: join(source, "office", "pdf")
    })
    const byParentDoc = reg.resolveExplicit({ skillPath: parentDoc })

    assert(
      byChildDoc?.name === "pdf",
      `explicit child doc should resolve child, got ${byChildDoc?.name}`
    )
    assert(
      byChildRoot?.name === "pdf",
      `explicit child root should resolve child, got ${byChildRoot?.name}`
    )
    assert(
      byParentDoc?.name === "office",
      `explicit parent doc should resolve parent, got ${byParentDoc?.name}`
    )
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
    // Use lower-case path; Windows paths are case-insensitive, POSIX paths are not.
    const lower = join(base, "skills", "cap", "SKILL.md").split(sep).join(sep)
    const match = reg.resolveRead(lower)
    if (process.platform === "win32") {
      assert(match?.name === "cap", "Windows path normalization should match case-insensitively")
    } else {
      assert(match === null, "POSIX path normalization should keep case-sensitive paths distinct")
    }
  })
}

async function testHookScopeSnapshotMergesNamesAndPathsIndependently(): Promise<void> {
  const target = createHookScope()
  mergeHookScopeSnapshot(target, {
    activePluginIds: [],
    activeSkillNames: ["Name Only Skill"],
    activeSkillPaths: ["C:/tmp/PathSkill"]
  })

  assert(
    target.activeSkillNames.has("name only skill"),
    "snapshot merge should preserve skill names"
  )
  const expectedPath = process.platform === "win32" ? "c:/tmp/pathskill" : "C:/tmp/PathSkill"
  assert(target.activeSkillPaths.has(expectedPath), "snapshot merge should preserve skill paths")
}

async function testPluginSkillMetadata(): Promise<void> {
  await withTempDir("skill-plugin-meta", async (base) => {
    const source = join(base, "plugin", "skills")
    const skillPath = await writeSkillDoc(source, "plugged/SKILL.md", { name: "plugged" })
    const reg = new SkillLifecycleRegistry([
      {
        sourceDir: source,
        pluginId: "plugin-a",
        pluginName: "Plugin A",
        pluginRoot: join(base, "plugin")
      }
    ])
    const match = reg.resolveRead(skillPath)
    assert(match?.name === "plugged", `expected plugged got ${match?.name}`)
    assert(match?.pluginId === "plugin-a", `expected plugin-a got ${match?.pluginId}`)
    assert(match?.pluginName === "Plugin A", `expected Plugin A got ${match?.pluginName}`)
    assert(match?.pluginRoot === join(base, "plugin"), `expected pluginRoot got ${match?.pluginRoot}`)
  })
}

async function testPluginSkillActivatesScopedHooks(): Promise<void> {
  await withTempDir("skill-plugin-scope", async (base) => {
    const source = join(base, "plugin", "skills")
    const skillPath = await writeSkillDoc(source, "plugged/SKILL.md", {
      raw: "---\nname: plugged\n---\nbody\n"
    })
    const outputPath = join(base, "scope-hit.txt")
    const hookScope = createHookScope()
    const scopedHook = makeHook({
      event: "PreToolUse",
      matcher: "write_file",
      command: nodeCommand(
        `require('fs').writeFileSync(${JSON.stringify(outputPath)}, 'plugin active')`
      )
    })
    const sandbox = new LocalSandbox({
      rootDir: base,
      skillLifecycleRegistry: new SkillLifecycleRegistry([
        { sourceDir: source, pluginId: "plugin-a", pluginName: "Plugin A" }
      ]),
      hookScope,
      hookResolver: () => (hookScope.activePluginIds.has("plugin-a") ? [scopedHook] : [])
    })

    await sandbox.read(skillPath)
    assert(!existsSync(outputPath), "plugin scoped hook should not fire during skill read")
    await sandbox.write(join(base, "written.txt"), "ok")
    const marker = existsSync(outputPath) ? (await readFile(outputPath, "utf8")).trim() : ""
    assert(marker === "plugin active", `expected scoped hook marker, got ${marker}`)
  })
}

async function testNestedSkillActivatesOnlyMatchedScopedHooks(): Promise<void> {
  await withTempDir("skill-nested-scope", async (base) => {
    const source = join(base, "skills")
    await writeSkillDoc(source, "office/SKILL.md", {
      raw: "---\nname: office\n---\nparent\n"
    })
    const childSkillPath = await writeSkillDoc(source, "office/pdf/SKILL.md", {
      raw: "---\nname: pdf\n---\nchild\n"
    })
    const parentRoot = join(source, "office")
    const childRoot = join(source, "office", "pdf")
    const pathKey = (value: string): string =>
      value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    const parentMarker = join(base, "parent-hit.txt")
    const childMarker = join(base, "child-hit.txt")
    const hookScope = createHookScope()
    const parentHook = makeHook({
      event: "PreToolUse",
      matcher: "write_file",
      command: nodeCommand(`require('fs').writeFileSync(${JSON.stringify(parentMarker)}, 'parent')`)
    })
    const childHook = makeHook({
      event: "PreToolUse",
      matcher: "write_file",
      command: nodeCommand(`require('fs').writeFileSync(${JSON.stringify(childMarker)}, 'child')`)
    })
    const sandbox = new LocalSandbox({
      rootDir: base,
      skillLifecycleRegistry: new SkillLifecycleRegistry([source]),
      hookScope,
      hookResolver: () => {
        const hooks: HookConfig[] = []
        if (hookScope.activeSkillPaths.has(pathKey(parentRoot))) hooks.push(parentHook)
        if (hookScope.activeSkillPaths.has(pathKey(childRoot))) hooks.push(childHook)
        return hooks
      }
    })

    await sandbox.read(childSkillPath)
    await sandbox.write(join(base, "written.txt"), "ok")

    assert(!existsSync(parentMarker), "reading child skill should not activate parent scoped hook")
    assert(existsSync(childMarker), "reading child skill should activate child scoped hook")
  })
}

async function testExplicitActivationFiresLifecycleOnceAndSuppressesReadDuplicate(): Promise<void> {
  await withTempDir("skill-explicit-once", async (base) => {
    const source = join(base, "skills")
    const skillPath = await writeSkillDoc(source, "explicit/SKILL.md", {
      raw: "---\nname: explicit\n---\nbody\n"
    })
    const registry = new SkillLifecycleRegistry([source])
    const skill = registry.resolveExplicit({ skillName: "explicit", skillPath })
    assert(skill, "explicit skill should resolve")

    const counterPath = join(base, "count.txt")
    const postCounterPath = join(base, "post-count.txt")
    const lifecycleHook = makeHook({
      event: "PreSkillUse",
      matcher: "explicit",
      command: nodeCommand(`
const fs = require('fs')
const p = ${JSON.stringify(counterPath)}
const n = fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : 0
fs.writeFileSync(p, String(n + 1))
`)
    })
    const postHook = makeHook({
      event: "PostSkillUse",
      matcher: "explicit",
      command: nodeCommand(`require('fs').writeFileSync(${JSON.stringify(postCounterPath)}, '1')`)
    })
    const hookScope = createHookScope()
    const skillHookKeys = new Set<string>()
    const skillUseTracker = createSkillUseTracker()

    await activateSkillLifecycle({
      skill: skill!,
      trigger: "explicit",
      toolName: "skill_select",
      toolArgs: { skillName: "explicit", skillPath },
      workspacePath: base,
      sessionId: "explicit-test",
      hookScope,
      firedSkillKeys: skillHookKeys,
      skillUseTracker,
      resolveHooks: (event) =>
        event === "PreSkillUse" ? [lifecycleHook] : event === "PostSkillUse" ? [postHook] : []
    })

    const sandbox = new LocalSandbox({
      rootDir: base,
      skillLifecycleRegistry: registry,
      hooks: [lifecycleHook],
      hookScope,
      skillHookKeys,
      skillUseTracker
    })

    await sandbox.read(skillPath)
    const count = existsSync(counterPath) ? (await readFile(counterPath, "utf8")).trim() : "0"

    assert(count === "1", `explicit selection + read should fire lifecycle once, got ${count}`)
    assert(!existsSync(postCounterPath), "PostSkillUse should not fire during explicit activation")
    assert(
      skillUseTracker.getPendingPostSkillUses().length === 1,
      "explicit activation should defer PostSkillUse until turn completion"
    )
    const expectedPath =
      process.platform === "win32"
        ? skill!.rootDir.replace(/\\/g, "/").toLowerCase()
        : skill!.rootDir.replace(/\\/g, "/")
    assert(
      hookScope.activeSkillPaths.has(expectedPath),
      "explicit selection should activate the selected skill path in hook scope"
    )
  })
}

async function testPluginSkillHookDoesNotMatchStandaloneSkillByName(): Promise<void> {
  await withTempDir("skill-plugin-name-collision", async (base) => {
    const localSource = join(base, "skills")
    const pluginSource = join(base, "plugin", "skills")
    const localSkillPath = await writeSkillDoc(localSource, "shared/SKILL.md", {
      raw: "---\nname: shared-name\n---\nlocal\n"
    })
    const pluginSkillRoot = join(pluginSource, "shared")
    await writeSkillDoc(pluginSource, "shared/SKILL.md", {
      raw: "---\nname: shared-name\n---\nplugin\n"
    })

    const localMarker = join(base, "local-hit.txt")
    const pluginMarker = join(base, "plugin-hit.txt")
    const hookScope = createHookScope()
    const localHook = makeHook({
      event: "PreToolUse",
      matcher: "write_file",
      command: nodeCommand(`require('fs').writeFileSync(${JSON.stringify(localMarker)}, 'local')`)
    })
    const pluginHook: HookConfig = {
      ...makeHook({
        event: "PreToolUse",
        matcher: "write_file",
        command: nodeCommand(
          `require('fs').writeFileSync(${JSON.stringify(pluginMarker)}, 'plugin')`
        )
      }),
      skillName: "shared-name",
      skillPath: pluginSkillRoot,
      skillRoot: pluginSkillRoot,
      hookPath: join(pluginSkillRoot, "hooks.json"),
      pluginId: "plugin-a",
      pluginName: "Plugin A"
    } as HookConfig
    const sandbox = new LocalSandbox({
      rootDir: base,
      skillLifecycleRegistry: new SkillLifecycleRegistry([localSource]),
      hookScope,
      hookResolver: () => {
        const hooks: HookConfig[] = []
        if (hookScope.activeSkillNames.has("shared-name")) hooks.push(localHook)
        const pluginPathKey =
          process.platform === "win32"
            ? pluginSkillRoot.replace(/\\/g, "/").toLowerCase()
            : pluginSkillRoot.replace(/\\/g, "/")
        if (hookScope.activeSkillPaths.has(pluginPathKey)) hooks.push(pluginHook)
        return hooks
      }
    })

    await sandbox.read(localSkillPath)
    await sandbox.write(join(base, "written.txt"), "ok")

    assert(existsSync(localMarker), "standalone same-name skill should activate local hook")
    assert(
      !existsSync(pluginMarker),
      "plugin-owned same-name skill hook should not activate from standalone skill name"
    )
  })
}

async function testPostSkillUseDoesNotRunDuringSkillRead(): Promise<void> {
  await withTempDir("skill-read-clean", async (base) => {
    const source = join(base, "skills")
    const skillPath = await writeSkillDoc(source, "clean/SKILL.md", {
      raw: "---\nname: clean\n---\nreal skill body\n"
    })
    const registry = new SkillLifecycleRegistry([source])
    const markerPath = join(base, "post-hit.txt")
    const skillUseTracker = createSkillUseTracker()
    const sandbox = new LocalSandbox({
      rootDir: base,
      skillLifecycleRegistry: registry,
      skillUseTracker,
      hooks: [
        makeHook({
          event: "PostSkillUse",
          matcher: "clean",
          command: nodeCommand(`require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'post')`)
        })
      ]
    })

    const result = await sandbox.read(skillPath)
    assert(result.includes("real skill body"), "read result should include SKILL.md body")
    assert(!existsSync(markerPath), "PostSkillUse should not run while reading SKILL.md")
    assert(
      skillUseTracker.getPendingPostSkillUses().length === 1,
      "read skill should record a pending PostSkillUse"
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

async function testPreToolContinueFalseThrowsHookHalt(): Promise<void> {
  await withTempDir("hook-pretool-halt", async (base) => {
    const targetPath = join(base, "blocked.txt")
    const sandbox = new LocalSandbox({
      rootDir: base,
      hooks: [
        makeHook({
          event: "PreToolUse",
          matcher: "write_file",
          command: nodeCommand(
            "console.log(JSON.stringify({continue:false, stopReason:'pre stopped'}))"
          )
        })
      ]
    })

    let caught: unknown
    try {
      await sandbox.write(targetPath, "should not write")
    } catch (error) {
      caught = error
    }

    if (!isHookHaltError(caught)) {
      throw new Error("PreToolUse continue:false should throw HookHaltError")
    }
    assert(
      caught.reason.includes("pre stopped"),
      `HookHaltError should preserve stop reason, got ${caught.reason}`
    )
    assert(!existsSync(targetPath), "write_file should not run after PreToolUse halt")
  })
}

async function testPostToolContinueFalseThrowsHookHalt(): Promise<void> {
  await withTempDir("hook-posttool-halt", async (base) => {
    const targetPath = join(base, "written-before-post-halt.txt")
    const sandbox = new LocalSandbox({
      rootDir: base,
      hooks: [
        makeHook({
          event: "PostToolUse",
          matcher: "write_file",
          command: nodeCommand(
            "console.log(JSON.stringify({continue:false, stopReason:'post stopped'}))"
          )
        })
      ]
    })

    let caught: unknown
    try {
      await sandbox.write(targetPath, "ok")
    } catch (error) {
      caught = error
    }

    if (!isHookHaltError(caught)) {
      throw new Error("PostToolUse continue:false should throw HookHaltError")
    }
    assert(
      caught.reason.includes("post stopped"),
      `HookHaltError should preserve stop reason, got ${caught.reason}`
    )
    assert(existsSync(targetPath), "PostToolUse halt happens after the tool result is produced")
  })
}

async function testBackgroundExecutePreToolContinueFalseThrowsHookHalt(): Promise<void> {
  await withTempDir("hook-background-pretool-halt", async (base) => {
    const sandbox = new LocalSandbox({
      rootDir: base,
      hooks: [
        makeHook({
          event: "PreToolUse",
          matcher: "execute",
          command: nodeCommand(
            "console.log(JSON.stringify({continue:false, stopReason:'background pre stopped'}))"
          )
        })
      ]
    })

    let caught: unknown
    try {
      await sandbox.executeBackground("echo should-not-start")
    } catch (error) {
      caught = error
    }

    if (!isHookHaltError(caught)) {
      throw new Error("background execute PreToolUse continue:false should throw HookHaltError")
    }
    assert(
      caught.reason.includes("background pre stopped"),
      `HookHaltError should preserve background stop reason, got ${caught.reason}`
    )
  })
}

async function testTextToolPostContinueFalseThrowsHookHalt(): Promise<void> {
  await withTempDir("hook-texttool-post-halt", async (base) => {
    const sandbox = new LocalSandbox({
      rootDir: base,
      hooks: [
        makeHook({
          event: "PostToolUse",
          matcher: "task_output",
          command: nodeCommand(
            "console.log(JSON.stringify({continue:false, stopReason:'task output stopped'}))"
          )
        })
      ]
    })

    let caught: unknown
    try {
      await sandbox.applyPostToolUseHookToText("task_output", { task_id: "abc123" }, "done")
    } catch (error) {
      caught = error
    }

    if (!isHookHaltError(caught)) {
      throw new Error("text tool PostToolUse continue:false should throw HookHaltError")
    }
    assert(
      caught.reason.includes("task output stopped"),
      `HookHaltError should preserve task_output stop reason, got ${caught.reason}`
    )
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

async function testSameNameDifferentSkillsFireSeparately(): Promise<void> {
  await withTempDir("skill-read-same-name", async (base) => {
    const sourceA = join(base, "skills-a")
    const sourceB = join(base, "skills-b")
    const skillPathA = await writeSkillDoc(sourceA, "SKILL.md", {
      raw: "---\nname: shared-name\n---\nA\n"
    })
    const skillPathB = await writeSkillDoc(sourceB, "SKILL.md", {
      raw: "---\nname: shared-name\n---\nB\n"
    })
    const hitsPath = join(base, "hits.txt")
    const sandbox = new LocalSandbox({
      rootDir: base,
      skillLifecycleRegistry: new SkillLifecycleRegistry([sourceA, sourceB]),
      hooks: [
        makeHook({
          event: "PreSkillUse",
          matcher: "shared-name",
          command: nodeCommand(`
const fs = require('fs')
fs.appendFileSync(${JSON.stringify(hitsPath)}, (process.env.SKILL_ROOT || '') + '\\n')
`)
        })
      ]
    })

    await sandbox.read(skillPathA)
    await sandbox.read(skillPathB)
    const hits = existsSync(hitsPath)
      ? (await readFile(hitsPath, "utf8")).split(/\r?\n/).filter(Boolean)
      : []
    assert(hits.length === 2, `expected both same-name skills to fire hooks, got ${hits.length}`)
  })
}

async function testPreSkillContextQueueAndDrain(): Promise<void> {
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
          event: "PreSkillUse",
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

async function testDisabledSkillIsHiddenFromFilesystemView(): Promise<void> {
  await withTempDir("skill-hidden-fs", async (base) => {
    const source = join(base, "skills")
    const activeSkillPath = await writeSkillDoc(source, "active/SKILL.md", {
      raw: "---\nname: active\n---\nactive skill body\n"
    })
    const disabledSkillRoot = join(source, "disabled")
    const disabledSkillPath = await writeSkillDoc(source, "disabled/SKILL.md", {
      raw: "---\nname: disabled\n---\nsecret-marker-for-disabled-skill\n"
    })
    const disabledHelperPath = join(disabledSkillRoot, "helper.txt")
    await writeFile(disabledHelperPath, "secret-marker-for-disabled-skill\n", "utf8")

    const sandbox = new LocalSandbox({
      rootDir: base,
      skillLifecycleRegistry: new SkillLifecycleRegistry([source])
    })
    sandbox.setHiddenSkillDirs([disabledSkillRoot])

    // read() of a file inside the disabled skill must surface the disabled error.
    const readDoc = await sandbox.read(disabledSkillPath)
    assert(
      readDoc.includes("skill is disabled"),
      `read of disabled SKILL.md should report disabled, got ${readDoc}`
    )
    const readHelper = await sandbox.read(disabledHelperPath)
    assert(
      readHelper.includes("skill is disabled"),
      `read of disabled helper should report disabled, got ${readHelper}`
    )
    // Active skill content must remain readable.
    const readActive = await sandbox.read(activeSkillPath)
    assert(readActive.includes("active skill body"), "active skill should still be readable")

    // lsInfo() inside the disabled skill returns the informative error entry, not [].
    const lsInside = await sandbox.lsInfo(disabledSkillRoot)
    assert(lsInside.length === 1, `lsInfo on hidden dir should return one info entry, got ${lsInside.length}`)
    assert(
      lsInside[0].path.includes("skill is disabled"),
      `lsInfo on hidden dir should explain why, got ${lsInside[0].path}`
    )

    // lsInfo() of the parent must hide the disabled skill but keep the active one.
    // Directory entries come back with a trailing separator, so trim before
    // pulling the basename.
    const lsParent = await sandbox.lsInfo(source)
    const parentNames = lsParent.map((f) => {
      const segs = f.path.split(/[\\/]/).filter(Boolean)
      return segs[segs.length - 1] ?? ""
    })
    assert(parentNames.includes("active"), `parent listing should include active skill, got ${parentNames.join(",")}`)
    assert(!parentNames.includes("disabled"), `parent listing should hide disabled skill, got ${parentNames.join(",")}`)

    // globInfo() must not return paths inside the disabled skill.
    const globResults = await sandbox.globInfo("**/SKILL.md", source)
    const globPaths = globResults.map((f) => f.path)
    assert(
      globPaths.some((p) => p.includes("active")),
      "glob should still find active skill"
    )
    assert(
      !globPaths.some((p) => p.includes("disabled")),
      `glob should not surface disabled skill paths, got ${globPaths.join(",")}`
    )

    // grepRaw() must not surface content from the disabled skill.
    const grepResults = await sandbox.grepRaw("secret-marker-for-disabled-skill", source)
    if (Array.isArray(grepResults)) {
      assert(
        !grepResults.some((m) => m.path.toLowerCase().includes("disabled")),
        `grep should not return disabled-skill matches, got ${JSON.stringify(grepResults)}`
      )
    }
  })
}

async function run(): Promise<void> {
  await testRootSkill()
  console.log("PASS A1 single SKILL.md at source root")
  await testNestedLayout()
  console.log("PASS A2 nested skill subdirectories")
  await testDeepNestedLayout()
  console.log("PASS A2b deep nested skill subdirectories use longest path")
  await testSkillMiddlewareSourceExpansion()
  console.log("PASS A2c nested skill middleware source expansion")
  await testDisabledSkillIdsResolveByPathAndLegacyName()
  console.log("PASS A2d disabled skill ids are path-aware with legacy-name fallback")
  await testDeletedSkillDisabledEntriesArePruned()
  console.log("PASS A2e deleted skill disabled entries are pruned")
  await testAncestorDisabledSkillDisablesNestedSkills()
  console.log("PASS A2f disabled parent skill id disables nested skills")
  await testZipRootSkillSelectionPrefersShallowSkillMd()
  console.log("PASS A2g zip upload selects the rootmost SKILL.md")
  await testZipEntryNameDecodesGbkPluginSkillPath()
  console.log("PASS A2h GBK plugin zip skill paths decode correctly")
  await testFallbackName()
  console.log("PASS A3 fallback name when no frontmatter")
  await testFrontmatterCRLF()
  console.log("PASS A4 CRLF + mixed-case frontmatter Name")
  await testResolveByDocPath()
  console.log("PASS A5 resolve by absolute SKILL.md doc path")
  await testSkillUseMarkerParsesTrailingBlock()
  console.log("PASS A5b explicit skill marker parses trailing block")
  await testResolveExplicitPrefersExactNestedSkillPath()
  console.log("PASS A5c explicit skill selection resolves exact nested path")
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
  await testHookScopeSnapshotMergesNamesAndPathsIndependently()
  console.log("PASS A11c hook scope snapshot keeps name and path activations")
  await testPluginSkillMetadata()
  console.log("PASS A12 plugin skill metadata carried through registry")
  await testPluginSkillActivatesScopedHooks()
  console.log("PASS A13 plugin skill activates scoped hooks")
  await testNestedSkillActivatesOnlyMatchedScopedHooks()
  console.log("PASS A14 nested skill activates only the matched scoped hook")
  await testExplicitActivationFiresLifecycleOnceAndSuppressesReadDuplicate()
  console.log("PASS A14b explicit selection fires lifecycle once and shares read de-dupe")
  await testPluginSkillHookDoesNotMatchStandaloneSkillByName()
  console.log("PASS A15 plugin skill hook does not match standalone skill by name")
  await testPostSkillUseDoesNotRunDuringSkillRead()
  console.log("PASS D1 PostSkillUse is deferred until turn completion")
  await testPreSkillBlockStopsRead()
  console.log("PASS D2 PreSkillUse block stops skill read")
  await testPreToolContinueFalseThrowsHookHalt()
  console.log("PASS D2b PreToolUse continue:false throws HookHaltError")
  await testPostToolContinueFalseThrowsHookHalt()
  console.log("PASS D2c PostToolUse continue:false throws HookHaltError")
  await testBackgroundExecutePreToolContinueFalseThrowsHookHalt()
  console.log("PASS D2d background execute PreToolUse continue:false throws HookHaltError")
  await testTextToolPostContinueFalseThrowsHookHalt()
  console.log("PASS D2e text tool PostToolUse continue:false throws HookHaltError")
  await testSameSkillReadFiresOnce()
  console.log("PASS D3 same skill read fires hooks once")
  await testSameNameDifferentSkillsFireSeparately()
  console.log("PASS D3b same-name skills fire separately")
  await testPreSkillContextQueueAndDrain()
  console.log("PASS D4/D5 PreSkillUse context queue drains cleanly")
  await testNonSkillReadDoesNotFireHooks()
  console.log("PASS D6 non-skill read does not fire hooks")
  await testDisabledSkillIsHiddenFromFilesystemView()
  console.log("PASS D7 disabled skills are hidden from read/ls/glob/grep")
}

run().catch((err: Error) => {
  console.error(`FAIL ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
