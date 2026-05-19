# Skill Quality Evals

This directory is the Promptfoo-based shell for skill quality evaluation.

The app already writes agent traces through `TraceCollector`. This harness reuses that path:

1. Promptfoo runs a case.
2. `providers/agent-trace-provider.cjs` either copies a fixture trace or runs an agent command.
3. The provider writes `run_summary.json` and returns trace paths to Promptfoo.
4. `graders/trajectory.py` reads the trace and scores skill usage, tool trajectory, safety rules, and budget.
5. `scripts/quality-card.py` aggregates Promptfoo JSON output into skill-level cards.

Runtime outputs are written under `.cmbdevclaw/evals/skill-quality/` by default, which is gitignored.

## Quick Smoke Run

Install Promptfoo if it is not already available:

```bash
npm install -D promptfoo
```

Run the fixture-backed smoke eval:

```bash
npm run eval:skills
```

Generate quality cards:

```bash
npm run eval:skills:cards
```

## Running Real Agent Cases

Set an agent command in the case vars or environment:

```bash
SKILL_EVAL_AGENT_COMMAND='node path/to/headless-agent.js' \
  npx promptfoo eval -c evals/skill-quality/promptfooconfig.yaml
```

The provider injects these environment variables into that command:

- `SKILL_EVAL=1`
- `SKILL_EVAL_CASE_ID`
- `SKILL_EVAL_RUN_DIR`
- `SKILL_EVAL_PROMPT`
- `SKILL_EVAL_WORKSPACE`
- `CMB_COWORK_TRACES_DIR`
- `CMB_COWORK_AGENT_HOME`

Your command must read the prompt/workspace from the `SKILL_EVAL_*` environment variables, run the normal agent flow, and let `TraceCollector.finish()` write a trace under `CMB_COWORK_TRACES_DIR`.

For commands that need argv values, prefer `agent_argv` in the case or provider config:

```yaml
vars:
  agent_argv:
    - node
    - path/to/headless-agent.js
    - --prompt
    - "{{prompt}}"
    - --workspace
    - "{{workspace}}"
```

`agent_command` is still supported for trusted shell commands, but shell interpolation placeholders are intentionally rejected there. This keeps case prompts and workspace paths from becoming shell code.

## Case Shape

```yaml
- description: Scheduler reminder should use scheduler skill
  vars:
    case_id: scheduler.reminder.basic
    prompt: "5分钟后提醒我喝水"
    workspace: evals/skill-quality/fixtures/basic-workspace
    expected_skill: scheduler-assistant
    required_tools:
      - read_file
      - manage_scheduler
    forbidden_commands:
      - "git reset --hard"
      - "rm -rf"
    max_tool_calls: 10
  assert:
    - type: python
      value: file://graders/trajectory.py
```

For offline grader development, use `trace_fixture` instead of an agent command.

## Negative Cases

Use `expect_pass: false` when a case should fail the trajectory checks. Promptfoo will treat the expected failure as a passing eval row, while the assertion metadata keeps the raw score and raw reason:

```yaml
- description: Negative example - missing expected scheduler skill
  vars:
    case_id: scheduler.trace.negative
    prompt: "5分钟后提醒我喝水"
    expected_skill: scheduler-assistant
    expect_pass: false
    trace_fixture: evals/skill-quality/fixtures/traces/no-skill.jsonl
  assert:
    - type: python
      value: file://graders/trajectory.py
```
