export const meta = {
  name: "compose",
  description:
    "Autonomous Compose delivery pipeline for CmbCowork — brainstorms context, designs (spec/plan), implements per task with TDD, verifies, reviews, reports, and merges. Bounded retry, never-ask mode.",
  whenToUse:
    "Use to drive a feature, bugfix, refactor, or review-feedback task through the full Compose flow without user prompting. Pass args.task = the user's request. Optional args: type, feature_name, skip_brainstorm, skip_report. maxConcurrent and isolate_worktrees remain accepted for source compatibility, but CmbCowork shared-workspace writers run sequentially.",
  phases: [
    { title: "Brainstorm", detail: "Context recon (never-ask): conventions, recent changes, relevant files" },
    { title: "Design", detail: "Apply compose:plan, compose:debug, or compose:feedback; emit task list with deps" },
    { title: "Implement", detail: "Topo-sorted batches; fresh per-task TDD agents serialized in the shared workspace" },
    { title: "Verify", detail: "Run project verify commands; structured pass/fail" },
    { title: "Review", detail: "compose:review for critical/important/minor issues" },
    { title: "Report", detail: "compose:report per-iteration + final consolidated report" },
    { title: "Merge", detail: "compose:merge to commit (and optionally push/PR)" },
  ],
}

const MAX_TDD_ATTEMPTS = 3
const MAX_REVIEW_FIX_ATTEMPTS = 2

const BRAINSTORM_SHAPE = {
  type: "object",
  required: ["context"],
  properties: {
    context: {
      type: "object",
      required: ["projectType", "conventions", "recentChanges", "relevantFiles", "baseSha", "initialStatus"],
      properties: {
        projectType: { type: "string" },
        conventions: { type: "array", items: { type: "string" } },
        recentChanges: { type: "array", items: { type: "string" } },
        relevantFiles: { type: "array", items: { type: "string" } },
        baseSha: { type: "string" },
        initialStatus: { type: "array", items: { type: "string" } },
      },
    },
    assumptions: { type: "array", items: { type: "string" } },
    selfQA: { type: "array", items: { type: "object", properties: { question: { type: "string" }, answer: { type: "string" } } } },
    approaches: { type: "array", items: { type: "object", properties: { name: { type: "string" }, tradeoffs: { type: "string" } } } },
    chosenApproach: { type: "string" },
    chosenRationale: { type: "string" },
    openQuestions: { type: "array", items: { type: "string" } },
    amends: { type: "string" },
    existingDocs: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
}

const DESIGN_SHAPE = {
  type: "object",
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "description", "acceptance"],
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          acceptance: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "string" } },
        },
      },
    },
    notes: { type: "string" },
  },
}

const VERIFY_SHAPE = {
  type: "object",
  required: ["typecheck", "tests", "build", "allPassed"],
  properties: {
    typecheck: { enum: ["ok", "fail", "skipped"] },
    tests: {
      type: "object",
      required: ["passed", "failed"],
      properties: {
        passed: { type: "number" },
        failed: { type: "number" },
        output: { type: "string" },
      },
    },
    build: { enum: ["ok", "fail", "skipped"] },
    allPassed: { type: "boolean" },
    failures: { type: "string" },
  },
}

const REVIEW_SHAPE = {
  type: "object",
  required: ["critical", "important", "minor", "readyToMerge"],
  properties: {
    critical: { type: "array", items: { type: "string" } },
    important: { type: "array", items: { type: "string" } },
    minor: { type: "array", items: { type: "string" } },
    readyToMerge: { type: "boolean" },
  },
}

const MERGE_SHAPE = {
  type: "object",
  required: ["committed", "action"],
  properties: {
    committed: { type: "boolean" },
    sha: { type: "string" },
    prUrl: { type: "string" },
    action: { enum: ["commit", "commit+push", "commit+pr", "none"] },
  },
}

// Accept args as either an object {task,type?,...} OR a JSON string OR a bare task
// string, because the AI-SDK tool boundary often serializes nested args as strings.
let _argsObj
if (typeof args === "object" && args !== null) {
  _argsObj = args
} else if (typeof args === "string") {
  try { _argsObj = JSON.parse(args) } catch (_) { _argsObj = { task: args } }
  if (typeof _argsObj !== "object" || _argsObj === null) _argsObj = { task: args }
} else {
  _argsObj = {}
}
const TASK = typeof _argsObj.task === "string" ? _argsObj.task : ""
if (!TASK) {
  return { error: "no-task", message: "Pass args.task = '<request>'." }
}

const VALID_TYPES = ["feature", "bugfix", "refactor", "feedback"]
const argType = typeof _argsObj.type === "string" ? _argsObj.type : ""
const SKIP_BRAINSTORM = _argsObj.skip_brainstorm === true
const SKIP_REPORT = _argsObj.skip_report === true
if (_argsObj.isolate_worktrees === true) {
  log("CmbCowork does not provide per-agent worktree isolation; isolate_worktrees=true is downgraded to sequential shared-workspace writes.")
}
if (typeof _argsObj.maxConcurrent === "number" && _argsObj.maxConcurrent > 1) {
  log("maxConcurrent is accepted for source compatibility; shared-workspace writers remain sequential.")
}

// Docs dir injected by the host (workflow.ts) from ConfigCompose.resolveDocsDir,
// mirroring the <compose_docs_dir> block prompt.ts gives the interactive compose
// agent. Default keeps the workflow self-sufficient if the host didn't inject.
const DOCS_DIR = typeof _argsObj._composeDocsDir === "string" && _argsObj._composeDocsDir ? _argsObj._composeDocsDir : "docs/compose"
const SPECS_DIR = DOCS_DIR + "/specs"
const PLANS_DIR = DOCS_DIR + "/plans"
const REPORTS_DIR = DOCS_DIR + "/reports"
const docsBlock =
  "<compose_docs_dir>\n" +
  "Save compose skill outputs: specs in `" + SPECS_DIR + "`, plans in `" + PLANS_DIR + "`, reports in `" + REPORTS_DIR + "`.\n" +
  "</compose_docs_dir>"

// Slug for the per-run report filename. feature_name overrides; else slugify task.
// Strip trailing dashes AFTER the length cap too, so a 60-char cut that lands on a
// separator doesn't leave an ugly trailing "-" in the filename.
const FEATURE_NAME =
  ((typeof _argsObj.feature_name === "string" && _argsObj.feature_name ? _argsObj.feature_name : TASK)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "")) || "compose-run"
const REPORT_PATH = REPORTS_DIR + "/" + FEATURE_NAME + ".md"
const RUNTIME_DIR = ".cmbdevclaw/compose-delivery/" + FEATURE_NAME
const REQUEST_PATH = RUNTIME_DIR + "/request.md"
const INITIAL_STATUS_PATH = RUNTIME_DIR + "/initial-status.txt"
const REVIEW_PACKAGE_PATH = RUNTIME_DIR + "/review-package.diff"
const REVIEW_PACKAGE_SCRIPT_PATH = RUNTIME_DIR + "/build-review-package.sh"

// ---------------------------------------------------------------------------
// Phase 0 — Brainstorm (autonomous-mode contract: context recon only, never-ask)
// ---------------------------------------------------------------------------
phase("Brainstorm")
const SYNTHETIC_CONTEXT = {
  projectType: "unknown",
  conventions: [],
  recentChanges: [],
  relevantFiles: [],
  baseSha: "",
  initialStatus: [],
}
// Surface any prior compose artifacts so brainstorm can detect an AMENDMENT (a
// change to an existing feature) vs new work — enabling incremental re-runs that
// reuse the existing spec/plan instead of regenerating everything. The workflow
// only lists the files; the agent reads + judges.
const _globArr = async (pat) => { const r = await glob(pat); return Array.isArray(r) ? r : [] }
const existingDocs = [
  ...(await _globArr(SPECS_DIR + "/*.md")),
  ...(await _globArr(PLANS_DIR + "/*.md")),
  ...(await _globArr(REPORTS_DIR + "/*.md")),
]
const existingDocsBlock = existingDocs.length
  ? "\n## Existing compose artifacts (this project has prior compose work)\n" +
    existingDocs.map((p) => "- " + p).join("\n") + "\n" +
    "If the task below is a CHANGE/ADDITION to a feature documented above, READ the relevant spec/plan with `read_file` " +
    "and treat this as an AMENDMENT: set `amends` to that feature's name and list the docs you used in `existingDocs`. " +
    "If the task is unrelated/new, leave `amends` empty.\n"
  : ""
let brainstorm
if (SKIP_BRAINSTORM) {
  brainstorm = { context: SYNTHETIC_CONTEXT, assumptions: [] }
} else {
  brainstorm = await agent(
    "Apply the `compose:brainstorm` skill in AUTONOMOUS mode — no user is available to answer. Find its exact SKILL.md path in Available Skills and use `read_file` to read it completely before working.\n\n" +
    "## Autonomous brainstorming — self-conduct the dialogue (do NOT stop at context recon)\n" +
    "'No user' means you ask and answer the questions YOURSELF; it does NOT mean skip the thinking. Run the real brainstorm:\n" +
    "1. Explore project context (files, docs, recent commits, layout) and note assumptions.\n" +
    "2. Pose the clarifying questions you WOULD ask a user, and answer each from the context/your best judgment (record as selfQA).\n" +
    "3. Propose 2-3 distinct approaches with trade-offs (record as approaches).\n" +
    "4. Pick ONE and justify it (chosenApproach + chosenRationale). Note any unresolved openQuestions.\n" +
    "Do NOT present a design to a user, wait for approval, write a spec, invoke another Compose skill, or implement code here — Design is the next workflow phase. " +
    "This reasoning is the KEY input Design consumes, so capture it fully in the structured output.\n\n" +
    "## Task\n" + TASK + "\n\n" +
    existingDocsBlock +
    "## Context to gather\n" +
    "- Read AGENTS.md / CLAUDE.md / README.md if present\n" +
    "- Run `git rev-parse HEAD` and record it as context.baseSha; run `git status --short --untracked-files=all` and record its lines as context.initialStatus\n" +
    "- Skim recent commits (`git log --oneline -20`)\n" +
    "- Map top-level directory layout; identify files relevant to the task\n\n" +
    "Return structured output only.",
    { label: "brainstorm", phase: "Brainstorm", schema: BRAINSTORM_SHAPE }
  )
  if (!brainstorm || !brainstorm.context) brainstorm = { context: SYNTHETIC_CONTEXT, assumptions: [] }
}
const _arr = (v) => (Array.isArray(v) ? v : [])
const contextDigest =
  "Project: " + brainstorm.context.projectType + "\n" +
  "Conventions:\n" + _arr(brainstorm.context.conventions).map((c) => "- " + c).join("\n") + "\n" +
  "Recent changes:\n" + _arr(brainstorm.context.recentChanges).map((c) => "- " + c).join("\n") + "\n" +
  "Relevant files:\n" + _arr(brainstorm.context.relevantFiles).map((f) => "- " + f).join("\n") +
  ((brainstorm.context.baseSha && typeof brainstorm.context.baseSha === "string") ? "\nRun base SHA: " + brainstorm.context.baseSha : "") +
  (_arr(brainstorm.context.initialStatus).length ? "\nInitial workspace status:\n" + _arr(brainstorm.context.initialStatus).map((s) => "- " + s).join("\n") : "") +
  (_arr(brainstorm.assumptions).length ? "\nAssumptions:\n" + _arr(brainstorm.assumptions).map((a) => "- " + a).join("\n") : "") +
  (_arr(brainstorm.selfQA).length ? "\nSelf-Q&A (brainstorm reasoning):\n" + _arr(brainstorm.selfQA).map((q) => "- Q: " + (q && q.question) + "\n  A: " + (q && q.answer)).join("\n") : "") +
  (_arr(brainstorm.approaches).length ? "\nApproaches considered:\n" + _arr(brainstorm.approaches).map((a) => "- " + (a && a.name) + " — " + (a && a.tradeoffs)).join("\n") : "") +
  ((brainstorm.chosenApproach && typeof brainstorm.chosenApproach === "string") ? "\nChosen approach: " + brainstorm.chosenApproach + (brainstorm.chosenRationale ? " (because: " + brainstorm.chosenRationale + ")" : "") : "") +
  (_arr(brainstorm.openQuestions).length ? "\nOpen questions:\n" + _arr(brainstorm.openQuestions).map((q) => "- " + q).join("\n") : "") +
  ((brainstorm.amends && typeof brainstorm.amends === "string") ? "\nAmends existing feature: " + brainstorm.amends : "")
const RUN_BASE_SHA =
  brainstorm.context && typeof brainstorm.context.baseSha === "string"
    ? brainstorm.context.baseSha.trim()
    : ""
const SAFE_RUN_BASE_SHA = /^[0-9a-f]{7,64}$/i.test(RUN_BASE_SHA) ? RUN_BASE_SHA : ""

// CmbCowork writers share one branch, so intermediate agents leave changes
// uncommitted. Persist the request and a review-package builder outside delivery
// paths so the final reviewer can inspect committed, tracked, and new files once.
await writeFile(REQUEST_PATH, TASK + "\n")
await writeFile(
  INITIAL_STATUS_PATH,
  _arr(brainstorm.context && brainstorm.context.initialStatus).join("\n") +
    (_arr(brainstorm.context && brainstorm.context.initialStatus).length ? "\n" : "")
)
const REVIEW_PACKAGE_SCRIPT = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  'base="${1:-}"',
  'initial_status="${2:-}"',
  'out="${3:-}"',
  'if [ -z "$out" ]; then echo "usage: build-review-package BASE INITIAL_STATUS OUT" >&2; exit 2; fi',
  'mkdir -p "$(dirname "$out")"',
  'tmp="${out}.tmp"',
  'head_sha="$(git rev-parse HEAD)"',
  'base_ok=false',
  'if [ -n "$base" ] && git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then base_ok=true; fi',
  "{",
  '  echo "# Compose Delivery review package"',
  '  echo "Base: ${base:-unavailable}"',
  '  echo "Head: ${head_sha}"',
  '  echo',
  '  echo "## Workspace status before this run"',
  '  if [ -s "$initial_status" ]; then cat "$initial_status"; else echo "(clean or unavailable)"; fi',
  '  echo',
  '  echo "## Current workspace status"',
  '  git status --short --untracked-files=all -- . ":(exclude).cmbdevclaw/**" || true',
  '  echo',
  '  echo "## Committed diff since the run base"',
  '  if [ "$base_ok" = true ]; then git diff -U10 "${base}..HEAD" -- . ":(exclude).cmbdevclaw/**"; else echo "(base unavailable)"; fi',
  '  echo',
  '  echo "## Staged diff"',
  '  git diff --cached -U10 -- . ":(exclude).cmbdevclaw/**" || true',
  '  echo',
  '  echo "## Unstaged tracked diff"',
  '  git diff -U10 -- . ":(exclude).cmbdevclaw/**" || true',
  '  echo',
  '  echo "## Untracked files (complete text for review)"',
  '  git ls-files --others --exclude-standard -z -- . ":(exclude).cmbdevclaw/**" | while IFS= read -r -d "" file; do',
  '    echo "--- /dev/null"',
  '    echo "+++ b/${file}"',
  '    if [ ! -s "$file" ]; then',
  '      echo "(empty file)"',
  '    elif LC_ALL=C grep -Iq . "$file"; then',
  '      sed "s/^/+/" "$file"',
  '    else',
  '      echo "(binary file omitted)"',
  "    fi",
  "  done",
  '} > "$tmp"',
  'mv "$tmp" "$out"',
  'echo "wrote $out"',
  "",
].join("\n")
await writeFile(REVIEW_PACKAGE_SCRIPT_PATH, REVIEW_PACKAGE_SCRIPT)

// ---------------------------------------------------------------------------
// Type resolution (no separate Classify phase)
// ---------------------------------------------------------------------------
// First-principles: picking the design skill is a low-risk, reversible routing
// decision the later Design/Implement phases can self-correct — it does NOT
// warrant its own LLM phase (the original compose flow has no classifier; it goes
// brainstorm → compose:plan). So: honor an explicit args.type; otherwise default
// to "feature" (→ compose:plan) and let a cheap keyword heuristic divert obvious
// bugfix / PR-feedback tasks. The design agent re-judges with full context anyway.
let type
if (VALID_TYPES.indexOf(argType) >= 0) {
  type = argType
} else {
  const t = TASK.toLowerCase()
  if (/\b(pr|review)\b.*\b(feedback|comment|address)\b|address .*\bfeedback\b/.test(t)) type = "feedback"
  else if (/\b(bug|broken|regression|crash|fails?|incorrect|wrong|error)\b/.test(t)) type = "bugfix"
  else type = "feature"
  log("Task type: " + type)
}

const SKILL_BY_TYPE = {
  feature: "compose:plan",
  refactor: "compose:plan",
  bugfix: "compose:debug",
  feedback: "compose:feedback",
}

// ---------------------------------------------------------------------------
// Phase 2 — Design (spec/plan, context-grounded, dependency-aware)
// ---------------------------------------------------------------------------
phase("Design")
const designSkill = SKILL_BY_TYPE[type] || "compose:plan"
const SPEC_PATH = SPECS_DIR + "/" + FEATURE_NAME + ".md"
const PLAN_PATH = PLANS_DIR + "/" + FEATURE_NAME + ".md"
// Amendment: brainstorm flagged this as a change to an existing feature. Design
// edits the existing spec/plan in place and re-runs only the affected tasks,
// instead of regenerating everything.
const AMENDS = brainstorm && typeof brainstorm.amends === "string" ? brainstorm.amends.trim() : ""

// Step 1 — the AGENT writes (or amends) the spec + plan files. The workflow does
// NOT write them; it only gates on existence and re-dispatches if skipped. No
// `schema` here so the agent is free to use its file and skill instructions.
const runDesignWrite = (sharpen) => agent(
  "Apply the `" + designSkill + "` skill to the task below. Find its exact SKILL.md path in Available Skills and use `read_file` to read it completely before working, then follow it.\n\n" +
  "## CmbCowork workflow boundary\n" +
  "This is the Design phase only. Write or amend the Spec and Plan, then stop. Do not implement code, run another Compose phase, stage, commit, push, or change branches.\n\n" +
  docsBlock + "\n\n" +
  "## Task\n" + TASK + "\n\n" +
  "## Project context (from brainstorm)\n" + contextDigest + "\n\n" +
  (AMENDS
    ? "## This is an AMENDMENT to an existing feature: " + AMENDS + "\n" +
      "Use `glob`/`read_file` to find that feature's existing spec under `" + SPECS_DIR + "` and plan under `" + PLANS_DIR + "`. " +
      "EDIT them IN PLACE with `edit_file` or `write_file` to reflect ONLY the change in the task above — do NOT rewrite from scratch. " +
      "In the plan, the task list must then contain ONLY the tasks that need to be (re-)implemented for this change, PLUS any tasks that " +
      "depend on them. Tasks unaffected by the change MUST be omitted from the actionable list — they are reused as-is.\n\n" +
      "## Scope the work to the actual change (CRITICAL)\n" +
      "First assess the MAGNITUDE of this change: small (one spot / a few lines), medium (a few related tasks), " +
      "or large (a foundational refactor touching many modules). Make the plan's actionable task list MATCH that magnitude:\n" +
      "- Small change → ONE task (or zero, if the code already satisfies it). Do NOT split one small change into multiple tasks.\n" +
      "- Medium → only the genuinely distinct tasks the change requires, plus their dependents.\n" +
      "- Large refactor → re-decompose into as many independent tasks as the work truly needs.\n" +
      "NEVER emit two near-identical or duplicate tasks for the same change. One distinct unit of work = exactly one task. " +
      "The number of tasks must reflect the real scope — it is not fixed.\n\n" +
      "Write the updated files with `edit_file` or `write_file`. Do not just describe them.\n"
    : "## Your deliverable (REQUIRED — this is the whole job)\n" +
      "Use `write_file` to create BOTH of these files on disk:\n" +
      "1. Spec: `" + SPEC_PATH + "`\n" +
      "2. Plan: `" + PLAN_PATH + "` — a bite-sized task list per the skill, each task with id, description, acceptance, optional files, and `dependsOn` (empty for independent tasks; a prerequisite task id otherwise; no cycles).\n\n" +
      (sharpen ? "## You did NOT write the required files last time. Write them NOW with `write_file` before finishing.\n\n" : "") +
      "Do the writes with `write_file`. Do not just describe them."),
  { label: "design:" + type, phase: "Design" }
)
await runDesignWrite(false)
// Gate: the agent owns the writes; the workflow only verifies they happened and
// re-dispatches the agent once if not. The workflow itself never writes the files.
// Robustness: the agent may write under a slightly different leaf name than our
// computed slug (model-chosen filename, trailing-dash drift, etc.). So treat the
// gate as "did ANY .md land in the specs and plans dirs", not an exact-path match —
// this avoids a redundant, expensive re-dispatch when the files are actually there.
const docsPresent = async () => {
  const specs = await glob(SPECS_DIR + "/*.md")
  const plans = await glob(PLANS_DIR + "/*.md")
  return specs.length > 0 && plans.length > 0
}
if (!(await docsPresent())) {
  await runDesignWrite(true)
}
const specWritten = (await glob(SPECS_DIR + "/*.md")).length > 0
const planWritten = (await glob(PLANS_DIR + "/*.md")).length > 0

// Step 2 — structured extraction: a separate agent reads the plan the previous
// agent wrote and returns the machine-usable task list. Schema lives here, where
// JSON-only is exactly what we want — no file work expected in this call. The
// prompt forces a direct structured_output tool call: the model otherwise tends to
// answer with prose/markdown/XML, which fails schema validation and triggers a
// slow retry loop (each round-trip is a full model call).
const design = await agent(
  "Read the implementation plan markdown in `" + PLANS_DIR + "` with `read_file` (if multiple files, read the most recent) and extract its task list.\n\n" +
  (planWritten ? "" : "## No plan file found — derive the task list from the task below instead.\n## Task\n" + TASK + "\n\n") +
  (AMENDS ? "## Amendment\nThis run amends the existing feature \"" + AMENDS + "\". Return the SMALLEST set of tasks that covers the actual change (plus their dependents). One distinct unit of work = exactly one task — do NOT return duplicate or near-identical tasks, and do NOT split a single small change across multiple tasks. OMIT every task unaffected by this change — they are reused as-is.\n\n" : "") +
  "## Output contract (STRICT)\n" +
  "Call the `structured_output` tool EXACTLY ONCE with a JSON object matching the schema. " +
  "Do NOT reply with prose, markdown, XML, or a code block — those do not count and will be rejected. " +
  "The JSON has a `tasks` array; each task: id, description, acceptance, optional files[], and dependsOn[] " +
  "(empty for independent tasks; a prerequisite task id otherwise; no cycles).",
  { label: "design-extract:" + type, phase: "Design", schema: DESIGN_SHAPE }
)
if (!design || !Array.isArray(design.tasks) || design.tasks.length === 0) {
  return { error: "design-failed", type, brainstorm, docs: { specWritten, planWritten } }
}
// Normalize task ids: the extract agent sometimes returns tasks with a missing or
// blank `id` (schema validation can let an empty string through), which then shows
// up as "implement:undefined" in labels and breaks dependsOn wiring. Backfill any
// missing/duplicate id with a synthetic Tn so labels, topo-sort, and deps are stable.
{
  const seen = Object.create(null)
  let n = 0
  for (const t of design.tasks) {
    n++
    const raw = typeof t.id === "string" ? t.id.trim() : ""
    t.id = raw && !seen[raw] ? raw : "T" + n
    seen[t.id] = true
  }
}
log("Designed " + design.tasks.length + " task(s) using " + designSkill + " (spec=" + specWritten + " plan=" + planWritten + ")")

// Topo-sort (Kahn) over design.tasks by dependsOn → ordered batches.
const topoSort = (tasks) => {
  const byId = Object.create(null)
  for (const t of tasks) byId[t.id] = t
  const indeg = Object.create(null)
  const deps = Object.create(null)
  for (const t of tasks) {
    deps[t.id] = (t.dependsOn || []).filter((d) => byId[d])
    indeg[t.id] = deps[t.id].length
  }
  const batches = []
  let remaining = tasks.map((t) => t.id)
  while (remaining.length) {
    const ready = remaining.filter((id) => indeg[id] === 0)
    if (!ready.length) return { error: "design-cycle", cycleNodes: remaining }
    batches.push(ready)
    const readySet = Object.create(null)
    for (const id of ready) readySet[id] = true
    remaining = remaining.filter((id) => !readySet[id])
    for (const id of remaining) {
      indeg[id] = deps[id].filter((d) => !readySet[d] && remaining.indexOf(d) >= 0).length
    }
  }
  return { batches }
}
const topo = topoSort(design.tasks)
if (topo.error) {
  return { error: "design-cycle", cycleNodes: topo.cycleNodes, type, brainstorm, design }
}
const batches = topo.batches
const taskById = Object.create(null)
for (const t of design.tasks) taskById[t.id] = t

// Intent carried from brainstorm/design into each implementer so it builds toward
// the CHOSEN approach, not its own re-derivation. Plan path lets it read the spec.
const intentBlock =
  ((brainstorm.chosenApproach && typeof brainstorm.chosenApproach === "string")
    ? "## Intent (from design — build toward THIS approach)\n" + brainstorm.chosenApproach +
      (brainstorm.chosenRationale ? "\nRationale: " + brainstorm.chosenRationale : "") + "\n" +
      "Spec/plan for the whole feature: `" + SPEC_PATH + "` / `" + PLAN_PATH + "` (read if you need fuller context).\n\n"
    : "")

// ---------------------------------------------------------------------------
// Helpers: implement, verify, debug, report
// ---------------------------------------------------------------------------
const runImplementTask = (task, failuresOrEmpty) => agent(
  "Apply the `compose:tdd` skill. Find its exact SKILL.md path in Available Skills and use `read_file` to read it completely before working.\n\n" +
  "## Overall task\n" + TASK + "\n\n" +
  intentBlock +
  "## Your work item (" + task.id + ")\n" + task.description + "\nAcceptance: " + task.acceptance +
  (task.files && task.files.length ? "\nFiles: " + task.files.join(", ") : "") + "\n\n" +
  (failuresOrEmpty ? "## Verify failures from previous attempt — focus on these\n" + failuresOrEmpty + "\n\n" : "") +
  "Write the failing test first with `write_file` or `edit_file`, then the minimal code to pass, then refactor. " +
  "Actually create or edit the source and test files on disk — do not just describe them. " +
  "Do not run `git add`, `git commit`, `git push`, change branches, or modify `.cmbdevclaw`; the final Merge phase owns the single delivery commit.",
  { label: "implement:" + task.id, phase: "Implement" }
)

const runVerify = () => agent(
  "Apply the `compose:verify` skill. Find its exact SKILL.md path in Available Skills and use `read_file` to read it completely before working, then follow its discipline " +
  "(the Iron Law: no completion claim without fresh verification evidence — run the real commands, read the full output, " +
  "never trust 'should pass' or an agent's self-report).\n\n" +
  "## Run the project's verification commands and report the outcome\n" +
  "1. First run `pwd` and `ls` to confirm your working directory and that the project's source/test files are actually present here. The implemented code lives in THIS workspace — verify from the workspace root (or the package subdir AGENTS.md specifies), never from a stale or temp cwd.\n" +
  "2. Inspect AGENTS.md / CLAUDE.md / package.json for the project's verify commands (typecheck, test, build).\n" +
  "3. Run them with `execute` from the correct directory. If a command reports 'file not found' or 0 tests, set the correct cwd and re-run before reporting.\n" +
  "4. Capture passed/failed test counts from the ACTUAL command output. Summarize failures concisely if any.\n\n" +
  "Return structured output only — and it must reflect the real command output, not an assumption.",
  { label: "verify", phase: "Verify", schema: VERIFY_SHAPE }
)

const runDebug = (failures) => agent(
  "Apply the `compose:debug` skill. Find its exact SKILL.md path in Available Skills and use `read_file` to read it completely before working.\n\n" +
  "## Verify failures\n" + failures + "\n\n" +
  "Identify the root cause and fix it. Do not paper over symptoms. Do not run `git add`, `git commit`, `git push`, change branches, or modify `.cmbdevclaw`; the final Merge phase owns the single delivery commit.",
  { label: "debug", phase: "Implement" }
)

const runIterationReport = async (iteration, verifyResult) => {
  if (SKIP_REPORT) return null
  // The agent writes the markdown report file. No schema — a schema would bias the
  // agent into emitting JSON instead of doing the write. The workflow only verifies
  // the file exists afterward.
  await agent(
    "Apply the `compose:report` skill in per-iteration mode. Find its exact SKILL.md path in Available Skills and use `read_file` to read it completely before working.\n\n" +
    "Update the report only. Do not stage, commit, push, open a PR, change branches, invoke another Compose phase, or modify `.cmbdevclaw`.\n\n" +
    docsBlock + "\n\n" +
    "## Report file you MUST write (overwrite-in-place, accumulate Journey Log)\n" + REPORT_PATH + "\n\n" +
    "## Iteration\n" + iteration + "\n\n" +
    "## Overall task\n" + TASK + "\n\n" +
    "## Verify result\n" + JSON.stringify(verifyResult) + "\n\n" +
    "Read the existing report if present with `read_file`, update sections, append a Journey Log entry for this iteration, " +
    "and write the file with `write_file` or `edit_file`. Keep it brief. Writing the file is the deliverable — do not just describe it.",
    { label: "iteration-report:" + iteration, phase: "Report" }
  )
  return { iteration, written: await exists(REPORT_PATH) }
}

// Preserve the source workflow's dependency batches while serializing writers in CmbCowork's
// shared workspace. The empty integrate result keeps the source result shape.
const runBatch = async (batchIds, failuresOrEmpty) => {
  const tasks = batchIds.map((id) => taskById[id])
  const perTaskResults = []
  for (const task of tasks) {
    const result = await runImplementTask(task, failuresOrEmpty)
    perTaskResults.push({ taskId: task.id, status: result === null ? "failed" : "ok" })
  }
  return {
    perTaskResults,
    integrate: {
      merged: [],
      conflicts: [],
      skipped_pristine: perTaskResults.filter((result) => result.status !== "ok").map((result) => result.taskId),
    },
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — Implement (TDD outer loop, ≤3 attempts)
// ---------------------------------------------------------------------------
phase("Implement")
const verifyHistory = []
const implementHistory = []
let verify = null
let tddAttempts = 0
for (let attempt = 0; attempt < MAX_TDD_ATTEMPTS; attempt++) {
  tddAttempts = attempt + 1
  const failures = attempt === 0 ? "" : (verify && verify.failures ? verify.failures : "")
  const perTaskResults = []
  const integrateHistory = []
  for (const batchIds of batches) {
    const batchOut = await runBatch(batchIds, failures)
    for (const r of batchOut.perTaskResults) perTaskResults.push(r)
    integrateHistory.push(batchOut.integrate)
  }

  phase("Verify")
  verify = await runVerify()
  if (verify) verifyHistory.push(verify)
  const failedTasks = perTaskResults.filter((result) => result.status === "failed")
  const taskFailureText = failedTasks.length ? "\nImplementation agents failed: " + JSON.stringify(failedTasks) : ""
  const passed = verify && verify.allPassed && failedTasks.length === 0

  implementHistory.push({
    attempt: tddAttempts,
    perTaskResults,
    integrate: { batches: integrateHistory },
    verify: verify || null,
  })

  if (passed) {
    log("Verify passed on attempt " + tddAttempts)
    phase("Report")
    await runIterationReport(tddAttempts, verify)
    break
  }
  if (attempt + 1 === MAX_TDD_ATTEMPTS) {
    return { error: "verify-exhausted", type, brainstorm, design, batches, verifyHistory, implementHistory, attempts: MAX_TDD_ATTEMPTS }
  }
  phase("Implement")
  await runDebug((verify ? (verify.failures || "verify returned no detail") : "verify agent failed (null)") + taskFailureText)
}

// ---------------------------------------------------------------------------
// Phase 4 — Review  +  Phase 5 — Fix loop (≤2 attempts)
// ---------------------------------------------------------------------------
const IMPLEMENTED_DIGEST = design.tasks.map((t) => "- " + t.id + ": " + t.description + " (acceptance: " + t.acceptance + ")").join("\n")
const REVIEW_PACKAGE_COMMAND =
  'bash "' + REVIEW_PACKAGE_SCRIPT_PATH + '" "' + SAFE_RUN_BASE_SHA + '" "' +
  INITIAL_STATUS_PATH + '" "' + REVIEW_PACKAGE_PATH + '"'
const runReview = (verifyEvidence) => agent(
  "Apply the `compose:review` skill. Find its exact SKILL.md path in Available Skills and use `read_file` to read it completely before working, then apply its review criteria.\n\n" +
  "You are already the dedicated reviewer. Review directly; do not dispatch another subagent. Review is read-only: do not edit project files, stage, commit, push, or change branches. " +
  "The only permitted write is generating the review package under `.cmbdevclaw`.\n\n" +
  "Run this command exactly once with `execute`:\n`" + REVIEW_PACKAGE_COMMAND + "`\n" +
  "Then read `" + REVIEW_PACKAGE_PATH + "` once. It contains committed, staged, unstaged, and complete untracked-file content while excluding `.cmbdevclaw`. " +
  "Read the original request from `" + REQUEST_PATH + "`. Do not repeat Git discovery or crawl unrelated files.\n\n" +
  "Review the implemented change in TWO STAGES, spec-compliance BEFORE code-quality (this mirrors compose:subagent's two-stage gate):\n" +
  "### Stage 1 — Spec compliance (evidence-gated)\n" +
  "Check the original request, Spec, Plan, and every acceptance criterion against the package and the fresh verification evidence below. " +
  "Anything unmet or unverifiable is a CRITICAL finding. Passing tests do not replace requirement compliance. Do not assume implementation or report claims are correct.\n\n" +
  "## Fresh verification evidence\n" + JSON.stringify(verifyEvidence || null) + "\n\n" +
  "### Stage 2 — Code quality\n" +
  "Only once spec compliance holds, review the package for quality: correctness, security and authentication boundaries, secret handling, task-relevant concurrency, missing error handling at real boundaries, tests that do not test behavior, dead code, and simplification.\n\n" +
  intentBlock +
  "## What was implemented (acceptance criteria to verify)\n" + IMPLEMENTED_DIGEST + "\n\n" +
  "## What to produce\n" +
  "Triage findings into critical (must fix before merge — includes ANY unmet spec/acceptance), important (should fix), and minor (nits). " +
  "Set readyToMerge=true ONLY if critical is empty AND every acceptance criterion is met with evidence.\n\n" +
  "Return structured output only.",
  { label: "review", phase: "Review", schema: REVIEW_SHAPE }
)

const runFixTask = (finding, i) => agent(
  "Address the CRITICAL review finding below. Apply the `compose:tdd` skill to fix it with tests where possible. " +
  "Find its exact SKILL.md path in Available Skills and use `read_file` to read it completely before working.\n\n" +
  "## Critical finding (" + (i + 1) + ")\n" + finding + "\n\n" +
  "Fix it with `write_file`/`edit_file` and run focused tests where possible. Do not stage, commit, push, change branches, or modify `.cmbdevclaw`; the final Merge phase owns the single delivery commit.",
  { label: "fix:" + i, phase: "Fix" }
)

phase("Review")
let review = await runReview(verify)
if (!review) {
  return {
    error: "review-failed",
    readyToMerge: false,
    type, brainstorm, design, batches, verifyHistory, implementHistory,
    review: null,
    attempts: { tdd: tddAttempts, reviewFix: 0 },
  }
}
let reviewFixAttempts = 0
const fixHistory = []

if (review.critical && review.critical.length > 0) {
  phase("Fix")
  for (let attempt = 0; attempt < MAX_REVIEW_FIX_ATTEMPTS; attempt++) {
    reviewFixAttempts = attempt + 1
    const perTaskResults = []
    const criticals = review.critical
    for (let i = 0; i < criticals.length; i++) {
      const result = await runFixTask(criticals[i], i)
      perTaskResults.push({ taskId: "fix-" + i, status: result === null ? "failed" : "ok" })
    }
    const integrate = { merged: [], conflicts: [], skipped_pristine: [] }

    phase("Verify")
    const reverify = await runVerify()
    if (reverify) verifyHistory.push(reverify)

    phase("Review")
    review = await runReview(reverify)
    if (!review) {
      return {
        error: "review-failed",
        readyToMerge: false,
        type, brainstorm, design, batches, verifyHistory, implementHistory, fixHistory,
        review: null,
        attempts: { tdd: tddAttempts, reviewFix: reviewFixAttempts },
      }
    }

    fixHistory.push({ attempt: reviewFixAttempts, perTaskResults, integrate, verify: reverify || null, review })

    phase("Report")
    await runIterationReport(MAX_TDD_ATTEMPTS + reviewFixAttempts, reverify)

    if (!review.critical || review.critical.length === 0) {
      log("Critical issues cleared on fix attempt " + reviewFixAttempts)
      break
    }
  }
  if (review.critical && review.critical.length > 0) {
    return {
      readyToMerge: false,
      type, brainstorm, design, batches, verifyHistory, implementHistory, fixHistory, review,
      attempts: { tdd: tddAttempts, reviewFix: reviewFixAttempts },
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 6 — Final Report (consolidate; Merge owns the single commit)
// ---------------------------------------------------------------------------
let finalReport = null
if (!SKIP_REPORT) {
  phase("Report")
  // The agent writes the consolidated final report file; the workflow only gates
  // on existence. No schema — writing the markdown is the deliverable.
  await agent(
    "Apply the `compose:report` skill in FINAL consolidation mode. Find its exact SKILL.md path in Available Skills and use `read_file` to read it completely before working.\n\n" +
    "Write the final report, then stop. Do not stage, commit, push, open a PR, change branches, invoke another Compose phase, or modify `.cmbdevclaw`; Merge is the next workflow phase.\n\n" +
    docsBlock + "\n\n" +
    "## Report file you MUST write (read the in-progress per-iteration file, overwrite with canonical final state)\n" + REPORT_PATH + "\n\n" +
    "## Overall task\n" + TASK + "\n\n" +
    "## Run history\n" +
    "verifyHistory: " + JSON.stringify(verifyHistory) + "\n" +
    "implementHistory: " + JSON.stringify(implementHistory) + "\n" +
    "reviewFixAttempts: " + reviewFixAttempts + "\n" +
    "review: " + JSON.stringify(review) + "\n\n" +
    "Produce the final-state report (What Was Built / Architecture / Design Decisions / Usage / Verification / Journey Log / Source Materials). " +
    "Distill the Journey Log to at most 5 entries. Write the file with `write_file` or `edit_file`. " +
    "Writing the file is the deliverable — do not just describe it.",
    { label: "final-report", phase: "Report" }
  )
  // Re-dispatch once if the agent skipped the write.
  if (!(await exists(REPORT_PATH))) {
    await agent(
      "The final report file `" + REPORT_PATH + "` does not exist yet. Apply `compose:report`: find its exact SKILL.md path in Available Skills and read it completely, then WRITE it now with `write_file` " +
      "(What Was Built / Architecture / Design Decisions / Usage / Verification / Journey Log / Source Materials) for the task: " + TASK,
      { label: "final-report-retry", phase: "Report" }
    )
  }
  finalReport = { path: REPORT_PATH, written: await exists(REPORT_PATH) }
}

// ---------------------------------------------------------------------------
// Phase 7 — Merge
// ---------------------------------------------------------------------------
phase("Merge")
const merge = await agent(
  "Apply the `compose:merge` skill. Find its exact SKILL.md path in Available Skills and use `read_file` to read it completely before working.\n\n" +
  "This CmbCowork workflow used the current shared workspace, not feature worktrees. Keep the current branch checked out; do not pull, locally merge branches, create/remove worktrees, or delete branches. " +
  "Implement, Debug, Fix, and Report intentionally left their changes uncommitted, so this phase owns the single delivery commit. " +
  "Read `" + INITIAL_STATUS_PATH + "` and compare it with `git status --short --untracked-files=all`. Preserve every pre-existing user change. " +
  "Stage only explicit source, test, Spec, Plan, and Report paths owned by this task; never use `git add -A` or `git add .`, and never stage `.cmbdevclaw/**`. " +
  "If an interrupted/resumed run already created the exact run-owned commit, do not create a duplicate; report it as committed.\n\n" +
  "## Task\n" + TASK + "\n\n" +
  "## What was built (use this for the commit/PR message)\n" + IMPLEMENTED_DIGEST + "\n\n" +
  ((review && (_arr(review.important).length || _arr(review.minor).length))
    ? "## Review outcome (critical cleared; note any deferred items)\n" +
      (_arr(review.important).length ? "Important (should follow up):\n" + _arr(review.important).map((x) => "- " + x).join("\n") + "\n" : "") +
      (_arr(review.minor).length ? "Minor (nits):\n" + _arr(review.minor).map((x) => "- " + x).join("\n") + "\n" : "") + "\n"
    : "") +
  "Commit the changes. If the branch tracks a remote and a PR is appropriate, push and open one.\n" +
  "Pick the smallest action that satisfies the goal:\n" +
  "- `commit`: just record locally\n" +
  "- `commit+push`: also push to the existing remote branch\n" +
  "- `commit+pr`: push and open a PR\n\n" +
  "Return the final commit SHA when available. Return structured output only.",
  { label: "merge", phase: "Merge", schema: MERGE_SHAPE }
)
if (!merge || !merge.committed) {
  return {
    error: "merge-failed",
    type, brainstorm, design, batches, verifyHistory, implementHistory, review, finalReport,
    merge: merge || { committed: false, action: "none" },
    attempts: { tdd: tddAttempts, reviewFix: reviewFixAttempts },
  }
}

return {
  brainstorm,
  type,
  design,
  batches,
  implementHistory,
  verifyHistory,
  review,
  fixHistory: fixHistory.length ? fixHistory : undefined,
  reviewFixes: reviewFixAttempts,
  finalReport,
  merge,
  stats: {
    agents: verifyHistory.length + tddAttempts + reviewFixAttempts + 4, // brainstorm + design-write + design-extract + review + merge (approx)
    phases: 7,
    parallelBatches: batches.length,
    durationMs: 0, // QuickJS guest has no Date; host can compute from journal if needed
  },
}
