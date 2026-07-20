/**
 * Regression tests for execute.cwd.
 *
 * Run:
 *   npx tsx tests/local-sandbox-execute-cwd.spec.ts
 */

import assert from "node:assert"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalSandbox } from "../src/main/agent/local-sandbox.ts"
import { SkillLifecycleRegistry } from "../src/main/agent/skill-lifecycle/registry.ts"
import type { HookConfig } from "../src/main/hooks/types.ts"

function nodeCommand(script: string): string {
  return `node -e ${JSON.stringify(script)}`
}

function hook(partial: Partial<HookConfig> & Pick<HookConfig, "event" | "command">): HookConfig {
  return {
    id: partial.id ?? "test-hook",
    enabled: partial.enabled ?? true,
    type: "command",
    matcher: partial.matcher,
    command: partial.command,
    event: partial.event
  }
}

async function createDirLink(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir")
    return true
  } catch (error) {
    console.warn(
      `SKIP execute cwd symlink/junction setup for ${linkPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return false
  }
}

async function run(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "cmb-execute-cwd-"))
  const workspace = join(base, "workspace")
  const skillSource = join(base, "skills")
  const skillRoot = join(skillSource, "demo")
  const outside = join(base, "outside")
  const hookOut = join(base, "post-hook-workspace.txt")
  try {
    await mkdir(workspace, { recursive: true })
    await mkdir(skillRoot, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: demo\n---\n", "utf8")
    const sandbox = new LocalSandbox({
      rootDir: workspace,
      windowsSandbox: "none",
      timeout: 30_000,
      harnessNodeName: "Dev-代码实现",
      harnessNodeStatus: "进行中",
      skillLifecycleRegistry: new SkillLifecycleRegistry([skillSource]),
      hooks: [
        hook({
          event: "PostToolUse",
          matcher: "execute",
          command: nodeCommand(
            `require("fs").writeFileSync(${JSON.stringify(hookOut)}, process.env.WORKSPACE_PATH || "")`
          )
        })
      ]
    })
    const result = await sandbox.execute(nodeCommand("console.log(process.cwd())"), skillRoot)
    assert.equal(result.exitCode, 0)
    assert.equal(await realpath(result.output.trim()), await realpath(skillRoot))
    assert.equal(await realpath((await readFile(hookOut, "utf8")).trim()), await realpath(workspace))

    const envResult = await sandbox.execute(
      nodeCommand(
        "console.log(JSON.stringify({name: process.env.HARNESS_NODE_NAME || '', status: process.env.HARNESS_NODE_STATUS || ''}))"
      ),
      workspace
    )
    assert.equal(envResult.exitCode, 0)
    assert.deepEqual(JSON.parse(envResult.output.trim()), {
      name: "Dev-代码实现",
      status: "进行中"
    })

    const denied = await sandbox.execute(nodeCommand("console.log(process.cwd())"), outside)
    assert.notEqual(denied.exitCode, 0)
    assert.match(denied.output, /Invalid cwd/)

    const workspaceEscapeLink = join(workspace, "outside-link")
    if (await createDirLink(outside, workspaceEscapeLink)) {
      const workspaceSymlinkDenied = await sandbox.execute(
        nodeCommand("console.log(process.cwd())"),
        workspaceEscapeLink
      )
      assert.notEqual(workspaceSymlinkDenied.exitCode, 0)
      assert.match(workspaceSymlinkDenied.output, /resolves outside the workspace/)
      console.log("PASS execute cwd rejects workspace symlink/junction escapes")
    }

    const skillEscapeLink = join(skillRoot, "outside-link")
    if (await createDirLink(outside, skillEscapeLink)) {
      const skillSymlinkDenied = await sandbox.execute(
        nodeCommand("console.log(process.cwd())"),
        skillEscapeLink
      )
      assert.notEqual(skillSymlinkDenied.exitCode, 0)
      assert.match(skillSymlinkDenied.output, /resolves outside enabled skill/)
      console.log("PASS execute cwd rejects skill symlink/junction escapes")
    }

    if (process.platform !== "win32") {
      const caseWorkspace = join(base, "CaseRepo")
      const caseOutsideRoot = join(base, "caserepo")
      const caseOutside = join(caseOutsideRoot, "escape")
      await mkdir(caseWorkspace, { recursive: true })
      await mkdir(caseOutside, { recursive: true })
      if (await realpath(caseWorkspace) !== await realpath(caseOutsideRoot)) {
        const caseSandbox = new LocalSandbox({
          rootDir: caseWorkspace,
          windowsSandbox: "none",
          timeout: 30_000
        })
        const caseDenied = await caseSandbox.execute(
          nodeCommand("console.log(process.cwd())"),
          caseOutside
        )
        assert.notEqual(caseDenied.exitCode, 0)
        assert.match(caseDenied.output, /Invalid cwd/)
        console.log("PASS execute cwd keeps POSIX case-sensitive workspace boundaries")
      } else {
        console.warn("SKIP execute cwd POSIX case regression: filesystem is case-insensitive")
      }
    }

    console.log("PASS execute cwd runs command from the requested skill directory")
    console.log("PASS execute cwd keeps workspace hooks rooted at the workspace")
    console.log("PASS execute cwd rejects non-skill directories outside the workspace")
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

run().catch((err: Error) => {
  console.error(`FAIL ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
