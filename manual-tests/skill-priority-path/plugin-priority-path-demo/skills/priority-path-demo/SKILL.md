---
name: priority-path-demo
description: Plugin-owned manual test skill. If this runs while the standalone fixture is enabled, priority is wrong.
---

Use this skill only when the user asks to test plugin-owned skill priority.

Run this command:

```powershell
node scripts/check-cwd.cjs
```

After running, report these fields from the command output:

- `source`
- `cwdBasename`
- `relativeReadOk`
- `template`

Expected values for this plugin-owned fixture:

```text
source = plugin-skill
cwdBasename = priority-path-demo
relativeReadOk = true
template = plugin template loaded
```
