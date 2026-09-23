# Native failure repair arbitration and evidence

Base 76d62a9d. Real business demonstration exposed missing repair.attempt records on the early native-test/validator failure paths. Review also found those paths could request a repair despite an already-blocking mandatory guest result.

The final decision now preserves a prior block, combines bounded diagnostic reasons, and records each host-requested repair before returning to the original revision loop. Host unit/E2E and Autobiz failures retain their source and selected check. No new execution loop, authority, budget or checkpoint bypass was added. Disabled and report-only behavior stays in the existing branches.

Regression first: three failing cases for validator attempt and explicit block precedence; an additional native-test attempt case was corrected to assert outside the revision callback, since that callback deliberately catches errors. Its valid red result is repair-native-red-2, not the earlier misleading green. All four new assertions then passed.

Validation: real guest/session/native upstream plus original gate/config/relay suites, four files / 69 tests pass (repair-regression). Node and Web typechecks pass. Scoped ESLint zero errors, four existing test formatting warnings. Ordinary Electron build passes.

Real Electron business run 6 succeeds on this implementation: off bypasses the gate with a real defective export; on records native test failure, repair.attempt, original model repair, fresh native test PASS, pinned Autobiz validator PASS and original native checkpoint write. External seven business assertions pass; protected requirement/test/script fingerprints match. Screenshot inspected. Real provider and actual project code were used, not fixed model answers or fabricated acceptance. Full report is in 2026-09-24-real-business-demo.md.

This feature adds one durable row only when requesting a repair; off adds no model, scan or runtime. Formal desktop/ingress performance remains over budget and two-hour soak is pending. This is not final release acceptance.
