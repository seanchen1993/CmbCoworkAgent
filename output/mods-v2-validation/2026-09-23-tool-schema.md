# Tool schema and result contract validation

Date: 2026-09-23. Workspace: C:\ai\CmbCoworkAgent-mods-v2.
Base at review: 70750e10. No UAT changes. No worker commit.
Node PATH: C:\Users\87624\AppData\Local\npm-cache\_npx\52027bd8fc0022aa\node_modules\node\bin.

Added regression tests first. Initial 16 tests: 14 failed, 2 passed, 2.42 seconds at 09:32.
Red log: `output/mods-v2-validation/2026-09-23-tool-schema-red.log`.
Production changes only touch tool-schema.ts and tool-sdk.ts. Existing local-reference source formatting
was normalized in tool-schema.ts; no reference-resolution or input-budget behavior was broadened.

Final combined command:

```powershell
npx vitest run src/main/mods/v2/tool-schema-contract.test.ts src/main/mods/v2/tool-registry.test.ts src/main/mods/v2/tool-sdk.test.ts src/main/mods/v2/tool-sdk.integration.test.ts src/main/mods/v2/model-tools.test.ts
```

Result: 5 files, 58/58 passed, 31.51 seconds at 09:34.
Log: `output/mods-v2-validation/2026-09-23-tool-schema-tests.log`.
The initial Node typecheck found three test-only typing mistakes (private registry access, mixed object
array inference, overly wide core result type). They were corrected using the public registeredTools
method, an explicit ModObject[] and the actual ModObject core result contract; production unchanged.
After those test-only corrections, the dedicated suite again passed 16/16 in 3.16 seconds at 09:35.

```powershell
npx eslint --max-warnings 0 src/main/mods/v2/tool-schema.ts src/main/mods/v2/tool-sdk.ts src/main/mods/v2/tool-schema-contract.test.ts
npx tsc --noEmit -p tsconfig.node.json --composite false
git diff --check -- src/main/mods/v2/tool-schema.ts src/main/mods/v2/tool-sdk.ts
```

ESLint and diff check exit 0. The second full Node typecheck has no errors in this batch, but exits 1
on concurrently implemented compaction files: context-compaction-hooks.integration.test.ts:111,
context-summarization-middleware.ts:28 and :2125. This is not reported as a full typecheck pass; parent
owns the integrated rerun after compaction is complete.

The new integration evidence uses real QuickJS guest/session registration and invocation, not fake
validator output. Invalid annotations/type arrays cannot replace an existing usable tool. Valid local
references, siblings, combinations, enum object equality and annotation-only defaults reach an actual
guest tool handler. Invalid deny/result mixtures follow the existing optional-hook fallback once;
valid denial makes zero core calls. This does not bypass host policy.

Existing suites recheck bounded schema/input/registry/validation work, input rewrites, host identities,
model tool admission, real background process completion and cancellation, runtime tool denial, managed
execution and the same real task with Mods disabled. These establish resource limits and a closed-mod
control, not a new quantitative app performance benchmark.

Contract/differences: `docs/mods-v2-tool-schema-contract-2026-09-23.md`.
Native tool names remain adapted. Local refs are partial; external/recursive/regex/format/conditional
features remain explicitly unsupported. The host revision is owned by the parent task and was not
modified here. Electron final-snapshot tests and business acceptance remain parent-owned.

Parent integration review (10:46): the combined Node typecheck now exits 0
(`2026-09-23-node-integrated-9.log`); the changed schema/result files and new tests have zero ESLint
warnings or errors (`2026-09-23-schema-switch-lint.log`). The parent reviewed registration traversal,
deny branch mutual exclusion, and failed replacement behavior independently.
Electron run 7 passed its real native/custom-tool schema and revocation paths among 76 scenarios;
the overall run then failed in a separate compaction fixture because that fixture exceeded the
eight-plugin project limit. This is reported as scoped Electron evidence, not a whole-suite pass.
The earlier disabled-read performance measurement failed its threshold; no performance or final
business acceptance claim is made by this commit. Electron run 8 is testing the integrated snapshot.
