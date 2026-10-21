import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"
import type { ModObject } from "../../../shared/mods/types"
import { createAutobizFunctionStateGuest } from "../../../../tests/support/autobiz-function-state-guest"

const execute = promisify(execFile)
const source = resolve(
  process.env.AUTOBIZ_FUNCTION_STATE_PLUGIN ??
    "output/deliveries/autobiz-function-state-20261021-root-r7/complete-plugin"
)
const optedIn = process.env.RUN_AUTOBIZ_FUNCTION_STATE_INTEGRATION === "1"
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it.runIf(optedIn)(
  "runs actual AutoBiz Function Mod commands through Python checks and the two-file writer",
  async () => {
    expect(existsSync(join(source, "plugin.json"))).toBe(true)
    const parent = await mkdtemp(join(tmpdir(), "abg-"))
    cleanup.push(() => rm(parent, { recursive: true, force: true }))
    const workspace = join(parent, "sample")
    await mkdir(workspace)
    const python = (args: string[]) =>
      execute("python", ["-I", "-B", "-X", "utf8", ...args], {
        cwd: source,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
          PLUGIN_WORKSPACE: parent,
          PROJECT_DIR: "sample",
          FEATURE_ID: "alpha",
          SESSION_WORKSPACE_PATH: workspace
        }
      })
    for (const [mode, args] of [
      ["createProject", []],
      ["createFeature", ["--feature", "alpha"]]
    ] as const)
      await python([
        join(source, "hooks/init_workspace.py"),
        "--mode",
        mode,
        "--workspace",
        parent,
        "--project",
        "sample",
        ...args
      ])
    const bytes = async () =>
      Promise.all(
        ["state.json", "STATE.md"].map((file) => readFile(join(workspace, ".autobizdevops", file)))
      )
    const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex")
    let runtime = await createAutobizFunctionStateGuest(source, workspace)
    cleanup.push(() => runtime.close())
    const before = await bytes()
    const read = await runtime.command("autobiz-state-read", "alpha")
    expect(read).toMatchObject({ ok: true, record: { checkpoint: "prd_in_progress" } })
    expect(read.stateDigest).toBe(digest(before[0]))
    expect(await bytes()).toEqual(before)
    const missing = await runtime.command("autobiz-state-check", "alpha prd_done")
    expect(missing.ok).toBe(false)
    expect(await bytes()).toEqual(before)
    expect(
      await runtime.command("autobiz-state-advance", `alpha prd_done ${read.stateDigest} missing`)
    ).toMatchObject({ ok: false })
    expect(await bytes()).toEqual(before)
    expect(
      await runtime.tool("advance", {
        feature: "alpha",
        to: "archived",
        expectedStateDigest: read.stateDigest,
        requestKey: "illegal"
      })
    ).toMatchObject({ isError: true })
    expect(await bytes()).toEqual(before)
    const stale = await runtime.command(
      "autobiz-state-advance",
      `alpha prd_done ${"0".repeat(64)} stale`
    )
    expect(stale.ok).toBe(false)
    expect(await bytes()).toEqual(before)

    // Original sample author writes business artifacts, never checkpoint/receipt fields.
    await python([
      resolve("tests/support/autobiz-creator-lifecycle-sample.py"),
      "prd",
      "--plugin-root",
      source,
      "--workspace",
      workspace,
      "--feature",
      "alpha"
    ])
    const check = await runtime.command("autobiz-state-check", "alpha prd_done")
    expect(check, JSON.stringify(check)).toMatchObject({ ok: true, status: "prepared" })
    const prepared = await runtime.command("autobiz-state-read", "alpha")
    const committed = await runtime.command(
      "autobiz-state-advance",
      `alpha prd_done ${prepared.stateDigest} actual-guest-commit`
    )
    expect(committed).toMatchObject({ ok: true, status: "committed" })
    const after = await bytes()
    expect(after[0]).not.toEqual(before[0])
    expect(JSON.parse(after[0].toString()).features.alpha.checkpoint).toBe("prd_done")
    expect((await runtime.command("autobiz-state-read", "alpha")).stateDigest).toBe(
      digest(after[0])
    )
    const duplicate = await runtime.command(
      "autobiz-state-advance",
      `alpha prd_done ${prepared.stateDigest} actual-guest-commit`
    )
    expect(duplicate).toMatchObject({ status: "committed", duplicate: true })
    expect(await bytes()).toEqual(after)
    expect(
      runtime.processRequests.some((row) => (row.request as ModObject).operation === "advance")
    ).toBe(true)

    await runtime.close()
    let designAnswer = "取消"
    let onDesignQuestion: (() => Promise<void>) | undefined
    runtime = await createAutobizFunctionStateGuest(source, workspace, {
      designAnswer: async () => {
        await onDesignQuestion?.()
        return designAnswer
      }
    })
    const recovered = await runtime.command("autobiz-state-read", "alpha")
    expect(recovered).toMatchObject({ ok: true, record: { checkpoint: "prd_done" } })
    expect(
      await runtime.command("autobiz-state-reconcile", "alpha actual-guest-commit")
    ).toMatchObject({ status: "committed", currentMatches: true })
    expect(await bytes()).toEqual(after)

    const advance = async (to: string, key: string) => {
      const state = await runtime.command("autobiz-state-read", "alpha")
      return runtime.command("autobiz-state-advance", `alpha ${to} ${state.stateDigest} ${key}`)
    }
    expect(await advance("specs_in_progress", "specs-start")).toMatchObject({ status: "committed" })
    await python([
      resolve("tests/support/autobiz-creator-lifecycle-sample.py"),
      "specs",
      "--plugin-root",
      source,
      "--workspace",
      workspace,
      "--feature",
      "alpha"
    ])
    expect(await advance("specs_done", "specs-done")).toMatchObject({ status: "committed" })
    expect(await advance("design_in_progress", "design-start")).toMatchObject({
      status: "committed"
    })
    await python([
      resolve("tests/support/autobiz-creator-lifecycle-sample.py"),
      "design",
      "--plugin-root",
      source,
      "--workspace",
      workspace,
      "--feature",
      "alpha"
    ])
    const designBefore = await bytes()
    expect(await advance("design_done", "design-cancel")).toMatchObject({
      ok: false,
      status: "not-applied"
    })
    expect(await bytes()).toEqual(designBefore)
    expect(runtime.questions).toHaveLength(1)
    expect(JSON.stringify(runtime.questions[0])).toContain("design_done")
    expect(JSON.stringify(runtime.questions[0])).toContain(digest(designBefore[0]))
    designAnswer = "yes"
    expect(await advance("design_done", "design-other-answer")).toMatchObject({ ok: false })
    expect(await bytes()).toEqual(designBefore)
    designAnswer = "确认技术设计并推进"
    const designPath = join(workspace, ".autobizdevops/features/alpha/design.md")
    const originalDesign = await readFile(designPath)
    onDesignQuestion = async () => {
      await writeFile(
        designPath,
        originalDesign.toString() + "\nChanged while awaiting approval.\n"
      )
      await python([
        join(source, "hooks/design_contract_lock.py"),
        "sync",
        "--workspace",
        workspace,
        "--feature",
        "alpha"
      ])
    }
    const changedDuringQuestion = await advance("design_done", "design-mutated-during-question")
    expect(changedDuringQuestion).toMatchObject({
      ok: false
    })
    expect(JSON.stringify(changedDuringQuestion)).toContain("AUTOBIZ_DESIGN_APPROVED_INPUT_CHANGED")
    expect(await bytes()).toEqual(designBefore)
    await writeFile(designPath, originalDesign)
    await python([
      join(source, "hooks/design_contract_lock.py"),
      "sync",
      "--workspace",
      workspace,
      "--feature",
      "alpha"
    ])
    onDesignQuestion = undefined
    expect(await advance("design_done", "design-confirmed")).toMatchObject({ status: "committed" })
    expect(JSON.parse((await bytes())[0].toString()).features.alpha.checkpoint).toBe("design_done")
  },
  120000
)
