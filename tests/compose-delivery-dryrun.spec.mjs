/**
 * Behavioral dry-run suite for the CmbCowork Compose Delivery plugin.
 *
 * Run:
 *   npx tsx tests/compose-delivery-dryrun.spec.mjs
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { validateWorkflowScript } from "../src/main/agent/workflow/script.ts"
import { discoverSkillsSync } from "../src/main/skills/discovery.ts"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(dirname, "..")
const pluginRoot = path.join(root, "plugins", "compose-delivery")
const workflowPath = path.join(pluginRoot, "workflow", "compose-delivery.workflow.js")
const workflowSource = fs.readFileSync(workflowPath, "utf8")
const parsed = validateWorkflowScript(workflowSource)

const source = workflowSource.replace(/^export const meta/m, "const meta")
const runScript = new Function(
  "agent",
  "parallel",
  "phase",
  "log",
  "args",
  "glob",
  "readFile",
  "writeFile",
  "exists",
  '"use strict"; return (async () => {' + source + "})()"
)

const VERIFY_PASS = {
  typecheck: "ok",
  tests: { passed: 4, failed: 0, output: "4 passed" },
  build: "ok",
  allPassed: true,
  failures: ""
}

const REVIEW_READY = {
  critical: [],
  important: [],
  minor: [],
  readyToMerge: true
}

const DEFAULT_TASKS = [
  {
    id: "T1",
    description: "Implement the first independent unit",
    acceptance: "The first behavior works",
    files: ["src/a.ts"],
    dependsOn: []
  },
  {
    id: "T2",
    description: "Implement the second independent unit",
    acceptance: "The second behavior works",
    files: ["src/b.ts"],
    dependsOn: []
  },
  {
    id: "T3",
    description: "Connect the two units",
    acceptance: "The integrated behavior works",
    files: ["src/c.ts"],
    dependsOn: ["T1"]
  }
]

function markdownGlob(files, pattern) {
  if (!pattern.endsWith("/*.md")) return []
  const prefix = pattern.slice(0, -4)
  return Object.keys(files)
    .filter((file) => file.startsWith(prefix) && file.endsWith(".md"))
    .sort()
}

function makeEnvironment(overrides = {}) {
  const files = { ...(overrides.files || {}) }
  const calls = []
  const phases = []
  const logs = []
  const options = []
  let activeWriters = 0
  let maxActiveWriters = 0
  let verifyCalls = 0
  let reviewCalls = 0
  let designWriteCalls = 0

  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ""
    calls.push(label)
    options.push({ label, opts, prompt })
    const isWriter =
      label.startsWith("implement:") ||
      label.startsWith("fix:") ||
      label === "debug" ||
      label.startsWith("design:") ||
      label.startsWith("iteration-report:") ||
      label.startsWith("final-report")
    if (isWriter) {
      activeWriters += 1
      maxActiveWriters = Math.max(maxActiveWriters, activeWriters)
    }

    try {
      if (label === "brainstorm") {
        if (overrides.brainstorm) return overrides.brainstorm()
        return {
          context: {
            projectType: "TypeScript",
            conventions: ["follow AGENTS.md"],
            recentChanges: [],
            relevantFiles: ["src/a.ts"],
            baseSha: "abc123",
            initialStatus: []
          },
          assumptions: [],
          selfQA: [],
          approaches: [],
          chosenApproach: "minimal",
          chosenRationale: "fits the request",
          openQuestions: []
        }
      }
      if (label.startsWith("design:")) {
        designWriteCalls += 1
        if (overrides.designWrite) {
          return overrides.designWrite({ label, prompt, files, designWriteCalls })
        }
        files["docs/compose/specs/demo.md"] = "# Demo specification"
        files["docs/compose/plans/demo.md"] = "# Demo implementation plan"
        return "design written"
      }
      if (label.startsWith("design-extract:")) {
        if (overrides.designExtract) return overrides.designExtract()
        return { tasks: overrides.tasks || DEFAULT_TASKS, notes: "" }
      }
      if (label.startsWith("implement:")) {
        await new Promise((resolve) => setImmediate(resolve))
        if (overrides.implement) return overrides.implement(label)
        return "implemented"
      }
      if (label === "verify") {
        verifyCalls += 1
        if (overrides.verify) return overrides.verify(verifyCalls)
        return VERIFY_PASS
      }
      if (label.startsWith("iteration-report:")) {
        if (overrides.iterationReport) return overrides.iterationReport(label, files)
        files["docs/compose/reports/demo.md"] = "# Iteration report"
        return "report written"
      }
      if (label === "review") {
        reviewCalls += 1
        if (overrides.review) return overrides.review(reviewCalls)
        return REVIEW_READY
      }
      if (label.startsWith("fix:")) {
        await new Promise((resolve) => setImmediate(resolve))
        if (overrides.fix) return overrides.fix(label)
        return "fixed"
      }
      if (label === "debug") return "debugged"
      if (label === "final-report" || label === "final-report-retry") {
        if (overrides.finalReport) return overrides.finalReport(label, files)
        files["docs/compose/reports/demo.md"] = "# Final report"
        return "final report written"
      }
      if (label === "merge") {
        if (overrides.merge) return overrides.merge()
        return { committed: true, sha: "def456", action: "commit" }
      }
      throw new Error("Unhandled agent label: " + label)
    } finally {
      if (isWriter) activeWriters -= 1
    }
  }

  return {
    files,
    calls,
    phases,
    logs,
    options,
    get maxActiveWriters() {
      return maxActiveWriters
    },
    get designWriteCalls() {
      return designWriteCalls
    },
    globals: {
      agent,
      parallel: (thunks) => Promise.all(thunks.map((thunk) => thunk().catch(() => null))),
      phase: (title) => phases.push(title),
      log: (message) => logs.push(message),
      glob: async (pattern) => markdownGlob(files, pattern),
      readFile: async (file) => {
        if (!(file in files)) throw new Error("ENOENT: " + file)
        return files[file]
      },
      writeFile: async (file, content) => {
        files[file] = content
      },
      exists: async (file) => file in files
    }
  }
}

async function execute(env, args = {}) {
  const g = env.globals
  return runScript(
    g.agent,
    g.parallel,
    g.phase,
    g.log,
    { task: "Build the demo feature", type: "feature", feature_name: "demo", ...args },
    g.glob,
    g.readFile,
    g.writeFile,
    g.exists
  )
}

function indexOfCall(calls, label) {
  const index = calls.indexOf(label)
  assert.notEqual(index, -1, `missing call ${label}`)
  return index
}

async function happyPathPreservesSourceFlow() {
  const env = makeEnvironment()
  const result = await execute(env, { isolate_worktrees: true, maxConcurrent: 8 })

  assert.equal(result.merge.committed, true)
  assert.deepEqual(result.batches, [["T1", "T2"], ["T3"]])
  assert.equal(env.maxActiveWriters, 1)
  assert.deepEqual(
    env.calls.filter((label) => label.startsWith("implement:")),
    ["implement:T1", "implement:T2", "implement:T3"]
  )
  assert.equal(env.calls.filter((label) => label === "review").length, 1)
  assert.equal(env.calls.some((label) => label.startsWith("review:task:")), false)
  assert.equal(env.calls.includes("integrate"), false)
  assert.equal(env.options.some(({ opts }) => Object.hasOwn(opts, "isolation")), false)
  assert.ok(env.logs.some((line) => line.includes("downgraded")))
  assert.ok(indexOfCall(env.calls, "verify") < indexOfCall(env.calls, "review"))
}

async function optionalFlagsArePreserved() {
  const env = makeEnvironment()
  const result = await execute(env, {
    type: "refactor",
    skip_brainstorm: true,
    skip_report: true
  })

  assert.equal(result.type, "refactor")
  assert.equal(result.finalReport, null)
  assert.equal(env.calls.includes("brainstorm"), false)
  assert.equal(
    env.calls.some((label) => label.startsWith("iteration-report:") || label.startsWith("final-report")),
    false
  )
  assert.ok(env.options.find(({ label }) => label === "design:refactor")?.prompt.includes("`compose:plan`"))
}

async function verificationRetriesThroughDebug() {
  const env = makeEnvironment({
    verify: (call) =>
      call === 1
        ? {
            typecheck: "ok",
            tests: { passed: 2, failed: 1, output: "1 failed" },
            build: "skipped",
            allPassed: false,
            failures: "retryable test failure"
          }
        : VERIFY_PASS
  })
  const result = await execute(env)

  assert.equal(result.merge.committed, true)
  assert.equal(result.implementHistory.length, 2)
  assert.equal(env.calls.filter((label) => label === "debug").length, 1)
  assert.equal(env.calls.filter((label) => label.startsWith("implement:")).length, 6)
}

async function criticalFindingsUseSourceFixLoop() {
  const env = makeEnvironment({
    verify: (call) => ({
      ...VERIFY_PASS,
      tests: {
        ...VERIFY_PASS.tests,
        output: call === 1 ? "initial evidence" : "post-fix evidence"
      }
    }),
    review: (call) =>
      call === 1
        ? {
            critical: ["first defect", "second defect", "third defect"],
            important: ["non-blocking follow-up"],
            minor: [],
            readyToMerge: false
          }
        : REVIEW_READY
  })
  const result = await execute(env)

  assert.equal(result.merge.committed, true)
  assert.equal(result.reviewFixes, 1)
  assert.deepEqual(
    env.calls.filter((label) => label.startsWith("fix:")),
    ["fix:0", "fix:1", "fix:2"]
  )
  assert.equal(env.calls.filter((label) => label === "verify").length, 2)
  assert.equal(env.calls.filter((label) => label === "review").length, 2)
  assert.ok(env.options.find(({ label }) => label === "fix:0")?.prompt.includes("first defect"))
  assert.ok(env.options.find(({ label }) => label === "fix:1")?.prompt.includes("second defect"))
  assert.ok(env.options.find(({ label }) => label === "fix:2")?.prompt.includes("third defect"))
  const reviews = env.options.filter(({ label }) => label === "review")
  assert.ok(reviews[0].prompt.includes("initial evidence"))
  assert.ok(reviews[1].prompt.includes("post-fix evidence"))
}

async function importantFindingDoesNotCreateExtraFixStage() {
  const env = makeEnvironment({
    review: () => ({
      critical: [],
      important: ["follow up after delivery"],
      minor: [],
      readyToMerge: true
    })
  })
  const result = await execute(env)

  assert.equal(result.merge.committed, true)
  assert.equal(env.calls.some((label) => label.startsWith("fix:")), false)
  assert.deepEqual(result.review.important, ["follow up after delivery"])
}

async function cyclicPlanFailsBeforeImplementation() {
  const env = makeEnvironment({
    tasks: [
      { id: "T1", description: "first", acceptance: "done", dependsOn: ["T2"] },
      { id: "T2", description: "second", acceptance: "done", dependsOn: ["T1"] }
    ]
  })
  const result = await execute(env)

  assert.equal(result.error, "design-cycle")
  assert.equal(env.calls.some((label) => label.startsWith("implement:")), false)
}

async function dependencyMetadataRemainsOptional() {
  const env = makeEnvironment({
    tasks: [{ id: "T1", description: "one task", acceptance: "done" }]
  })
  const result = await execute(env)

  assert.equal(result.merge.committed, true)
  assert.deepEqual(result.batches, [["T1"]])
}

async function missingDesignDocsUseExtractionFallback() {
  const env = makeEnvironment({
    designWrite: () => "design agent skipped writes"
  })
  const result = await execute(env)

  assert.equal(result.merge.committed, true)
  assert.equal(env.designWriteCalls, 2)
  assert.ok(
    env.options
      .find(({ label }) => label.startsWith("design-extract:"))
      ?.prompt.includes("No plan file found")
  )
}

async function failedImplementerCannotBeMaskedByPassingTests() {
  const env = makeEnvironment({
    implement: (label) => (label === "implement:T2" ? null : "implemented")
  })
  const result = await execute(env)

  assert.equal(result.error, "verify-exhausted")
  assert.equal(env.calls.includes("merge"), false)
}

async function reviewUsesPreparedReadOnlyPackage() {
  const env = makeEnvironment()
  const result = await execute(env)
  assert.equal(result.merge.committed, true)

  const review = env.options.find(({ label }) => label === "review")
  assert.ok(review?.prompt.includes("Review is read-only"))
  assert.ok(review?.prompt.includes("build-review-package.sh"))
  assert.ok(review?.prompt.includes("review-package.diff"))
  assert.ok(review?.prompt.includes("spec-compliance BEFORE code-quality"))
  assert.ok(review?.prompt.includes("Fresh verification evidence"))
  assert.equal(review?.prompt.includes("acceptanceEvidence"), false)

  const packageBuilder = env.files[".cmbdevclaw/compose-delivery/demo/build-review-package.sh"]
  assert.ok(packageBuilder?.includes("git diff -U10"))
  assert.ok(packageBuilder?.includes('":(exclude).cmbdevclaw/**"'))

  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "compose-review-package-"))
  try {
    execFileSync("git", ["init", "-q"], { cwd: tempRepo })
    fs.writeFileSync(path.join(tempRepo, "tracked.txt"), "before\n")
    execFileSync("git", ["add", "tracked.txt"], { cwd: tempRepo })
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"],
      { cwd: tempRepo }
    )
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tempRepo,
      encoding: "utf8"
    }).trim()
    const runtimeDir = path.join(tempRepo, ".cmbdevclaw", "compose-delivery", "demo")
    fs.mkdirSync(runtimeDir, { recursive: true })
    const builderPath = path.join(runtimeDir, "build-review-package.sh")
    const initialStatusPath = path.join(runtimeDir, "initial-status.txt")
    const packagePath = path.join(runtimeDir, "review-package.diff")
    fs.writeFileSync(builderPath, packageBuilder)
    fs.writeFileSync(initialStatusPath, "")
    fs.writeFileSync(path.join(tempRepo, "tracked.txt"), "after\n")
    fs.writeFileSync(path.join(tempRepo, "new.txt"), "new content\n")
    execFileSync("bash", [builderPath, base, initialStatusPath, packagePath], { cwd: tempRepo })
    const packageText = fs.readFileSync(packagePath, "utf8")
    assert.ok(packageText.includes("+after"))
    assert.ok(packageText.includes("+++ b/new.txt"))
    assert.equal(packageText.includes("build-review-package.sh"), false)
  } finally {
    fs.rmSync(tempRepo, { recursive: true, force: true })
  }
}

async function missingReviewFailsClosed() {
  const env = makeEnvironment({ review: () => null })
  const result = await execute(env)

  assert.equal(result.error, "review-failed")
  assert.equal(result.readyToMerge, false)
  assert.equal(env.calls.includes("merge"), false)
}

async function persistentCriticalFindingsStopAfterRetryLimit() {
  const env = makeEnvironment({
    review: () => ({
      critical: ["still broken"],
      important: [],
      minor: [],
      readyToMerge: false
    })
  })
  const result = await execute(env)

  assert.equal(result.readyToMerge, false)
  assert.equal(env.calls.filter((label) => label.startsWith("fix:")).length, 2)
  assert.equal(env.calls.filter((label) => label === "review").length, 3)
  assert.equal(env.calls.includes("merge"), false)
}

async function missingFinalReportDoesNotAddANewGate() {
  const env = makeEnvironment({
    iterationReport: () => null,
    finalReport: () => null
  })
  const result = await execute(env)

  assert.equal(result.merge.committed, true)
  assert.equal(result.finalReport.written, false)
  assert.equal(env.calls.filter((label) => label === "final-report-retry").length, 1)
}

async function mergeWithoutShaStillSucceeds() {
  const env = makeEnvironment({
    merge: () => ({ committed: true, action: "none" })
  })
  const result = await execute(env)

  assert.equal(result.merge.committed, true)
  assert.equal(result.merge.sha, undefined)
}

async function onlyMergeOwnsCommits() {
  const env = makeEnvironment({
    review: (call) =>
      call === 1
        ? { critical: ["fix me"], important: [], minor: [], readyToMerge: false }
        : REVIEW_READY
  })
  const result = await execute(env)
  assert.equal(result.merge.committed, true)

  for (const label of ["design:feature", "implement:T1", "fix:0", "final-report"]) {
    const call = env.options.find((item) => item.label === label)
    assert.ok(call, `missing expected call ${label}`)
    assert.match(call.prompt, /do not[\s\S]{0,160}(stage|commit|git add)|single delivery commit/i)
  }
  const merge = env.options.find(({ label }) => label === "merge")
  assert.ok(merge?.prompt.includes("owns the single delivery commit"))
  assert.ok(merge?.prompt.includes("never stage `.cmbdevclaw/**`"))
  assert.ok(merge?.prompt.includes("never use `git add -A` or `git add .`"))
}

function assertBundleAndContracts() {
  assert.equal(parsed.meta.name, "compose")
  assert.deepEqual(
    parsed.meta.phases?.map((item) => item.title),
    ["Brainstorm", "Design", "Implement", "Verify", "Review", "Report", "Merge"]
  )
  assert.ok(workflowSource.includes("`structured_output` tool EXACTLY ONCE"))
  assert.equal(workflowSource.includes("Use the `skill` tool"), false)
  assert.ok(workflowSource.includes("Find its exact SKILL.md path in Available Skills"))
  assert.ok(workflowSource.includes("build-review-package.sh"))
  assert.ok(workflowSource.includes("final Merge phase owns the single delivery commit"))
  assert.equal(workflowSource.includes("task-review"), false)
  assert.equal(workflowSource.includes("TASK_BRIEF"), false)
  assert.equal(workflowSource.includes("contractIssues"), false)
  assert.equal(workflowSource.includes("acceptanceEvidence"), false)
  assert.equal(workflowSource.includes("sourcePlanPath"), false)
  assert.equal(workflowSource.includes("design-dependency-missing"), false)
  assert.equal(workflowSource.includes("runIntegrate"), false)
  assert.equal(workflowSource.includes("INTEGRATE_SHAPE"), false)
  assert.equal(workflowSource.includes("parallel("), false)
  assert.ok(workflowSource.split("\n").length < 900, "workflow should remain close to the source workflow's weight")

  const launcher = fs.readFileSync(path.join(pluginRoot, "SKILL.md"), "utf8")
  assert.ok(launcher.includes('scriptPath: ".cmbdevclaw/workflows/compose-delivery.workflow.js"'))
  assert.ok(launcher.includes("Resume with `resumeFromRunId` alone"))
  assert.ok(launcher.includes("one combined global Review"))
  assert.equal(launcher.includes("task brief"), false)
  assert.ok(launcher.includes("adds no task-level Review"))

  const requiredSkills = [
    "ask",
    "brainstorm",
    "debug",
    "execute",
    "feedback",
    "merge",
    "parallel",
    "plan",
    "report",
    "review",
    "subagent",
    "tdd",
    "verify",
    "worktree"
  ]
  const discovered = new Set(discoverSkillsSync(pluginRoot).map((skill) => skill.name))
  assert.equal(discovered.has("compose-delivery"), true)
  for (const name of requiredSkills) {
    assert.equal(discovered.has("compose:" + name), true, `missing compose:${name}`)
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "plugin.json"), "utf8"))
  assert.equal(manifest.name, "Compose Delivery")
  assert.equal(manifest.version, "1.0.5")
  assert.equal(manifest.skills, "skills")

  const readSkill = (name) =>
    fs.readFileSync(path.join(pluginRoot, "skills", name, "SKILL.md"), "utf8")
  assert.ok(readSkill("brainstorm").includes("Dynamic Workflow Boundary"))
  assert.ok(readSkill("plan").includes("Shared-workspace workflow override"))
  assert.ok(readSkill("review").includes("prepared Review Package"))
  assert.ok(readSkill("report").includes("Dynamic Workflow Boundary"))
  assert.ok(readSkill("merge").includes("never `.cmbdevclaw/**`"))
}

const cases = [
  ["bundle contains only the source flow plus CmbCowork adapters", async () => assertBundleAndContracts()],
  ["happy path preserves the source flow and serializes writers", happyPathPreservesSourceFlow],
  ["optional flags and explicit type are preserved", optionalFlagsArePreserved],
  ["failed verification retries through debug", verificationRetriesThroughDebug],
  ["critical findings use the source fix/reverify/review loop", criticalFindingsUseSourceFixLoop],
  ["important findings do not create an extra fix stage", importantFindingDoesNotCreateExtraFixStage],
  ["cyclic plans fail before implementation", cyclicPlanFailsBeforeImplementation],
  ["dependsOn remains optional", dependencyMetadataRemainsOptional],
  ["missing design docs use extraction fallback", missingDesignDocsUseExtractionFallback],
  ["failed implementer cannot be masked by passing tests", failedImplementerCannotBeMaskedByPassingTests],
  ["review uses one prepared read-only package", reviewUsesPreparedReadOnlyPackage],
  ["missing structured review fails closed", missingReviewFailsClosed],
  ["persistent critical findings stop after the retry limit", persistentCriticalFindingsStopAfterRetryLimit],
  ["missing final report does not add a new delivery gate", missingFinalReportDoesNotAddANewGate],
  ["merge without SHA succeeds when committed", mergeWithoutShaStillSucceeds],
  ["only Merge owns a commit in the shared workspace", onlyMergeOwnsCommits]
]

let failures = 0
for (const [name, test] of cases) {
  try {
    await test()
    console.log("PASS", name)
  } catch (error) {
    failures += 1
    console.error("FAIL", name)
    console.error(error)
  }
}

if (failures > 0) process.exitCode = 1
