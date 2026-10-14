import { expect, it } from "vitest"
import { flowRunnableInCatalog, parseFlowDefinition } from "./schema"
import { createHostReviewFlow, createReviewFlow } from "./templates"
import type { FlowCatalog } from "./types"

it("preserves the exact canonical v1 bytes rather than migrating on read", () => {
  const canonical =
    '{"schemaVersion":1,"id":"old","name":"Old","plugin":"owner","goal":"Work","timeoutMs":1000,"maxExecutions":8,"steps":[{"id":"a","name":"A","enabled":true,"kind":"agent","prompt":"Review"}]}'
  expect(JSON.stringify(parseFlowDefinition(JSON.parse(canonical)))).toBe(canonical)
})

it("creates a v2 review with no plugin and no fake check evidence", () => {
  const flow = parseFlowDefinition(createHostReviewFlow("new"))
  expect(flow).toMatchObject({ schemaVersion: 2, execution: { kind: "host" } })
  expect(Object.hasOwn(flow, "plugin")).toBe(false)
  expect(flow.steps.map((step) => step.kind)).toEqual(["agent", "approval"])
  expect(JSON.stringify(parseFlowDefinition(flow))).toBe(JSON.stringify(flow))
})

it.each([
  { plugin: "owner" },
  { plugin: "" },
  { plugin: null },
  { plugin: undefined },
  { execution: null },
  { execution: { kind: "plugin" } },
  { execution: { kind: "host", grant: {} } },
  { execution: { kind: "host", authority: "admin" } },
  { authority: {} },
  { grant: {} }
])("rejects an ambiguous or forged v2 authority declaration: %j", (patch) => {
  expect(() => parseFlowDefinition({ ...createHostReviewFlow("new"), ...patch })).toThrow()
})

it.each(["code-review", "autobiz-validator", "autobiz-stage"])(
  "rejects unsupported v2 node %s even while disabled",
  (kind) => {
    const flow = createHostReviewFlow("new")
    const step = kind === "autobiz-stage" ? { kind } : { kind: "check", check: kind }
    expect(() =>
      parseFlowDefinition({
        ...flow,
        steps: [...flow.steps, { id: "x", name: "X", enabled: false, ...step }]
      })
    ).toThrow("宿主流程仅支持")
  }
)

it.each(["unit-test", "e2e"])("accepts a genuine supported host check %s", (check) => {
  expect(
    parseFlowDefinition({
      ...createHostReviewFlow("new"),
      steps: [{ id: "check", name: "Check", kind: "check", enabled: true, check }]
    }).steps
  ).toHaveLength(1)
})

it("keeps v1 owner validation and rejects silently mixing execution versions", () => {
  const old = createReviewFlow("owner", "old")
  for (const plugin of [null, "", undefined])
    expect(() => parseFlowDefinition({ ...old, plugin })).toThrow()
  expect(() => parseFlowDefinition({ ...old, execution: { kind: "host" } })).toThrow()
})

it("distinguishes zero plugins from the host execution switch and preserves legacy catalogs", () => {
  const catalog: FlowCatalog = {
    available: true,
    plugins: [],
    agents: [],
    models: [],
    features: [],
    hostAvailable: true
  }
  const modern = createHostReviewFlow("new"),
    old = createReviewFlow("owner", "old")
  expect(flowRunnableInCatalog(modern, catalog)).toBe(true)
  expect(flowRunnableInCatalog(modern, { ...catalog, hostAvailable: false })).toBe(false)
  expect(flowRunnableInCatalog(modern, { ...catalog, hostAvailable: undefined })).toBe(false)
  expect(flowRunnableInCatalog(old, catalog)).toBe(false)
  const legacy = {
    ...catalog,
    hostAvailable: undefined,
    plugins: [{ id: "owner", name: "Owner", authorized: true }]
  }
  expect(flowRunnableInCatalog(old, legacy)).toBe(true)
  expect(flowRunnableInCatalog(old, { ...legacy, available: false })).toBe(false)
})
