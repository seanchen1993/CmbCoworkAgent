---
name: harness-project-workflow
description: Use only in a Harness project Feature session with Dynamic Workflow mode when the user asks to take over the remaining plugin stages after interactive planning is complete.
version: 1.0.0
---

# Harness Project Workflow

This is the launcher for the shared Harness project workflow. It is available only to the main Agent of a project-mode Dynamic Workflow session.

## Preconditions

- The current session is bound to one Harness project Feature.
- The user intentionally selected Dynamic Workflow mode.
- Interactive stages, normally through `dev.plan`, are already complete.
- The remaining stages can run without `request_user_input`.

If any precondition is false, stop and explain the mismatch. Do not run this workflow in a normal conversation session.

## Launch a new run

Copy the bundled workflow into the current workspace without reading, rewriting, or regenerating its contents.

Target:

```text
<workspace>/.cmbdevclaw/workflows/harness-project.workflow.js
```

Run the platform-appropriate copy command with `execute.cwd` set to the directory containing this `SKILL.md`.

macOS/Linux:

```bash
mkdir -p "<workspace>/.cmbdevclaw/workflows"
cp "workflow/harness-project.workflow.js" "<workspace>/.cmbdevclaw/workflows/harness-project.workflow.js"
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "<workspace>/.cmbdevclaw/workflows"
Copy-Item -Force "workflow/harness-project.workflow.js" "<workspace>/.cmbdevclaw/workflows/harness-project.workflow.js"
```

Always overwrite the workspace copy for a new run. If the copy fails, report the error and stop; do not reconstruct the JavaScript through the model.

Call the Workflow tool with:

```text
scriptPath: ".cmbdevclaw/workflows/harness-project.workflow.js"
args: {
  "maxStages": 32,
  "maxStageCycles": 32
}
```

Optional arguments:

- `maxStages` — default `32`. Maximum number of Harness stages handled by one run.
- `maxStageCycles` — default `32`. Maximum serial Prepare/Execute/Finalize cycles handled inside one managed stage.

Do not enable `request_user_input`, add phases, replace Skill names, parse plugin checkpoints in the launcher, or manually reproduce the workflow.

## Resume

Resume an interrupted run with `resumeFromRunId` alone. Do not recopy the workflow or change args before a resume; a changed script or args invalidates journal replay.

After launch, end the current turn and wait for the workflow task notification.
