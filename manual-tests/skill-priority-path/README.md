# Skill Priority And Path Manual Test

This fixture verifies two runtime rules:

1. A standalone skill wins over a same-name plugin skill.
2. Scripts referenced by a skill can run from the skill directory, so relative paths resolve next to `SKILL.md`.

The skill docs intentionally use a bare relative command:

```powershell
node scripts/check-cwd.cjs
```

They do not explicitly tell the agent to set cwd or use an absolute script path.

## Fixture Layout

- `standalone-skills/priority-path-demo`: standalone skill fixture.
- `plugin-priority-path-demo`: plugin fixture with a same-name plugin-owned skill.
- `dist/priority-path-demo-standalone.zip`: uploadable standalone skill package.
- `dist/priority-path-demo-plugin.zip`: uploadable plugin package with a same-name plugin skill.

Both skills are named `priority-path-demo`. They intentionally print different `source` values:

- standalone skill: `standalone-skill`
- plugin skill: `plugin-skill`

## Install For Manual Test

Upload the standalone skill from the Skills UI:

```powershell
C:\ai\CmbCoworkAgent\manual-tests\skill-priority-path\dist\priority-path-demo-standalone.zip
```

Install the plugin fixture from the Plugins UI:

```powershell
C:\ai\CmbCoworkAgent\manual-tests\skill-priority-path\dist\priority-path-demo-plugin.zip
```

Use Customize > Plugins > Install Plugin, upload the zip, and keep the plugin enabled. This is
preferred over copying the fixture directory manually because the UI also writes the plugin registry
entry used by the app.

## Test Prompt

In a new chat, select or type the skill `priority-path-demo`, then ask:

The slash popover should show two `priority-path-demo` rows:

- personal/standalone row: source badge `个人`
- plugin row: `Plugin` badge plus source badge `Priority Path Plugin`

Select the personal/standalone row first and ask:

```text
请严格按 priority-path-demo 技能说明执行一次路径检查，并告诉我 source、cwdBasename、relativeReadOk。
```

Expected result:

```text
source = standalone-skill
cwdBasename = priority-path-demo
relativeReadOk = true
```

If `source = plugin-skill`, the plugin skill incorrectly won the same-name conflict.
If `relativeReadOk = false`, the script did not run from the skill directory.

Then select the plugin row and ask the same prompt. Expected plugin-row result:

```text
source = plugin-skill
cwdBasename = priority-path-demo
relativeReadOk = true
```

This raw-path fixture reports results through command stdout. If the agent runs the command from
the workspace root, `relativeReadOk` will be `false`.
