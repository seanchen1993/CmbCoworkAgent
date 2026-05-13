# Hook Scope Manual Fixture

This fixture helps verify scoped hooks in the running app.

It contains:

- `plugin-hook-scope-demo`: a local plugin with plugin hooks, plugin skill hooks, and one MCP tool.
- `custom-skills/scope-plain-skill`: a non-plugin skill fixture for comparison.
- `hook-recorder.cjs`: the command used by all hooks. It appends JSONL records to `.hook-scope-log/events.jsonl`.
- `reset-log.cjs`: removes `.hook-scope-log` and `manual-tests/hook-scope-output`.

The plugin fixture is Windows/dev-workspace oriented and points its MCP command at `C:\ai\CmbCoworkAgent`.

## Install The Plugin Fixture

Fast path:

```powershell
node C:\ai\CmbCoworkAgent\manual-tests\hook-scope\install-fixture-plugin.cjs
```

Then start a new agent turn in the app.

Manual path:

In the app:

1. Open Customize / Plugins.
2. Click `+`.
3. Choose the local folder:
   `C:\ai\CmbCoworkAgent\manual-tests\hook-scope\plugin-hook-scope-demo`
4. Enable the plugin.

## Optional Plain Skill Fixture

Copy the plain skill folder into the app custom skills directory, then reload the app or open a new thread:

```powershell
Copy-Item -Recurse -Force C:\ai\CmbCoworkAgent\manual-tests\hook-scope\custom-skills\scope-plain-skill C:\Users\87624\.cmbcoworkagent\skills\scope-plain-skill
```

## Reset Logs

```powershell
node C:\ai\CmbCoworkAgent\manual-tests\hook-scope\reset-log.cjs
```

## Read Logs

```powershell
Get-Content C:\ai\CmbCoworkAgent\.hook-scope-log\events.jsonl
```

## Skill Hook Formats To Test

Skill hooks can be defined in any of these places:

- `<skill>/SKILL.md` YAML frontmatter under `hooks`.
- `<skill>/hooks/hooks.json`.
- `<skill>/hooks.json` for legacy packages.

Nested child skills use their own directory. Selecting or activating only the child skill should only fire the child skill hooks.

Example `SKILL.md` frontmatter:

```yaml
---
name: scope-plain-skill
description: Manual fixture for scoped hook testing.
hooks:
  PreToolUse:
    - matcher: execute
      hooks:
        - id: frontmatter-pre-execute
          type: command
          command: node C:\ai\CmbCoworkAgent\manual-tests\hook-scope\hook-recorder.cjs frontmatter-pre-execute
          timeout: 10
          timeoutMs: 12000
          once: true
          onBlock:
            reason: frontmatter pre-execute blocked
            requiredSkill: scope-plain-skill
  PostSkillUse:
    - hooks:
        - id: frontmatter-post-skill
          type: command
          command: node C:\ai\CmbCoworkAgent\manual-tests\hook-scope\hook-recorder.cjs frontmatter-post-skill
          forcedOutcome: always-revise
          forcedReason: frontmatter post-skill requested revision
---
# Scope Plain Skill
```

Notes:

- Claude Code hook format uses `timeout` in seconds.
- CMB extension `timeoutMs` uses milliseconds and wins over `timeout`.
- `once: true` is consumed per session after a successful `exit=0` run; a failing script is not consumed and can run again.
- CMB extension fields supported in frontmatter include `forcedOutcome`, `forcedReason`, `onBlock`, `modelId`, `timeoutMs`, and `once`.
- Command hooks run with `cwd` set to the hook source root: global hooks use `~/.cmbcoworkagent`, workspace hooks use the workspace, plugin hooks use the plugin root, and skill hooks use the skill directory.
