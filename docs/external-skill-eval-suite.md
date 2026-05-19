# External Skill Eval Suite

The app owns runtime collection and in-product reporting:

- `TraceCollector` writes completed agent traces.
- `src/main/agent/skill-eval` derives per-skill quality records from each trace.
- `src/main/ipc/skill-eval.ts` exposes records to the renderer.
- `src/renderer/src/components/skill-eval/SkillEvalView.tsx` shows the runtime results page.

Promptfoo-style regression suites should live outside this product repository. Treat them as a separate test project that consumes trace JSON files instead of importing app internals.

The current external suite has been generated at:

```text
/Users/liuxuyang/WebstormProjects/cmb-skill-eval-suite
```

## Stable Runtime Outputs

By default, traces are written under:

```text
~/.cmbcoworkagent/traces/<threadId>/<traceId>.jsonl
```

Runtime skill evaluation records are written under:

```text
~/.cmbcoworkagent/skill-evals/records.jsonl
```

Both roots can be redirected by environment variables when a suite launches the app or agent:

```bash
CMB_COWORK_AGENT_HOME=/tmp/cmb-skill-eval/agent-home
CMB_COWORK_TRACES_DIR=/tmp/cmb-skill-eval/traces
```

## Recommended External Layout

```text
cmb-skill-eval-suite/
  promptfooconfig.yaml
  cases/
  fixtures/
  providers/
  graders/
  scripts/
```

The external suite can run a case, collect the newest trace from `CMB_COWORK_TRACES_DIR`, then grade the trace trajectory. Keep these responsibilities outside the app:

- case definitions
- fixture traces
- Promptfoo provider glue
- trajectory graders
- quality-card aggregation scripts
- generated Promptfoo HTML or JSON reports

## Case Runner Contract

When launching a real agent run from an external suite, pass inputs through environment variables instead of shell string interpolation:

```bash
SKILL_EVAL=1
SKILL_EVAL_CASE_ID=scheduler.trace.fixture
SKILL_EVAL_PROMPT='5分钟后提醒我喝水'
SKILL_EVAL_WORKSPACE=/path/to/workspace
CMB_COWORK_TRACES_DIR=/tmp/cmb-skill-eval/traces
CMB_COWORK_AGENT_HOME=/tmp/cmb-skill-eval/agent-home
```

After the run finishes, read the newest JSONL file under `CMB_COWORK_TRACES_DIR`. Grade from the trace schema fields instead of renderer state:

- `traceId`
- `threadId`
- `startedAt`
- `endedAt`
- `outcome`
- `durationMs`
- `userMessage`
- `modelId`
- `usedSkills`
- `totalToolCalls`
- `steps[].toolCalls`
- `nodes[]`

The product's runtime skill evaluation page is for real user runs. External Promptfoo suites are for repeatable regression checks before release or while comparing models, prompts, and skill versions.
