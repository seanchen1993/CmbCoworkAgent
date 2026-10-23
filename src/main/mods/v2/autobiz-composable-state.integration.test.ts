import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"
import AdmZip from "adm-zip"
import { snapshotDerivationSource } from "../../plugins/derivation-source"
import { createAutobizFunctionStateGuest } from "../../../../tests/support/autobiz-function-state-guest"
import { createAutobizComposableFixture } from "../../../../tests/support/autobiz-composable-fixture"
import { createAutobizSampleContext } from "../../../../tests/support/autobiz-creator-context-sample"
import { canonicalTmpdir } from "../../../../tests/support/canonical-temp-dir"

const source = resolve(
  process.env.AUTOBIZ_FUNCTION_STATE_PLUGIN ??
    "output/deliveries/autobiz-function-state-20261023-root-r8/complete-plugin"
)
const optedIn = process.env.RUN_AUTOBIZ_FUNCTION_STATE_INTEGRATION === "1"
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it.runIf(optedIn).each([1, 2])(
  "runs generated pre-PRD revision %i through real guest, original checks and synchronized writer",
  async (minimumRevision) => {
    expect(existsSync(join(source, "plugin.json"))).toBe(true)
    const retained = process.env.AUTOBIZ_COMPOSABLE_OUTPUT
    const parent = retained
      ? join(resolve(retained), `revision-${minimumRevision}`)
      : await mkdtemp(join(canonicalTmpdir(), "autobiz-composable-"))
    if (retained) await mkdir(parent, { recursive: true })
    else cleanup.push(() => rm(parent, { recursive: true, force: true }))
    const fixture = await createAutobizComposableFixture(source, parent, { minimumRevision })
    const plugin = fixture.output
    // Original Hooks, configuration bindings, auxiliary Skills and knowledge remain exact bytes.
    for (const original of fixture.original.files.filter(
      (item) =>
        /^(hooks|skills|board_core)\//.test(item.path) &&
        item.path !== "board_core/board_config.json"
    ))
      expect(
        fixture.assembled.files.find((item) => item.path === original.path)?.digest,
        original.path
      ).toBe(original.digest)
    const workspace = join(parent, "project")
    await mkdir(workspace)
    const python = async (args: string[]) =>
      promisify(execFile)("python", ["-I", "-B", "-X", "utf8", ...args], {
        cwd: plugin,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
          PLUGIN_WORKSPACE: parent,
          PROJECT_DIR: "project",
          FEATURE_ID: "alpha",
          SESSION_WORKSPACE_PATH: workspace
        }
      })
    for (const [mode, args] of [
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
        "project",
        ...args
      ])
    const runtime = await createAutobizFunctionStateGuest(plugin, workspace)
    cleanup.push(() => runtime.close())
    const bytes = () =>
      Promise.all(
        ["state.json", "STATE.md"].map((name) => readFile(join(workspace, ".autobizdevops", name)))
      )
    const before = await bytes()
    const knowledge = await createAutobizSampleContext(plugin, workspace, join(parent, "context"))
    expect(knowledge.text).toContain("CREATOR_KNOWLEDGE_MUST_SURVIVE")
    expect(knowledge.text).toContain("CREATOR_WORKSPACE_RULE_MUST_SURVIVE")
    const initial = await runtime.command("autobiz-state-read", "alpha")
    expect(initial).toMatchObject({
      ok: true,
      record: { checkpoint: "convert_in_progress" },
      workflow: {
        nodes: [
          "biz.convert",
          "biz.prd",
          "dev.specs",
          "dev.design",
          "dev.plan",
          "dev.code",
          "ops.cicd",
          "ops.archive"
        ]
      }
    })
    expect(
      (initial.workflow as { stages: Array<{ id: string; outputs: unknown[] }> }).stages.find(
        (stage) => stage.id === "biz.convert"
      )?.outputs
    ).toMatchObject([
      { schemaVersion: "1.0.0", schema: { properties: { revision: { minimum: minimumRevision } } } }
    ])
    const advance = async (target: string, key: string) => {
      const state = await runtime.command("autobiz-state-read", "alpha")
      return runtime.command("autobiz-state-advance", `alpha ${target} ${state.stateDigest} ${key}`)
    }
    const converter = fixture.transformed.modules.find((item) => item.id === "biz.convert")!
    const skill = await runtime.session.classicEvent("classic.PreSkillUse", {
      hook_event_name: "PreSkillUse",
      session_id: "actual-autobiz-function-guest",
      transcript_path: "",
      cwd: workspace,
      skill_name: String(converter.node.skill),
      skill_path: join(plugin, converter.skill.entry),
      skill_root: join(plugin, converter.skill.entry, ".."),
      skill_trigger_tool_name: "skill",
      plugin_name: "autobiz-converted-requirements",
      plugin_root: plugin
    })
    expect(JSON.stringify(skill)).toContain("state_preflight")
    expect(
      await runtime.session.interceptTool(
        {
          tool: "execute",
          tool_use_id: "legacy-guard",
          command: `python "${join(plugin, "hooks/update_checkpoint.py")}" --checkpoint prd_done`
        },
        new AbortController().signal,
        async () => {
          throw Error("legacy writer must not execute")
        }
      )
    ).toMatchObject({ isError: true, result: { error: "AUTOBIZ_MOD_LEGACY_WRITER_BLOCKED" } })
    for (const command of [
      'python "C:/other-plugin/hooks/update_checkpoint.py" --checkpoint done',
      `Get-Content "${join(plugin, "hooks/update_checkpoint.py")}"`
    ])
      expect(
        await runtime.session.interceptTool(
          { tool: "execute", tool_use_id: "unrelated", command },
          new AbortController().signal,
          async () => ({ result: "unrelated original tool ran" })
        )
      ).toMatchObject({ result: "unrelated original tool ran" })
    expect(await advance("prd_in_progress", "skip-conversion")).toMatchObject({ ok: false })
    const missingOutput = await advance("convert_done", "missing-output")
    expect(missingOutput).toMatchObject({ ok: false, status: "not-applied" })
    expect(JSON.stringify(missingOutput)).not.toContain("unexpected token")
    const journalRoot = join(workspace, ".autobizdevops/function-state-journal")
    expect(existsSync(journalRoot) ? await readdir(journalRoot) : []).toEqual([])
    expect(await bytes()).toEqual(before)
    const artifact = join(workspace, ".autobizdevops/features/alpha/NORMALIZED_REQUIREMENTS.json")
    await writeFile(
      artifact,
      JSON.stringify({ feature: "other", revision: minimumRevision, requirements: ["A"] })
    )
    expect(await advance("convert_done", "wrong-feature")).toMatchObject({
      ok: false,
      status: "not-applied"
    })
    await writeFile(
      artifact,
      JSON.stringify({ feature: "alpha", revision: minimumRevision, requirements: [] })
    )
    const schemaFailure = await advance("convert_done", "empty-requirements")
    expect(schemaFailure).toMatchObject({ ok: false, status: "not-applied" })
    expect(JSON.stringify(schemaFailure)).toContain("AUTOBIZ_OUTPUT_SCHEMA_ITEMS")
    expect(await bytes()).toEqual(before)
    await writeFile(
      artifact,
      JSON.stringify({
        feature: "alpha",
        revision: minimumRevision,
        requirements: ["对整数加一", "对整数乘二"]
      })
    )
    expect(await advance("convert_done", "converted")).toMatchObject({
      ok: true,
      status: "committed"
    })
    const afterConversion = await bytes()
    expect(
      await runtime.command(
        "autobiz-state-advance",
        `alpha convert_done ${initial.stateDigest} converted`
      )
    ).toMatchObject({ ok: true, status: "committed", duplicate: true })
    expect(await bytes()).toEqual(afterConversion)
    const verifiedConversion = await readFile(artifact)
    await writeFile(
      artifact,
      JSON.stringify({
        feature: "alpha",
        revision: minimumRevision,
        requirements: ["未经校验的新需求"]
      })
    )
    const tampered = await advance("prd_in_progress", "changed-upstream")
    expect(tampered).toMatchObject({ ok: false, status: "not-applied" })
    expect(JSON.stringify(tampered)).toContain("AUTOBIZ_UPSTREAM_ARTIFACT_CHANGED")
    await writeFile(artifact, verifiedConversion)
    await rm(artifact)
    const completed = await bytes()
    expect(await advance("prd_in_progress", "missing-upstream")).toMatchObject({ ok: false })
    expect(await bytes()).toEqual(completed)
    await writeFile(
      artifact,
      JSON.stringify({
        feature: "alpha",
        revision: minimumRevision,
        requirements: ["对整数加一", "对整数乘二"]
      })
    )
    expect(await advance("prd_in_progress", "handoff")).toMatchObject({
      ok: true,
      status: "committed"
    })
    const authoredPrd = await python([
      resolve("tests/support/autobiz-composable-prd-sample.py"),
      plugin,
      workspace,
      "alpha"
    ])
    expect(JSON.parse(authoredPrd.stdout)).toMatchObject({ read: "NORMALIZED_REQUIREMENTS.json" })
    const prdPath = join(workspace, ".autobizdevops/features/alpha/PRD.md")
    const validPrd = await readFile(prdPath, "utf8")
    const beforeLineageRejection = await bytes()
    for (const [label, changed] of [
      ["missing-requirement", validPrd.replaceAll("对整数乘二", "")],
      ["missing-source", validPrd.replace("来源：NORMALIZED_REQUIREMENTS.json", "")]
    ]) {
      await writeFile(prdPath, changed)
      const rejected = await advance("prd_done", label)
      expect(rejected).toMatchObject({ ok: false, status: "not-applied" })
      expect(JSON.stringify(rejected)).toContain("AUTOBIZ_PRD_REQUIREMENTS_NOT_COVERED")
      expect(await bytes()).toEqual(beforeLineageRejection)
    }
    await writeFile(prdPath, validPrd)
    const uiPath = join(workspace, ".autobizdevops/features/alpha/UI_CONTEXT.json")
    const validUi = await readFile(uiPath, "utf8")
    const wrongUi = JSON.parse(validUi)
    wrongUi.featureId = "other"
    await writeFile(uiPath, JSON.stringify(wrongUi))
    const beforeOriginalHookRejection = await bytes()
    expect(await advance("prd_done", "original-hook-failure")).toMatchObject({ ok: false })
    expect(await bytes()).toEqual(beforeOriginalHookRejection)
    await writeFile(uiPath, validUi)
    expect(await advance("prd_done", "original-prd-hooks")).toMatchObject({
      ok: true,
      status: "committed"
    })
    await writeFile(prdPath, "# 不符合原业务产物要求的 PRD\n")
    const beforeBizRejection = await bytes()
    expect(await advance("specs_in_progress", "original-biz-hook-failure")).toMatchObject({
      ok: false
    })
    expect(await bytes()).toEqual(beforeBizRejection)
    await writeFile(prdPath, validPrd)
    expect(await advance("specs_in_progress", "original-biz-hook-pass")).toMatchObject({
      ok: true,
      status: "committed"
    })
    const final = await bytes()
    expect(JSON.parse(final[0].toString()).features.alpha.checkpoint).toBe("specs_in_progress")
    expect(final[1].toString()).toContain("specs_in_progress")
    const prd = await readFile(prdPath, "utf8")
    expect(prd).toContain("来源：NORMALIZED_REQUIREMENTS.json")
    expect(prd).toContain("对整数加一")
    expect(prd).toContain("对整数乘二")
    let schemaContractProbe: { passed: true; calls: number } | undefined
    if (minimumRevision === 2) {
      // Use the unchanged original compiler's real workspace overlay protocol.
      // This is a second actual workflow; no stage evidence or postcheck is mocked.
      const proofWorkspace = join(parent, "contract-proof")
      await mkdir(proofWorkspace)
      await python([
        join(plugin, "hooks/init_workspace.py"),
        "--mode",
        "createProject",
        "--workspace",
        parent,
        "--project",
        "contract-proof"
      ])
      const overlayDirectory = join(proofWorkspace, ".autobizdevops/workflow.d")
      await mkdir(overlayDirectory, { recursive: true })
      const overlayPath = join(overlayDirectory, "contract-proof.json")
      const overlay = {
        profile: "contract-proof",
        nodes: [
          {
            id: "biz.handoff-review",
            label: "Review normalized handoff",
            phase: "Biz",
            skill: "autodev-reviewer",
            checkpointPrefix: "handoff_review",
            insertBefore: "biz.prd",
            artifacts: {
              inputs: [
                {
                  id: "normalized_requirements",
                  path: "NORMALIZED_REQUIREMENTS.json",
                  required: true,
                  schemaVersion: "1.0.0"
                }
              ],
              outputs: [
                {
                  id: "normalized_requirements",
                  path: "NORMALIZED_REQUIREMENTS.json",
                  required: true,
                  artifactType: "json",
                  schemaVersion: "1.0.0",
                  schema: {
                    type: "object",
                    required: ["requirements"],
                    properties: {
                      requirements: { type: "array", minItems: 1 }
                    }
                  }
                }
              ]
            },
            validators: [],
            guards: []
          }
        ]
      }
      const originalOverlay = JSON.stringify(overlay)
      await writeFile(overlayPath, originalOverlay)
      await python([
        join(plugin, "hooks/init_workspace.py"),
        "--mode",
        "createFeature",
        "--workspace",
        parent,
        "--project",
        "contract-proof",
        "--feature",
        "alpha",
        "--workflow-profile",
        "contract-proof"
      ])
      await writeFile(
        join(proofWorkspace, ".autobizdevops/features/alpha/NORMALIZED_REQUIREMENTS.json"),
        JSON.stringify({
          feature: "alpha",
          revision: minimumRevision,
          requirements: ["对整数加一", "对整数乘二"]
        })
      )
      const producerRuntime = await createAutobizFunctionStateGuest(plugin, proofWorkspace)
      cleanup.push(() => producerRuntime.close())
      const proofAdvance = async (guest: typeof producerRuntime, target: string, key: string) => {
        const state = await guest.command("autobiz-state-read", "alpha")
        expect(state.ok, JSON.stringify(state)).toBe(true)
        return guest.command("autobiz-state-advance", `alpha ${target} ${state.stateDigest} ${key}`)
      }
      for (const target of ["convert_done", "handoff_review_in_progress", "handoff_review_done"])
        expect(await proofAdvance(producerRuntime, target, `proof-${target}`)).toMatchObject({
          ok: true,
          status: "committed"
        })
      await producerRuntime.close()
      const proofBytes = () =>
        Promise.all(
          ["state.json", "STATE.md"].map((name) =>
            readFile(join(proofWorkspace, ".autobizdevops", name))
          )
        )
      const beforeContractChange = await proofBytes()
      overlay.nodes[0].artifacts.outputs[0].schema.properties.requirements.minItems = 3
      await writeFile(overlayPath, JSON.stringify(overlay))
      const changedRuntime = await createAutobizFunctionStateGuest(plugin, proofWorkspace)
      cleanup.push(() => changedRuntime.close())
      const staleContract = await proofAdvance(
        changedRuntime,
        "prd_in_progress",
        "changed-contract"
      )
      expect(staleContract).toMatchObject({ ok: false, status: "not-applied" })
      expect(JSON.stringify(staleContract)).toContain("AUTOBIZ_UPSTREAM_ARTIFACT_CHANGED")
      expect(await proofBytes()).toEqual(beforeContractChange)
      await changedRuntime.close()
      await writeFile(overlayPath, originalOverlay)
      const restoredRuntime = await createAutobizFunctionStateGuest(plugin, proofWorkspace)
      cleanup.push(() => restoredRuntime.close())
      expect(
        await proofAdvance(restoredRuntime, "prd_in_progress", "restored-contract")
      ).toMatchObject({ ok: true, status: "committed" })
      schemaContractProbe = {
        passed: true,
        calls: [producerRuntime, changedRuntime, restoredRuntime].reduce(
          (count, guest) => count + guest.processRequests.length,
          0
        )
      }
      await restoredRuntime.close()
    }
    // Editing a Skill inside an active session invalidates its pinned actual source closure.
    const skillPath = join(plugin, converter.skill.entry)
    const originalSkill = await readFile(skillPath, "utf8")
    await writeFile(skillPath, originalSkill + "\n修改需求转换措辞。\n")
    const sourceChanged = await runtime.command("autobiz-state-read", "alpha")
    expect(sourceChanged).toMatchObject({ ok: false })
    expect(JSON.stringify(sourceChanged)).toContain("AUTOBIZ_MOD_SOURCE_CHANGED_REOPEN_SESSION")
    expect(await bytes()).toEqual(final)
    await writeFile(skillPath, originalSkill)
    const boardPath = join(plugin, "board_core/board_config.json")
    const originalBoard = await readFile(boardPath, "utf8")
    const changedBoard = JSON.parse(originalBoard)
    changedBoard.workflow.nodes[0].label = "运行中修改步骤"
    await writeFile(boardPath, JSON.stringify(changedBoard))
    expect(JSON.stringify(await runtime.command("autobiz-state-read", "alpha"))).toContain(
      "AUTOBIZ_MOD_SOURCE_CHANGED_REOPEN_SESSION"
    )
    expect(await bytes()).toEqual(final)
    await writeFile(boardPath, originalBoard)
    if (retained) {
      const snapshot = await snapshotDerivationSource(plugin)
      const zip = new AdmZip()
      for (const item of snapshot.files) zip.addFile(item.path, item.bytes)
      const archive = zip.toBuffer()
      const zipPath = join(parent, "AutoBiz-需求转换-Mods-1.1.0.zip")
      await writeFile(zipPath, archive, { flag: "wx" })
      const report = {
        passed: true,
        executionVerified: true,
        controlledAuthor: true,
        remoteModelVerified: false,
        minimumRevision,
        plugin,
        zipPath,
        packageDigest: snapshot.digest,
        sourceDigest: fixture.original.digest,
        zipSha256: createHash("sha256").update(archive).digest("hex"),
        actualFinalCheckpoint: "specs_in_progress",
        nativeCapabilityStatus: fixture.native.status,
        legacyAdapter: fixture.native.legacyAdapter,
        workflowEvidence: fixture.transformed.evidence,
        replacementIds: fixture.transformed.replacements,
        calls: runtime.processRequests.length,
        ...(schemaContractProbe ? { schemaContractProbe } : {}),
        checks: [
          "actual-original-initialization-enters-converter",
          "ordinary-skill-lifecycle-instruction",
          "legacy-writer-blocked",
          "unrelated-plugin-and-read-not-blocked",
          "illegal-skip-blocked",
          "missing-output-blocked",
          "custom-python-business-validator",
          "output-json-schema",
          "required-upstream-input",
          "published-upstream-byte-digest",
          ...(schemaContractProbe ? ["fresh-session-current-producer-schema-contract"] : []),
          "upstream-content-read-into-prd",
          "prd-required-requirement-and-source-lineage-validator",
          "original-prd-hooks",
          "original-hook-failure-blocked",
          "real-local-knowledge-and-config-render",
          "state-json-markdown-synchronized",
          "active-skill-edit-invalidates-policy",
          "active-step-edit-invalidates-policy",
          "duplicate-request-reconciled-without-replay"
        ]
      }
      for (const name of ["runtime-verification.json", "function-state-conversion.json"])
        await writeFile(join(parent, name), JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
    }
  },
  120000
)
