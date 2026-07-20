---
name: priority-path-demo
description: Manual test skill for standalone-vs-plugin priority and skill-relative script cwd.
---

Use this skill only when the user asks to test skill priority or skill script paths.

Run this command:

```powershell
node scripts/check-cwd.cjs
```

After running, report these fields from the command output:

- `source`
- `cwdBasename`
- `relativeReadOk`
- `template`

Expected values:

```text
source = standalone-skill
cwdBasename = priority-path-demo
relativeReadOk = true
template = standalone template loaded
```
