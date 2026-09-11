---
name: compose-delivery
description: Use when the user wants an autonomous end-to-end delivery pipeline for a feature, bugfix, refactor, or review-feedback task through CmbCowork Dynamic Workflow, including exploration, design, per-task TDD, verification, review/fix, report, and merge.
---

# Compose Delivery

This is the launcher skill for the Compose Delivery plugin. It keeps the workflow stages, retry limits, artifacts, autonomous behavior, TDD discipline, review gates, reporting, and merge behavior in one installable CmbCowork package.

## Plugin contents

Install or enable the whole plugin directory:

- `workflow/compose-delivery.workflow.js` — the single workflow source.
- `skills/*/SKILL.md` — the `compose:*` phase skills.
- license and third-party notice files required for redistribution.

CmbCowork must discover the nested `compose:brainstorm`, `compose:plan`, `compose:debug`, `compose:feedback`, `compose:tdd`, `compose:verify`, `compose:review`, `compose:report`, and `compose:merge` skills. If the bundle was just installed or enabled, start a new session if the current runtime has a stale skill catalogue.

## Run

### 1. Copy the workflow into the current workspace

CmbCowork resolves `scriptPath` inside the current workspace, while an installed plugin normally lives outside it. For every new run, copy the bundled workflow without reading, rewriting, or regenerating its contents:

Target:

```text
<workspace>/.cmbdevclaw/workflows/compose-delivery.workflow.js
```

Run the platform-appropriate copy command with `execute.cwd` set to the directory containing this `SKILL.md`.

macOS/Linux:

```bash
mkdir -p "<workspace>/.cmbdevclaw/workflows"
cp "workflow/compose-delivery.workflow.js" "<workspace>/.cmbdevclaw/workflows/compose-delivery.workflow.js"
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "<workspace>/.cmbdevclaw/workflows"
Copy-Item -Force "workflow/compose-delivery.workflow.js" "<workspace>/.cmbdevclaw/workflows/compose-delivery.workflow.js"
```

Always overwrite the workspace copy on a new run so an installed plugin update cannot leave a stale script behind. If the copy fails, report the error and stop; do not reconstruct the JavaScript through the model.

### 2. Launch by path

Call the CmbCowork Workflow tool with:

```text
scriptPath: ".cmbdevclaw/workflows/compose-delivery.workflow.js"
args: {
  "task": "<the user's development request>",
  "type": "feature",
  "feature_name": "requested-feature"
}
```

Pass `args.task` exactly as the user supplied it. Optional arguments may be omitted. Return the workflow result when the background run completes.

Do not pass the installed plugin path as `scriptPath`, do not send the workflow as inline `script`, and do not rewrite, add phases, remove phases, substitute agent types, or manually reproduce the pipeline.

### 3. Resume an interrupted run

Resume with `resumeFromRunId` alone so CmbCowork reuses the persisted script, arguments, and completed agent journal. Do not recopy the workflow or change arguments before a resume; either change discards replay compatibility and starts fresh work.

Supported arguments:

- `task` — required development request.
- `type` — optional: `feature`, `bugfix`, `refactor`, or `feedback`.
- `feature_name` — optional report/spec/plan slug.
- `skip_brainstorm` — optional boolean.
- `skip_report` — optional boolean.
- `maxConcurrent` — accepted for source compatibility; shared-workspace writers remain sequential.
- `isolate_worktrees` — accepted for source compatibility; CmbCowork logs a safe sequential downgrade when `true`.
- `_composeDocsDir` — optional Compose artifact root, default `docs/compose`.

## Runtime behavior

The workflow is autonomous and does not pause for questions. Its final Merge phase creates one delivery commit and may push or open a pull request when the existing branch and remote state make that appropriate. CmbCowork's normal workflow approval and action controls still apply.

CmbCowork workflow subagents share one working tree and cannot spawn nested subagents. Therefore:

- write-capable task and blocking-fix agents are serialized to prevent overlapping edits;
- the dedicated Review subagent applies `compose:review` directly instead of dispatching another nested reviewer;
- the one global Review regenerates a `.cmbdevclaw` package containing committed, staged, unstaged, and untracked delivery content, then checks specification compliance and code quality in the same pass;
- Design, Implement, Debug, Fix, and Report leave changes uncommitted; Merge owns one task-scoped commit and excludes runtime artifacts and pre-existing user changes;
- Design and Report subagents stop at their workflow phase boundary so the orchestrator remains the only stage controller.

These are CmbCowork harness adaptations, not delivery-stage changes.

## Preserved Compose flow

`Brainstorm → Design write/extraction → topological per-task TDD → Verify (up to 3 attempts) → one combined global Review → Critical fix/reverify/review (up to 2 attempts) → final Report → single-commit Merge`

This preserves the source Compose workflow's stages, schemas, retry limits, dependency batches, Critical-only fix loop, reporting, and merge result. The CmbCowork adapter adds no task-level Review, contract-correction phase, mandatory dependency metadata, or extra agent type.

Third-party licenses and required copyright notices are retained in the plugin root.
