# External Skill Eval Suite

The app owns runtime collection and in-product reporting:

- `TraceCollector` writes completed agent traces.
- `src/main/agent/skill-eval` derives per-skill quality records from each trace.
- `src/main/ipc/skill-eval.ts` exposes records to the renderer.
- `src/renderer/src/components/skill-eval/SkillEvalView.tsx` shows the runtime results page.

Promptfoo-style regression suites should live outside this product repository. Treat them as a separate test project that consumes trace JSON files instead of importing app internals.

Example external suite location:

```text
<external-suite-repo>/
# Example: ~/projects/cmb-skill-eval-suite
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

External suites should always use an isolated `CMB_COWORK_AGENT_HOME`. `recordSkillEvalForTrace` runs for every completed trace, so using the default home will write suite results into the developer's normal product data and pollute the in-app Skill 评估 page.

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

The app only reads these environment variables for trace and skill-eval storage:

```bash
CMB_COWORK_AGENT_HOME=/tmp/cmb-skill-eval/agent-home
CMB_COWORK_TRACES_DIR=/tmp/cmb-skill-eval/traces
```

An external suite can define its own runner contract for prompts, case IDs, and workspaces. These `SKILL_EVAL_*` variables are suggested suite/provider conventions only; the app does not read them:

```bash
SKILL_EVAL=1
SKILL_EVAL_CASE_ID=scheduler.trace.fixture
SKILL_EVAL_PROMPT='5分钟后提醒我喝水'
SKILL_EVAL_WORKSPACE=/path/to/workspace
```

After the run finishes, read the newest JSONL file under `CMB_COWORK_TRACES_DIR`. Grade from trace schema fields instead of renderer state.

Minimum stable subset:

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

Additional useful fields currently include `modelName`, `errorMessage`, `appVersion`, `modelCalls` with token usage, and `metadata.routingTrace`. The complete schema lives in `src/main/agent/trace/types.ts`; external suites should treat that file as the source of truth for a pinned app version.

Schema compatibility policy:

- adding fields is non-breaking
- removing fields, renaming fields, or changing existing field types is breaking
- external suites should pin to an app git tag or commit when they depend on trace schema details

The product's runtime skill evaluation page is for real user runs. External Promptfoo suites are for repeatable regression checks before release or while comparing models, prompts, and skill versions.
