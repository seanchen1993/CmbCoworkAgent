import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { prepareAutobizFunctionStatePlugin } from "../../../../scripts/prepare-autobiz-function-state-plugin"
import { createAutobizFunctionStateGuest } from "../../../../tests/support/autobiz-function-state-guest"
import { canonicalTmpdir } from "../../../../tests/support/canonical-temp-dir"

const source = process.env.AUTOBIZ_FUNCTION_STATE_PLUGIN
const optedIn = process.env.RUN_AUTOBIZ_FUNCTION_STATE_INTEGRATION === "1" && !!source
const execute = promisify(execFile)

it.runIf(optedIn)(
  "uses the real state Mod to reject stale verified candidates and rechecks actual bytes after the prepared commit ACK",
  async () => {
    const parent = await mkdtemp(join(canonicalTmpdir(), "ab-verified-state-"))
    const runtimes: Array<{ close(): Promise<void> }> = []
    try {
      const generated = await prepareAutobizFunctionStatePlugin({
        source: resolve(source!),
        output: join(parent, "candidate"),
        name: "autobiz-verified-candidate-test",
        version: "1.1.0"
      })
      const plugin = generated.assembled
      const python = (args: string[], cwd = plugin) =>
        execute("python", ["-I", "-B", "-X", "utf8", ...args], {
          cwd,
          windowsHide: true,
          timeout: 30000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
        })
      async function fixture(name: string, checkpoint: string) {
        const workspace = join(parent, name)
        await mkdir(workspace)
        for (const [mode, extra] of [
          ["createProject", []],
          ["createFeature", ["--feature", "alpha"]]
        ] as const)
          await python([
            join(plugin, "hooks/init_workspace.py"),
            "--mode",
            mode,
            "--workspace",
            parent,
            "--project",
            name,
            ...extra
          ])
        // This private fixture seeds only a starting checkpoint with the original serializer.
        // It does not claim that the preceding Code/UTest business stages have been executed.
        await python([
          "-c",
          `import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from board_core.state_store import check_or_fix_state_sync,write_state_records_preserving_raw; w=Path(sys.argv[2]); s=check_or_fix_state_sync(w,fix=False); assert not s.errors,s.errors; r=s.records; r['alpha']['checkpoint']=sys.argv[3]; write_state_records_preserving_raw(w,r,raw_records=s.raw_records)`,
          plugin,
          workspace,
          checkpoint
        ])
        const repository = join(parent, `${name}-code`)
        await mkdir(repository)
        await execute("git", ["init", repository], { windowsHide: true, timeout: 10000 })
        const codePath = join(repository, "candidate.txt")
        await writeFile(codePath, "original verified code\n")
        const feature = join(workspace, ".autobizdevops/features/alpha")
        await writeFile(
          join(feature, "CICD_CHECKLIST.md"),
          "# 本地交付检查\n此隔离用例验证原候选摘要与状态提交门禁。\n"
        )
        await writeFile(
          join(feature, "plan.json"),
          JSON.stringify({
            codeWorkspaces: { api: repository },
            implementationScope: "backend_only"
          })
        )
        const digest = await python([
          "-c",
          "import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from hooks.candidate_digest import compute; print(compute(Path(sys.argv[2]),'alpha'))",
          plugin,
          workspace
        ])
        const decision = join(feature, "VERIFY_DECISION.json")
        await writeFile(
          decision,
          JSON.stringify({ version: 1, verdict: "pass", diffDigest: digest.stdout.trim() })
        )
        const runtime = await createAutobizFunctionStateGuest(plugin, workspace)
        runtimes.push(runtime)
        const bytes = () =>
          Promise.all(
            ["state.json", "STATE.md"].map((name) =>
              readFile(join(workspace, ".autobizdevops", name))
            )
          )
        return { workspace, runtime, bytes, codePath, decision }
      }
      for (const [name, checkpoint, target] of [
        ["target-verified", "code_in_progress", "code_done"],
        ["current-verified", "code_done", "cicd_in_progress"]
      ]) {
        const f = await fixture(name, checkpoint)
        const before = await f.bytes()
        await writeFile(f.codePath, "code changed after verification\n")
        const state = await f.runtime.command("autobiz-state-read", "alpha")
        const rejected = await f.runtime.command(
          "autobiz-state-advance",
          `alpha ${target} ${state.stateDigest} stale-${name}`
        )
        expect(rejected).toMatchObject({ ok: false, status: "not-applied" })
        expect(JSON.stringify(rejected)).toContain("AUTOBIZ_VERIFIED_CANDIDATE_STALE")
        expect(await f.bytes()).toEqual(before)
      }
      const correct = await fixture("correct-digest", "cicd_in_progress")
      const current = await correct.runtime.command("autobiz-state-read", "alpha")
      const advanced = await correct.runtime.command(
        "autobiz-state-advance",
        `alpha cicd_done ${current.stateDigest} correct-digest`
      )
      expect(advanced, JSON.stringify(advanced)).toMatchObject({ ok: true, status: "committed" })
      const journal = join(correct.workspace, ".autobizdevops/function-state-journal")
      const physical = (await readdir(journal)).find((name) => name.endsWith(".physical.json"))!
      expect(JSON.parse(await readFile(join(journal, physical), "utf8"))).toMatchObject({
        verifiedCandidate: {
          id: "original-verified-candidate",
          result: "passed",
          decisionDigest: expect.any(String)
        }
      })

      const ack = await fixture("changed-before-ack", "cicd_in_progress")
      const state = await ack.runtime.command("autobiz-state-read", "alpha")
      const prepared = await ack.runtime.command("autobiz-state-check", "alpha cicd_done")
      expect(prepared).toMatchObject({ ok: true, verifiedCandidate: { result: "passed" } })
      const before = await ack.bytes()
      const journalRoot = join(ack.workspace, ".autobizdevops/function-state-journal")
      await mkdir(journalRoot, { recursive: true })
      const operation = randomUUID()
      const workflow = state.workflow as { policyDigest: string; digest: string }
      const child = spawn(
        "python",
        [
          "-I",
          "-B",
          "-X",
          "utf8",
          join(plugin, "mods/business/autobiz.state-machine/commit.py"),
          plugin,
          ack.workspace,
          "alpha",
          "cicd_in_progress",
          "cicd_done",
          String(state.stateDigest),
          operation,
          "null",
          journalRoot,
          workflow.policyDigest,
          "",
          workflow.digest,
          JSON.stringify(prepared.verifiedCandidate)
        ],
        { cwd: plugin, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
      )
      let stderr = ""
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString()
      })
      const closed = new Promise<number | null>((resolveExit, reject) => {
        child.once("close", resolveExit)
        child.once("error", reject)
      })
      let ready = false
      let outcome: Record<string, unknown> | undefined
      try {
        for await (const line of createInterface({ input: child.stdout })) {
          const message = JSON.parse(line)
          if (message.ready) {
            ready = true
            await writeFile(ack.codePath, "changed during the real prepared/ACK window\n")
            child.stdin.write(`commit:${operation}\n`)
          } else if (message.written) child.stdin.write(`release:${operation}\n`)
          else if ("applied" in message) outcome = message
        }
        expect(await closed, stderr).toBe(0)
        expect(ready).toBe(true)
        expect(outcome).toMatchObject({
          applied: false,
          status: "not-applied",
          reason: expect.stringContaining("AUTOBIZ_VERIFIED_CANDIDATE_CHANGED")
        })
        expect(await ack.bytes()).toEqual(before)
        expect((await readdir(journalRoot)).some((name) => name.endsWith(".physical.json"))).toBe(
          false
        )
      } finally {
        if (child.exitCode === null) child.kill()
        child.stdin.destroy()
        await closed
      }
      // No classic runHooks helper is called: these are direct guest SDK and real commit paths.
    } finally {
      for (const runtime of runtimes.reverse()) await runtime.close()
      await rm(parent, { recursive: true, force: true })
    }
  },
  120000
)
