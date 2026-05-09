# Hook Forced Outcome Manual Fixture

This fixture verifies `forcedOutcome` in the running Agent UI, especially
fire-and-forget events that do not block the main turn.

`forcedOutcome` is supported on every hook source and format, including global
hooks, workspace hooks, plugin hooks, skill `hooks/hooks.json`, and skill
`SKILL.md` YAML frontmatter. For fire-and-forget events it changes the recorded
hook result semantics, but it does not stop or revise the main Agent turn.

Default workspace:

```powershell
C:\360Downloads
```

## Install

```powershell
node C:\ai\CmbCoworkAgent\manual-tests\hook-forced-outcome\install-workspace-fixture.cjs C:\360Downloads
```

This creates:

- `C:\360Downloads\.cmbdevclaw\hooks\forced-session-start-halt.json`
- `C:\360Downloads\.cmbdevclaw\hooks\forced-notification-revise.json`
- `C:\360Downloads\.cmbdevclaw\hooks\direct-user-prompt-stop.json`
- `C:\360Downloads\manual-tests\hook-forced-outcome\forced-outcome-recorder.cjs`

`direct-user-prompt-stop.json` is installed disabled by default because
`UserPromptSubmit` runs before every prompt and can slow down normal chatting if
left on.

## Reset Logs

```powershell
node C:\360Downloads\manual-tests\hook-forced-outcome\reset-log.cjs C:\360Downloads
```

## Case 1: SessionStart + always-halt

1. Open a new Agent thread with workspace `C:\360Downloads`.
2. Ask:

```text
请简单回复一句：forced outcome session start test
```

Expected:

- The Agent still replies normally. `SessionStart` is fire-and-forget.
- Hook execution records include `SessionStart`.
- The expanded hook record shows `continue=false`.
- The expanded hook record shows `stopReason = FORCED_SESSION_START_HALT`.
- The script log records the original script output as `decision=block`, proving the
  runtime override changed it to halt.

## Case 2: Notification + always-revise

This event fires when the Agent asks the user for approval.

1. Make sure command execution is in approval/ask mode.
2. Ask:

```text
请运行 PowerShell 命令：Get-Date
```

Expected:

- The approval UI still appears. `Notification` is fire-and-forget.
- Hook execution records include `Notification`.
- The expanded hook record shows `decision=block`.
- The expanded hook record shows `reason = FORCED_NOTIFICATION_REVISE`.
- The script log records the original script output as `continue=false`, proving the
  runtime override changed it to revision.

## Case 3: UserPromptSubmit Direct Stop

This case verifies a hook that really stops the current turn before the Agent
starts thinking. It is guarded by a marker string so normal prompts keep working.

Enable the direct-stop hook only for this test:

```powershell
node C:\360Downloads\manual-tests\hook-forced-outcome\set-direct-stop-enabled.cjs C:\360Downloads true
```

Ask:

```text
DIRECT_STOP_TEST 请测试直接停止，不要执行任何工具。
```

Expected:

- The turn stops immediately.
- The Agent should not answer the prompt content.
- The UI shows a `Hook 已停止本轮` card, not `代理出错`.
- The card shows `UserPromptSubmit` and stop reason `DIRECT_STOP_USER_PROMPT`.
- Hook execution records include `UserPromptSubmit`.
- The expanded hook record shows `continue=false`.
- The expanded hook record shows `stopReason = DIRECT_STOP_USER_PROMPT`.

Control prompt:

```text
这是一条不带触发词的普通消息，请简单回复 ok。
```

Expected:

- The same hook may appear in Hook execution records, but it should not stop the
  turn because the `DIRECT_STOP_TEST` marker is absent.
- It should not pop a hook notice for the control prompt.

Disable it again after the test:

```powershell
node C:\360Downloads\manual-tests\hook-forced-outcome\set-direct-stop-enabled.cjs C:\360Downloads false
```

## Read Logs

```powershell
Get-Content C:\360Downloads\.hook-forced-outcome-log\events.jsonl
Get-Content C:\360Downloads\.hook-forced-outcome-log\session-start-halt.last.json
Get-Content C:\360Downloads\.hook-forced-outcome-log\notification-revise.last.json
Get-Content C:\360Downloads\.hook-forced-outcome-log\direct-prompt-stop.last.json
```

## Disable

Rename or delete these files:

```powershell
Rename-Item C:\360Downloads\.cmbdevclaw\hooks\forced-session-start-halt.json forced-session-start-halt.json.disabled
Rename-Item C:\360Downloads\.cmbdevclaw\hooks\forced-notification-revise.json forced-notification-revise.json.disabled
Rename-Item C:\360Downloads\.cmbdevclaw\hooks\direct-user-prompt-stop.json direct-user-prompt-stop.json.disabled
```
