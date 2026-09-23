import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { canonicalizeState } from "./mods-autobiz-contract-fixture"

export const businessRequirements = `# Order CSV export

Implement CommonJS exportOrders(orders, status) in order-export.cjs.
Each order has id (number), customer (string), status (string).
Return a CSV string with header id,customer,status and LF after every row, including the header.
Filter by exact status; sort ascending numeric id, preserving input order for equal ids.
Preserve Unicode. Fields containing a comma, double quote, LF or CR must be double quoted;
double quotes inside fields must be doubled. Empty results return only the header with LF.
Do not mutate the input array or its records. No external dependencies.
`

export const businessAssertions = `const assert = require("node:assert/strict")
const path = require("node:path")
const { exportOrders } = require(path.resolve(process.argv[2] || __dirname, "order-export.cjs"))
const order = (id, customer, status="ready") => ({id, customer, status})
const input = [order(20,"second"), order(2,"first"), order(1,"excluded","draft")]
const original = JSON.stringify(input)
assert.equal(exportOrders(input,"ready"), "id,customer,status\\n2,first,ready\\n20,second,ready\\n", "filter and numeric ordering")
assert.equal(JSON.stringify(input), original, "input must remain unchanged")
assert.equal(exportOrders([order(2,"a"),order(2,"b")],"ready"), "id,customer,status\\n2,a,ready\\n2,b,ready\\n", "stable equal-id ordering")
assert.equal(exportOrders([order(1,'张三, \\"VIP\\"')],"ready"), 'id,customer,status\\n1,"张三, ""VIP""",ready\\n', "Unicode, commas, quotes")
assert.equal(exportOrders([order(1,"line\\nnext\\r")],"ready"), 'id,customer,status\\n1,"line\\nnext\\r",ready\\n', "line break escaping")
assert.equal(exportOrders([],"ready"), "id,customer,status\\n", "empty header")
assert.equal(exportOrders([order(1,"case","READY")],"ready"), "id,customer,status\\n", "exact status match")
console.log("BUSINESS_ASSERTIONS_PASSED:7")
`

export async function createBusinessProject(root: string) {
  const feature = join(root, ".autobizdevops/features/order-export")
  await mkdir(join(feature, "specs/orders"), { recursive: true })
  await writeFile(join(root, "requirements.md"), businessRequirements)
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node business.spec.cjs" } })
  )
  await writeFile(join(root, "business.spec.cjs"), businessAssertions)
  await writeFile(
    join(root, "order-export.cjs"),
    `exports.exportOrders = orders => orders.map(o => [o.id,o.customer,o.status].join(",")).join("\\n")\n`
  )
  await writeFile(
    join(feature, "proposal.md"),
    `# Order CSV export
## Why
Operators need correctly escaped, deterministic order exports.
## What Changes
Implement exportOrders and verify seven executable acceptance assertions.
## Capability Index
| Capability ID | Name | Operations | Path | Status |
| --- | --- | --- | --- | --- |
| CAP-orders | orders | ADDED | specs/orders/spec.md | planned |
## Impact
Local CommonJS export function, no external service or schema migration.
## Out of Scope
HTTP endpoints, databases and UI export controls.
`
  )
  await writeFile(
    join(feature, "specs/orders/spec.md"),
    `# Orders
Capability-ID: \`CAP-orders\`
## ADDED Requirements
### REQ-orders-001: Export selected orders as CSV
${businessRequirements}
#### SCN-orders-001-01: Valid selected orders
- **WHEN** orders include ready and draft records, equal ids and CSV special characters
- **THEN** selected records satisfy every requirement in requirements.md and business.spec.cjs
#### SCN-orders-001-02: Empty selection
- **WHEN** no records match the exact requested status
- **THEN** output is the header followed by LF
`
  )
  await writeFile(
    join(feature, "design.md"),
    `# Design
## Context / 输入上下文
requirements.md defines exportOrders inputs and CSV output.
## Code Evidence
order-export.cjs exports exportOrders; business.spec.cjs executes seven acceptance assertions.
## Spec Traceability
REQ-orders-001 maps to all seven assertions.
## API Decisions
| ID | Decision |
| --- | --- |
| API-1 | CommonJS local export, no HTTP |
x-auto-no-http-api: true
## Data Decisions
| ID | Decision |
| --- | --- |
| DATA-1 | Immutable in-memory records, no persistence |
x-auto-no-sql: true
## Technical Design
Filter exact status, copy before numeric stable sort, escape CSV fields and append LF.
## Risks / Open Questions
CSV special characters and accidental input mutation are covered by executable assertions.
`
  )
  await writeFile(
    join(feature, "PLAN.md"),
    `# PLAN
## 任务总览
| ID | 状态 |
| --- | --- |
| T1 | 待做 |
## 任务详情
- T1
  - **状态:** 待做
  - **完成记录:** 待验证 order-export.cjs 与 business.spec.cjs
## Contract Coverage
- REQ-orders-001 -> T1
`
  )
  await writeFile(
    join(root, ".autobizdevops/state.json"),
    JSON.stringify({
      schemaVersion: "autobizdevops.state.v3",
      features: {
        "order-export": {
          feature: "order-export",
          checkpoint: "requirements_eval_in_progress",
          workflowProfile: "standard",
          workflowTemplate: "standard",
          workflowDecisions: {}
        }
      }
    })
  )
  await canonicalizeState(root)
}
