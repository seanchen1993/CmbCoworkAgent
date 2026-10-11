import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { generate } from "../../../scripts/generate-bot-java-contracts.mjs"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const files = ["schemas.json", "openapi.json", "state-transitions.json"]
const original = Object.fromEntries(files.map(file => [file, readFileSync(join(root, "contracts/bot/v1", file))]))
const documents = () => Object.fromEntries(files.map(file => [file, JSON.parse(original[file].toString("utf8"))]))
const cli = args => spawnSync(process.execPath, [join(root, "scripts/generate-bot-java-contracts.mjs"), ...args], { cwd: root, encoding: "utf8", timeout: 10000 })
function fixture(change, body) {
  const dir = mkdtempSync(join(tmpdir(), "devclaw-java-contracts-")), output = join(dir, "BotContracts.java")
  try {
    const docs = documents()
    change(docs)
    for (const file of files) writeFileSync(join(dir, file), JSON.stringify(docs[file]) + "\n")
    body(dir, output)
    for (const file of files) assert.deepEqual(readFileSync(join(root, "contracts/bot/v1", file)), original[file], "frozen source bytes unchanged")
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
function rejected(change, reason) {
  fixture(change, (dir, output) => {
    const result = cli(["--contract-dir", dir, "--output", output])
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, reason)
    assert.equal(existsSync(output), false, "validate all supported shapes before output writes")
  })
}

test("ten-operation closure is source-derived, typed, deterministic and excludes Run/Upload", () => {
  const docs = documents(), result = generate(docs)
  assert.deepEqual(result, generate(docs))
  assert.equal(result.operations.length, 10)
  assert.ok(result.reachable.includes("schemas.json#/$defs/Id"))
  assert.ok(result.reachable.includes("schemas.json#/$defs/ErrorResponse"))
  assert.ok(result.reachable.includes("schemas.json#/$defs/Task"))
  assert.ok(result.reachable.includes("state-transitions.json#/$defs/TaskStatus"))
  assert.equal(result.reachable.some(name => /Run|Upload/.test(name)), false)
  assert.match(result.text, /public Long expectedVersion/)
  assert.match(result.text, /List<GroupMember> members/)
  assert.match(result.text, /getBot\(String xDevClawSpace, String botId\)/)
  assert.match(result.text, /getEvents\(String xDevClawSpace, String after, Long limit\)/)
  assert.doesNotMatch(result.text, /\bObject\b|\bMap\b/)
  docs["schemas.json"].$defs.Text.description = "supported annotation changes exact source hash, not Java structural types"
  assert.deepEqual(generate(docs).reachable, result.reachable)
})
test("default --check passes without modifying generated source", () => {
  const output = join(root, "services/bot-control/src/main/java/com/devclaw/botcontrol/contracts/BotContracts.java")
  const before = readFileSync(output)
  assert.equal(cli(["--check"]).status, 0)
  assert.deepEqual(readFileSync(output), before)
})
test("fixture generated drift and missing output fail check without writing", () => {
  fixture(() => {}, (dir, output) => {
    assert.equal(cli(["--contract-dir", dir, "--output", output, "--check"]).status, 1)
    assert.equal(existsSync(output), false)
    assert.equal(cli(["--contract-dir", dir, "--output", output]).status, 0)
    writeFileSync(output, readFileSync(output, "utf8") + "// deliberate drift\n")
    const before = readFileSync(output)
    const result = cli(["--contract-dir", dir, "--output", output, "--check"])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /generated Java drift/)
    assert.deepEqual(readFileSync(output), before)
  })
})
test("reachable unknown keyword fails nonzero", () => rejected(d => { d["schemas.json"].$defs.BotConfig.hack = true }, /unsupported keyword hack/))
test("remote schema reference fails nonzero", () => rejected(d => { d["schemas.json"].$defs.BotConfig.properties.description.$ref = "https://contracts.devclaw.invalid/remote#/$defs/Text" }, /nonlocal\/unsupported reference/))
test("open and implicitly open object fail nonzero", () => {
  rejected(d => { d["schemas.json"].$defs.BotConfig.additionalProperties = true }, /open object unsupported/)
  rejected(d => { delete d["schemas.json"].$defs.BotConfig.additionalProperties }, /open object unsupported/)
})
test("unsupported keyword in ErrorResponse refinement fails nonzero", () => rejected(d => { d["schemas.json"].$defs.ErrorResponse.properties.error.then.hack = true }, /unsupported keyword hack/))
test("unpaired conditional and invalid const fail nonzero", () => {
  rejected(d => { delete d["schemas.json"].$defs.ErrorResponse.properties.error.then }, /paired if\/then/)
  rejected(d => { d["schemas.json"].$defs.ErrorResponse.properties.error.if.properties.code.const = "not_a_wire_code" }, /incompatible refinement const/)
})
test("conditional property alias cycle rejects promptly instead of looping", () => {
  rejected(d => { d["schemas.json"].$defs.ErrorCode = { $ref: "#/$defs/ErrorCode" } }, /recursive refinement reference/)
})
test("finite supported integer/array and keyword placements required", () => {
  rejected(d => { d["schemas.json"].$defs.Version.maximum = 9007199254740992 }, /finite safe integer bounds/)
  rejected(d => { delete d["schemas.json"].$defs.IdList.maxItems }, /bounded array required/)
  rejected(d => { d["schemas.json"].$defs.Id.minimum = 0 }, /unsupported keyword minimum/)
})
test("remote OpenAPI component/header/path references also fail", () => {
  rejected(d => { d["openapi.json"].components.parameters.Space.schema.$ref = "https://remote.invalid/schema#/$defs/Id" }, /nonlocal\/unsupported reference/)
  rejected(d => { d["openapi.json"].components.responses.Bot.$ref = "https://remote.invalid/openapi#/components/responses/Bot" }, /unsupported keyword description|nonlocal component/)
})
test("enum wire identifier collision fails and unselected schemas remain outside graph", () => {
  rejected(d => { d["schemas.json"].$defs.Capability.enum = ["a.b", "a_b"] }, /enum identifier collision/)
  const docs = documents()
  docs["schemas.json"].$defs.Run.unsupportedUnreachable = true
  assert.deepEqual(generate(docs).reachable, generate(documents()).reachable)
})
test("query parameters are limited to the two original optional getEvents selectors", () => {
  rejected(d => { d["openapi.json"].paths["/api/bot/v1/events"].get.parameters[0].name = "arbitrary" }, /unsupported\/duplicate parameter/)
  rejected(d => { d["openapi.json"].paths["/api/bot/v1/events"].get.parameters[1].required = true }, /unsupported\/duplicate parameter/)
  rejected(d => { d["schemas.json"].$defs.Task.hack = true }, /unsupported keyword hack/)
})
