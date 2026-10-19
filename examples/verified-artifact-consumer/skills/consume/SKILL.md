---
name: verified-json-report
description: Consume actual bound checked JSON artifacts with an explicitly selected set of required IDs.
---

The task must state `VERIFIED_REQUIRED_IDS=` followed by one JSON array of required artifact IDs.
If missing, stop and ask for that choice; do not guess an application domain, producer or policy.
The required native Stop hook reads this explicit original task independently and rejects a missing
or conflicting report even if a model ignores a failed tool result.

Read `inputs/verified-context.json` through the normal read tool. Invoke this package's registered
`inspect` tool with `requiredIds` from that explicit task. The tool itself reads the fixed bound input,
checks each content SHA-256 and required ID, parses JSON and writes `consumed-report.json` through
the originally approved file SDK. Never provide invented bundle content or write a substitute report.

Read the actual tool result. Missing IDs, changed bytes, malformed JSON, conflicting existing reports
or failed permissions mean stop and request review. Do not silently drop artifacts or retry unknown
effects. On success retain the producer's business status inside the returned JSON; integrity and
consumption success do not grant business or production acceptance.
