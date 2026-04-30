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
