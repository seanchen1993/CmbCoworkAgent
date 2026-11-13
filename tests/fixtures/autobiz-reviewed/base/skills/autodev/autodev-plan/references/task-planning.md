# Plan v2 task semantics

One task owns one small, coherent delivery result in one repository. Split independently deliverable business capabilities, separate state flows, and cross-repository work. Add `dependsOn` only when the downstream result actually needs the upstream delivery. Shared files, APIs, pages or repository membership do not justify merging outcomes or inventing ordering edges.

Keep a task reviewable as one behavior slice. A broad title such as “implement order management” does not make query, editing, cancellation and export one result. Even under one business goal, split substantial subflows that can be reviewed and verified separately. Do not use scenario/API/page/point counts, file counts or estimated hours as automatic blockers.

Keep the normal, boundary, permission and failure paths of the same behavior together. Separate assertions can fail independently without representing separate deliverables. A multi-step interaction may still be one coherent result. Do not split by file, method or individual assertion, or create placeholder work merely to give every task a different scenario. Several tasks may reference the same scenario when they implement different parts of it.

| Proposed scope | Decision |
| --- | --- |
| Submit an order: validate input, persist it, return its ID; cover rejected input and failure rollback | One task in one repository; all points serve order submission |
| Order search, edit, cancellation and export on the same page | Separate behavior slices; shared page is not a grouping rule |
| Export request creation, asynchronous processing, and download/expiry management | Separate substantial subflows with their true delivery dependencies |
| UI submission and server submission in distinct Git repositories | Separate tasks; add a dependency only if one needs the other's delivered code |
| Add a DTO, service method and persistence adapter for order submission | Implementation choices inside the submission task, not three plan tasks |

Every in-scope scenario must occur in one or more `refs.scenarios` as an individual `specs/.../spec.md#SCN-NNN` string. Use unique `TNNN` task IDs; IDs may have gaps and array order has no dependency meaning. Writer orders the runtime DAG without renumbering identities. Existing `IMPLEMENTATION_SCOPE.json` partitions define the current delivery; deferred and unpartitioned items remain visible in the scope report. Do not narrow the confirmed scope to make validation pass.

Each design decision has one primary behavior-delivery owner in `refs.decisions`; choose it by actual responsibility. Public helper code is not automatically frontend work. `refs.api` and `refs.data` give related contract IDs; optional `refs.design` adds API/Data context without repeating IDs already provided. It must not contain `D-NNN`. Code resolves all three ID collections and `designRefs`. UI tasks supply `ui.pages`, optional interactions (empty is valid for a read-only page) and `ui.route`; writer derives visual sources from matching UI capabilities.

`implementationPoints` guide implementation without freezing files, symbols or algorithms. Code may adapt internal structure and necessary production files while preserving behavior, public contracts, workspace ownership and dependencies. `testPoints` and required `verification.intent` describe what UTest/E2E must prove; frameworks, test assets and commands are selected after implementation. Existing public API routes and domain fields are valid behavioral context, not forbidden implementation predictions.
