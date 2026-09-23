# Real model / real business / Autobiz demonstration

Implementation: 3b8ce3f7 (ordinary Electron bundle includes the repair arbitration fix). Successful command runs the opt-in tests/mods-business-demo.spec.ts with CMB_MODS_REAL_MODEL_DEMO=1. Run 6 exited 0; artifacts: 2026-09-24-real-business-demo-6/result.json, off.png, on.png and project/. The enabled screenshot was inspected.

## Task and independent acceptance

A disposable, dependency-free order CSV exporter with seven executable assertions: exact status filtering and numeric sorting, no input mutation, stable equal-id sorting, Unicode/comma/quote escaping, CR/LF escaping, empty header and case-sensitive selection. Requirements, test script, package script and Feature specification were fingerprinted before and after. All four fingerprints are unchanged. An independently stored assertion script outside the model-editable project loads the actual final implementation and exits 0 with BUSINESS_ASSERTIONS_PASSED:7.

Both attempts use the same project, initial task prompt and original agent loop. The prompt deliberately requests a completion attempt first, reserving implementation for real host revision feedback; this is a controlled premature-completion demonstration, not a claim about typical model defect rates. Off means the project's completion rule is off, not the global runtime switch.

| Result | Rule off | Rule repair |
| --- | --- | --- |
| Real model request | Yes | Yes |
| Host gate evidence | None | Fourteen records |
| Defective initial exporter | Remains, independent assertions fail | Real review and native test reject it |
| Revision | None | One recorded host-project-check repair request, original agent repairs files |
| Recheck | None | Real code review, native test and pinned validator all pass |
| Independent business assertions | Fails | Seven pass |
| Checkpoint | requirements_eval_in_progress | requirements_eval_done, one native receipt |

The real configured model was deepseek-v4-flash (local configuration ID claude). Twelve actual provider HTTP requests across off/on, one in the off control. The final host budget evidence records 108644 input tokens and 2301 output tokens across review/repair operations. The configured ceiling was 350000 total tokens, 600000ms and two repairs; only one repair was used. This ceiling is not actual usage or a price estimate.

Autobiz compiler/validator comes from fixed source 8db1ec937d6ed3d271cb9dc540310d6633c91e70, reports POST_SKILL_PASS skill=autodev-reviewer. The model wrote the evaluation document after running actual tests; the host also ran its own native test check. The upstream artifact validator alone is not semantic business acceptance: external assertions and unchanged test/requirement hashes supply that separate evidence. Native checkpoint receipt operation ID: 64d25be08115cfa698120142190a365470327eb68be019a0df9d9bd1e05afe2c.

## Isolation and earlier failures

Original model configuration was read without migration or modification. Credentials remained in relay-process memory; isolated Electron stored only a dummy relay key and loopback URL. The relay accepts only chat completions, forwards genuine provider responses, caps request count and timeout, and does not expose provider error bodies or credentials. It does not synthesize model answers. Original per-operation file approvals are clicked only for the demo implementation and evaluation report; no persistent approval or sandbox configuration is changed. Host-native checks and checkpoint retain their own original approvals.

Earlier runs are retained, not called successful: wrong demo policy identifier; malformed guest PASS shape; a harness that observed a transient UI completion; actual repair budget exhaustion at 24000 and 100000 tokens. Budget exhaustion correctly stopped repair and checkpoint progression (run 4 budget-error.png/text, run 5 applicationError). They motivated harness corrections and the separately committed real production fixes for block precedence and missing native repair records. No manually authored final implementation or forced validator PASS was used.

Relay regression: missing implementation first fails, then two transport/redaction/request-budget cases pass. The production completion regression is four files / 69 tests. Dedicated harness typecheck including production preload declarations passes; new harness files ESLint zero errors/warnings. Node/Web production checks and ordinary build pass. This demonstration is real Electron integration, not a package installation test.

## Limits

One controlled business example passes. It does not establish all workflows or full Claude parity. Cancellation, replacement, revoked grants, process death, repeated events and concurrent-state races have separate guest/session/native/Electron tests; they were not all replayed against a paid provider here. Formal desktop TTFT and ingress performance remain over budget, two-hour soak is pending, and GitHub Actions installer delivery is not yet complete.
