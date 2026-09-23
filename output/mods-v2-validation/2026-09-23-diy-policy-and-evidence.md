# DIY completion policy and evidence validation — 2026-09-23

Workspace: C:\ai\CmbCoworkAgent-mods-v2, codex/mods-v2. UAT was not operated on. Node v22.23.2 using the required explicit runtime prefix. Tests below used one worker.

## Red evidence

- completion-policy-enforcement-red: 7 failed, 1 passed; missing budget module and policy enforcement failures.
- completion-native-budget-red / completion-total-budget-red: native provider reservation and actual total usage were not enforced.
- completion-budget-binding-red: the outer ModsManager gate wrapper lost its host budget.
- completion-budget-pending-red: detached in-flight reservations could finish successfully.
- completion-observer-budget-red: an observer-expanded output was rejected instead of being capped at the available total.
- completion-review-scopes-red: 4 failed, 1 passed; canonical file/diff/Feature/project policies did not cause actual review.
- completion-diff-scope-red: 1 failed; real staged-only path was absent from fingerprints.
- completion-host-deadline-red: 2 failed, 1 passed; configured code-review with no provider passed, and guest 600ms plus real child process 650ms passed a 1000ms total deadline.
- completion-evidence-ui-red: missing trusted evidence renderer.
- completion-evidence-off-red: disabled project still exposed records for rendering.
- completion-evidence-rules-red: active host rules/budgets were absent from the evidence UI.
- completion-initial-off-red: 2 failed; default/legacy example configuration had no canonical policy after startup. This final small fix is pending the current Electron build lock.

## Green evidence completed

- completion-policy-enforcement-green-3: 46/46 across manager policy, budget, native model, gate binding and existing completion-loop tests.
- completion-review-scopes-green-2: 15/15; real QuickJS example scope tests and real Git fingerprint tests.
- completion-host-deadline-green: 15/15; includes actual Node child process deadline and missing provider rejection.
- diy-policy-and-evidence-green: 68/68 across 8 files, 26.77s wall, 19.01s tests. Includes manager16, models21, gate9, evidence6, original completion8, UI3, budget4 and binding1.
- completion-evidence-rules-green: 3/3 after host rule display was added.
- completion-evidence-ui-green: 7/7 including 4 shared renderer lifetime regression tests.
- diy-policy-node-typecheck: exit 0 for the full Node project before the evidence component was added.
- diy-evidence-web-typecheck: exit 0 for the full Web project including the evidence component.
- diy-policy-eslint: 0 errors, 150 formatting warnings in shared/parallel existing files; no whole-file formatting of other agents' hunks.
- completion-evidence-ui-eslint: 0 errors, 0 warnings for the two new UI files.

## Review

The completion-loop agent independently reviewed the shared budget/SDK boundary. LangChain callback context reset preserves the host budget ALS; native SDK usage settles once, while Agent/context-compaction requests use the transport usage wrapper. Function-completion uses maxAttempts=1 and bypasses that transport wrapper to prevent duplicate SDK accounting. No budget scope escape or duplicate accounting was found in that review.

The scope tests initially stalled because a new test stringified complete model mock-call arguments, including the QuickJS VM object. It was corrected to assert the public model request prompt only. Temporary diagnostics were removed. This was a test-inspection defect, not a claimed production or business success.

## Remaining integration evidence

Parent update: host evidence UI passed in Electron runs 8, 9 and 10 using the actual installed
completion plugin, original repair loop and durable SQLite records. Global/project off hides
records without deleting them. Unknown checkpoint commits now display their operationId and
explicitly require reconciliation before retry; this regression was first red, then 4/4 UI tests green.
The policy/budget implementation was separately committed as f99e60c7. The UI commit includes
the six live sites, lifecycle/configuration notifications, and this read-only evidence viewer.
To verify an independently reviewable commit, staged tree 1bc2cd3a was exported separately:
Node/Web typechecks exit0 and 7 suites/73 tests pass (`ui-index-node`, `ui-index-web`, `ui-index-tests`).
The status-site focused Electron run passed native/custom/off controls; full integrated suite
still requires one final pass after the test fixture corrections. Packaging is deferred to GitHub
Actions after functionality per the user's instruction. These are application checks, not business acceptance.

Electron 7 reported by root passed the existing 73 scenarios and three initial sites, but it predates the completed policy/UI snapshot and is not counted as validation of these new changes. Root owns the next production Electron build and actual UI/installer checks. No fake validator or single-file model answer is counted here as final Autobiz acceptance. Final combined low-concurrency tests, performance comparison, same-task off/on evidence, installer and final business workflow results remain separate integration obligations.
