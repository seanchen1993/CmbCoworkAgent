# Test engineer assignment protocol

## Assignment

One assignment contains tasks from one Batch with the same `executionLane` and `workspaceRef`. Use the stable order returned by `utest_assignment_router.py`: backend, frontend, then any unsupported lane. Do not run assignments concurrently.

The task description starts with the router-produced `<UTEST_ASSIGNMENT>` block and carries:

- `<SCOPE>`, `<SYSTEM>`, and `<UNIT>` references.
- `batchPlanPath`, `batchId`, `executionLane`, `workspaceRef`, and the environment inspector's resolved repository/module paths.
- per task: `id`, `implementationPoints`, `nonGoals`, and `validationLocations` containing only plan `repo/cwd`.
- `post_implementation=true` and `tdd_rebuild=false` from the hook contract.
- permitted write paths: tests, fixtures, mocks, test helpers, and test-environment configuration under test-owned paths (or a recognized root test config such as `pytest.ini`/`vitest.config.*`). Do not change dependency manifests, lock files, or production sources during Batch UTest.
- selected framework/domain reference output and environment inspection JSON.

Use the `<UTEST_ASSIGNMENT>` block verbatim; `batchPlanPath` is traceability evidence, so do not reopen plan.json to fetch or restate fields. Test every `implementationPoints` item and exclude every `nonGoals` item. Use `validationLocations` only to confirm the assigned repo/cwd; do not author or pass repository/cwd paths to UTest scripts. Use only the environment inspector's resolved paths for file access. Generate the precise test argv from the repository's real runner after the test file exists; plan validation argv is not a test command. The runner resolves the current plan digest, binding, location, test file, argv, spec refs, and AC coverage.

Resolve `framework` only from actually opened `<SYSTEM>`/`<UNIT>` documents. Resolve runner and package manager only from the assigned repository's manifests, lock files, and test configuration. A conflict is a blocking `contract_gap`. If the constraint does not name a framework, use repository facts and add a warning.

## Routing

| Target | Domain |
|---|---|
| Pure function | `unit` / frontend `fundamentals` |
| Hook or composable | `logic` |
| Store | `state` |
| Component | `component` |
| Router, page, API adapter | `integration` |

Real-browser, multi-page, and real-network paths return `e2e_handoff` only.

## Failure result

Use one classification: `test_bug`, `source_bug`, `contract_gap`, `environment`, `flaky`, or `unknown`. Fix test-owned failures in the assignment. A `source_bug` requires the source-bug validator's attestation for a FAIL target with non-zero current Evidence, matching taskDigest/commandId, and real AC covers. Do not fix production code in UTest: return `source_fix_request` with the attestation, failing command, root cause, and Batch boundary. The fixed Batch Workflow will repair production code, compile/reseal, and restart Review plus this assignment.

## Return object

Return exactly: `status`, `assignment`, `constraint_files`, `lane`, `framework`, `runner`, `environment_initialization`, `test_targets`, `command_results`, `evidence_ids`, `failure_classification`, `source_bug_attestation`, `source_fix_request`, `e2e_handoff`, `warnings`.
