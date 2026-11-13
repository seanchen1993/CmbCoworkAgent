# Frontend test patterns

Source attribution: Vue patterns are adapted from the vuejs-ai skills repository (https://github.com/vuejs-ai/skills) and the Vue official testing guide (https://vuejs.org/guide/scaling-up/testing.html); user-facing query patterns are adapted from Testing Library documentation (https://testing-library.com/). 

编辑说明：运行渲染器选择 framework/domain；不要把本说明复制进 agent prompt。

<!-- section: shared-boundary | framework: * | domain: * -->
## Shared boundary

- Reuse the repository's installed Jest or Vitest runner and its naming/setup conventions.
- Assert observable behavior through exported functions, rendered UI, public store actions, or router/API adapter boundaries.
- Keep network, time, storage, and router dependencies deterministic. Restore mocks and global state after each test.
- A real browser, multiple pages, or a real network chain is an E2E handoff.

<!-- section: shared-fundamentals | framework: * | domain: fundamentals -->
## Fundamentals

- Cover one behavior per test: representative success, important boundary, and contract-defined failure.
- Prefer table cases only when setup and assertion shape remain identical.
- Use fake timers only for timer behavior; flush pending work before restoring real timers.
- A passing characterization test for existing implementation is not a fabricated red phase.

<!-- section: vue-component | framework: vue | domain: component -->
## Vue component

- Mount through Vue Test Utils using public props, emitted events, slots, and visible DOM.
- Use `find`/`get` by accessible role or stable user-facing text where the installed helpers support it.
- Await `trigger`, `setValue`, `nextTick`, and promise flushing before observing asynchronous UI.
- Stub only child boundaries that are unrelated to the behavior under test.

<!-- section: vue-logic | framework: vue | domain: logic -->
## Vue composable and hook logic

- Exercise composables through their returned refs/functions. Mount a minimal host only when lifecycle or injection is part of the contract.
- Provide injection, router, or time dependencies at the nearest public boundary; do not inspect Vue internals.
- Assert cleanup by unmounting the host and observing the external effect.

<!-- section: vue-state | framework: vue | domain: state -->
## Vue state

- Create a fresh Pinia/store instance per test and invoke public actions.
- Assert exposed state/getters and externally visible side effects; reset plugins and subscriptions between tests.
- Mock API adapters at the store boundary, including rejected and stale-response paths required by the contract.

<!-- section: vue-integration | framework: vue | domain: integration -->
## Vue integration

- Use an in-memory router and await `router.isReady()` before assertions.
- Exercise page/router/API adapters with mocked transport, including parameter serialization, navigation guards, and error rendering.
- Hand off redirect chains requiring a browser origin, multiple pages, or real services to E2E.

<!-- section: react-component | framework: react | domain: component -->
## React component

- Render through the installed React Testing Library stack and query by accessible role, label, or visible name.
- Drive behavior with the installed user-event helper; await asynchronous interaction and `findBy`/`waitFor` results.
- Assert DOM and callback contracts, not component state or implementation methods.
- Replace only external boundaries or unrelated heavy children.

<!-- section: react-logic | framework: react | domain: logic -->
## React hook logic

- Use the installed hook renderer or a minimal host component to call hooks under their required providers.
- Wrap externally triggered state transitions with the runner's supported `act` behavior.
- Rerender through public inputs and unmount to verify cleanup; do not call hook internals.

<!-- section: react-state | framework: react | domain: state -->
## React state

- Create a fresh store/provider per test and invoke exported actions or dispatch public events.
- Observe selector output and consumer-visible behavior. Reset singleton stores and subscriptions after each test.
- Mock API adapters at the state boundary and cover loading, success, failure, and stale-response rules required by the contract.

<!-- section: react-integration | framework: react | domain: integration -->
## React integration

- Use a memory router with explicit initial entries and exercise route/page/API adapter behavior through rendered UI.
- Mock transport while preserving request method, path, parameters, and response/error contracts.
- Hand off browser history integration, multi-page navigation, and real-network behavior to E2E.
