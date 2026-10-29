/** Controlled source preparation only; these files are not evidence of live authoring. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import {
  nativeCompositionSchema,
  readNativeCompositionFiles,
  type NativeComposition
} from "../../src/main/plugins/native-composition"

export type AutoBizMutation = "append-e2e" | "replace-middle"
export const AUTOBIZ_STAGES = [
  "convert",
  "prd",
  "specs",
  "design",
  "plan",
  "code",
  "cicd",
  "archive"
]
export const E2E_STAGE = "e2e"
export const MUTATION_E2E_CONFIGURATION_KEYS = [
  "e2eTestFiles",
  "e2eSubjects",
  "e2eTimeoutMs"
] as const
export type MutationE2eConfiguration = {
  e2eTestFiles: string
  e2eSubjects: string
  e2eTimeoutMs: number
}
export const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")

/** UI choices for the real files this acceptance creates, never values inserted into check.config. */
export function mutationE2eConfiguration(kind = "pass"): MutationE2eConfiguration {
  const file = ["original-fail", "fail"].includes(kind)
    ? "fail"
    : ["zero", "fake"].includes(kind)
      ? kind
      : "pass"
  return {
    e2eTestFiles: JSON.stringify([`acceptance-browser/${file}.test.cjs`]),
    e2eSubjects: JSON.stringify([
      "src/main/java/Orders.java",
      "target/classes/Orders.class",
      "pom.xml"
    ]),
    e2eTimeoutMs: 60000
  }
}

/** The authored declaration must select the actual public UI fields; legacy replacement is unchanged. */
export function mutationE2eConfigurationContract(source: NativeComposition) {
  if (source.modules.length === 8) return undefined
  const report = mutationBrowserReport(source)
  const keys = [...MUTATION_E2E_CONFIGURATION_KEYS].sort()
  for (const check of source.modules[8].checks.filter((check) =>
    report.checkIds.includes(check.id)
  )) {
    assert(check.kind === "action")
    assert.deepEqual(
      [...(check.configurationKeys ?? [])].sort(),
      keys,
      "The native E2E check must independently select the three public UI configuration keys"
    )
    assert(
      !(
        check.config &&
        typeof check.config === "object" &&
        (check.config as Record<string, unknown>).allowLegacyInput === true
      ),
      "Native E2E cannot opt into legacy input"
    )
  }
  for (const key of keys) {
    const field = source.configuration?.userConfig?.[key] as Record<string, unknown> | undefined
    assert(
      field &&
        field.type === (key === "e2eTimeoutMs" ? "number" : "string") &&
        !field.sensitive &&
        !field.multiple,
      `Actual public UI declaration required: ${key}`
    )
  }
  return { keys: [...MUTATION_E2E_CONFIGURATION_KEYS], report }
}

/** Derive the report from its real native checker, not a stage ID or JSON filename. */
export function mutationBrowserReport(source: NativeComposition) {
  const stage = source.modules[8]
  assert(stage, "Appended browser verification stage required")
  assert.equal(
    stage.executionMode,
    "workflow",
    "Browser verification keeps native workflow execution"
  )
  const checks = stage.checks.filter(
    (check) =>
      check.kind === "action" &&
      check.provider.plugin === "test-verification" &&
      check.provider.actionId === "e2e" &&
      check.format === "artifact-reference-v1"
  )
  const ids = [...new Set(checks.map((check) => check.artifactId))]
  assert.equal(
    ids.length,
    1,
    "One declared report must be checked by the original test-verification/e2e action"
  )
  const output = stage.outputs.find((output) => output.id === ids[0])
  assert(output, "The original E2E checker must consume a declared output")
  return { ...output, stageId: stage.id, checkIds: checks.map((check) => check.id) }
}

/** Bounded preservation proof for the simple retained schemas, not arbitrary schema implication. */
function assertSchemaPreserved(previous: unknown, current: unknown, path = "schema") {
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
    assert.deepEqual(current, previous, `Retain ${path}`)
    return
  }
  assert(current && typeof current === "object" && !Array.isArray(current), path)
  const prior = previous as Record<string, unknown>
  const actual = current as Record<string, unknown>
  if (path.endsWith(".properties")) {
    // Adding an optional named property can relax an existing additionalProperties:false.
    // Property names must never be mistaken for schema constraint keywords.
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(prior).sort(), path)
    for (const [key, value] of Object.entries(prior))
      assertSchemaPreserved(value, actual[key], `${path}.${key}`)
    return
  }
  for (const [key, value] of Object.entries(prior)) {
    if (key === "required") {
      assert(Array.isArray(value) && Array.isArray(actual[key]), path)
      for (const field of value)
        assert(actual[key].includes(field), `Retain required ${path}.${field}`)
    } else if (["minLength", "minItems", "minimum"].includes(key)) {
      assert(
        typeof actual[key] === "number" && actual[key] >= Number(value),
        `Retain ${path}.${key}`
      )
    } else if (["maxLength", "maxItems", "maximum"].includes(key)) {
      assert(
        typeof actual[key] === "number" && actual[key] <= Number(value),
        `Retain ${path}.${key}`
      )
    } else assertSchemaPreserved(value, actual[key], `${path}.${key}`)
  }
  for (const key of Object.keys(actual).filter((key) => !(key in prior))) {
    assert(
      [
        "const",
        "required",
        "minLength",
        "minItems",
        "minimum",
        "maxLength",
        "maxItems",
        "maximum",
        "pattern"
      ].includes(key),
      `Unproven schema change: ${path}.${key}`
    )
    if (key === "required")
      assert(Array.isArray(actual[key]) && actual[key].every((value) => typeof value === "string"))
  }
}

export function directoryArchive(directory: string) {
  const zip = new AdmZip()
  zip.addLocalFolder(directory)
  return [...zip.toBuffer()]
}

export function mutationSource(root: string, mutation: AutoBizMutation, external?: string) {
  const originalDirectory = join(root, "resources/native-compositions/autobiz")
  const original = nativeCompositionSchema.parse(
    JSON.parse(readFileSync(join(originalDirectory, "composition/source.json"), "utf8"))
  )
  const originalFiles = readNativeCompositionFiles(originalDirectory, original)
  const directory = external ? resolve(external) : originalDirectory
  let source = nativeCompositionSchema.parse(
    JSON.parse(readFileSync(join(directory, "composition/source.json"), "utf8"))
  )
  const files = readNativeCompositionFiles(directory, source)
  if (!external) {
    source = structuredClone(source)
    source.plugin = { ...source.plugin, id: `autobiz-${mutation}-acceptance`, version: "2.0.0" }
    if (mutation === "replace-middle") {
      const stage = source.modules.find((value) => value.id === "specs")!
      const originalSkill = files.find((file) => file.path === stage.skill)!
      stage.skill = "modules/specs-revised/SKILL.md"
      stage.version = "2.0.0"
      source.resources.push(originalSkill.path)
      files.push({
        path: stage.skill,
        bytes: Buffer.from(
          originalSkill.bytes.toString("utf8") +
            "\nAUTOBIZ_REPLACED_MIDDLE_V2: 保留原始需求性能约束和所有既有上下游契约。\n"
        )
      })
    }
    if (mutation === "append-e2e") {
      source.configuration!.userConfig = {
        ...source.configuration!.userConfig,
        e2eTestFiles: { type: "string", title: "E2E 测试入口（JSON）", required: true },
        e2eSubjects: { type: "string", title: "E2E 被测文件（JSON）", required: true },
        e2eTimeoutMs: {
          type: "number",
          title: "E2E 超时（毫秒）",
          required: true,
          min: 100,
          max: 300000
        }
      }
      const workflow = "workflows/verify-e2e.workflow.js"
      source.resources.push(workflow)
      files.push({
        path: workflow,
        bytes: readFileSync(
          join(root, "resources/native-compositions/test-verification/workflows/verify.workflow.js")
        )
      })
      source.modules.push(e2eModule(source))
      files.push({
        path: "modules/e2e/SKILL.md",
        bytes: Buffer.from(
          "---\nname: autobiz-real-browser-verification\ndescription: Run original test verification workflow\n---\n" +
            "Read the preceding artifacts. Run the unchanged workflows/verify-e2e.workflow.js using " +
            "the approved test-verification provider and configured test files. Wait for physical " +
            "workflow settlement; select only its actual runId and executionId in E2E_REPORT.json.\n"
        )
      })
      const contract = files.find((file) => file.path === "tests/project-contract.json")!
      const cases = JSON.parse(contract.bytes.toString("utf8"))
      cases.cases.push({ id: "e2e-missing", stageId: E2E_STAGE, files: [], expected: "failed" })
      contract.bytes = Buffer.from(JSON.stringify(cases, null, 2))
    }
  }
  assert.deepEqual(
    source.modules
      .slice(0, 8)
      .map((stage, index) => (index === 2 && mutation === "replace-middle" ? "specs" : stage.id)),
    AUTOBIZ_STAGES,
    "The actual AutoBiz eight stages must remain, in order"
  )
  assert(
    mutation === "append-e2e"
      ? source.modules.length === 9
      : [8, 9].includes(source.modules.length),
    "Append requires one E2E stage; middle replacement retains the eight original business positions"
  )
  const middle = source.modules[2]
  assert.equal(
    middle.skill !== original.modules[2].skill,
    mutation === "replace-middle",
    "Middle replacement must change the real selected Skill"
  )
  for (const [index, previous] of original.modules.entries()) {
    const actual = source.modules[index]
    assert.deepEqual(actual.inputs, previous.inputs, `Preserve ${actual.id} dependencies`)
    assert.deepEqual(actual.outputs, previous.outputs, `Preserve ${actual.id} output contracts`)
    for (const check of previous.checks) {
      const found =
        actual.checks.find((value) => value.id === check.id) ??
        actual.checks.find(
          (value) =>
            value.kind === check.kind &&
            value.artifactId === check.artifactId &&
            (value.kind !== "action" ||
              (check.kind === "action" &&
                value.provider.plugin === check.provider.plugin &&
                value.provider.actionId === check.provider.actionId))
        )
      assert(found, `Preserve ${actual.id} production check ${check.id}`)
      const retained = { ...found, id: check.id }
      if (check.kind === "json-schema" && retained.kind === "json-schema") {
        assertSchemaPreserved(check.schema, retained.schema)
        retained.schema = check.schema
      }
      if (check.kind === "action" && retained.kind === "action" && !check.bindProviderIdentity) {
        assert([undefined, "nativeCompositionProvider"].includes(retained.bindProviderIdentity))
        delete retained.bindProviderIdentity
      }
      assert.deepEqual(retained, check, `Preserve ${actual.id} production check ${check.id}`)
    }
    assert.equal(actual.executionMode, previous.executionMode)
    assert.equal(actual.approval, previous.approval)
    assert.equal(actual.resultApproval, previous.resultApproval)
  }
  const retainedContext = structuredClone(source.context) as {
    provider?: { materials?: { configuration?: string[] } }
  }
  if (source.modules.length === 9 && retainedContext?.provider?.materials?.configuration)
    retainedContext.provider.materials.configuration =
      retainedContext.provider.materials.configuration.filter(
        (key) => !(MUTATION_E2E_CONFIGURATION_KEYS as readonly string[]).includes(key)
      )
  assert.deepEqual(retainedContext, original.context, "Retain knowledge/context contract")
  assert.deepEqual(source.contextAction, original.contextAction)
  for (const [key, value] of Object.entries(original.configuration?.userConfig ?? {}))
    assert.deepEqual(source.configuration?.userConfig?.[key], value, `Retain configuration ${key}`)
  const originalExecution = original.executionResources as {
    profiles?: string[]
    workspaces?: unknown[]
  }
  const execution = source.executionResources as { profiles?: string[]; workspaces?: unknown[] }
  for (const profile of originalExecution?.profiles ?? [])
    assert(execution?.profiles?.includes(profile), `Retain agent profile ${profile}`)
  for (const workspace of originalExecution?.workspaces ?? [])
    assert(
      execution?.workspaces?.some((value) => JSON.stringify(value) === JSON.stringify(workspace)),
      "Retain workspace binding"
    )
  for (const file of originalFiles) {
    if (mutation === "replace-middle" && file.path === original.modules[2].skill) continue
    if (file.path === "tests/project-contract.json") continue
    const found = files.find((value) => value.path === file.path)
    assert(found?.bytes.equals(file.bytes), `Retain original resource bytes: ${file.path}`)
  }
  return {
    source,
    files,
    provenance: external ? "external-unchanged-source" : "controlled-source-fixture",
    inputSourceSha256: sha256(readFileSync(join(directory, "composition/source.json"))),
    directory,
    originalResources: originalFiles.map((file) => ({
      path: file.path,
      sha256: sha256(file.bytes)
    }))
  }
}

function e2eModule(source: NativeComposition): NativeComposition["modules"][number] {
  return {
    id: E2E_STAGE,
    version: "2.0.0",
    title: "真实浏览器 E2E 验证",
    skill: "modules/e2e/SKILL.md",
    executionMode: "workflow",
    approval: "human",
    resultApproval: "human",
    inputs: source.modules
      .slice(5)
      .flatMap((stage) => stage.outputs.map(({ id, contract }) => ({ artifactId: id, contract }))),
    outputs: [
      { id: "e2e-report", path: "E2E_REPORT.json", contract: "devclaw.test-report-selection/v1" }
    ],
    checks: [
      {
        id: "e2e.original-receipt",
        kind: "action",
        artifactId: "e2e-report",
        provider: { plugin: "test-verification", actionId: "e2e" },
        format: "artifact-reference-v1",
        maxBytes: 28000,
        configurationKeys: [...MUTATION_E2E_CONFIGURATION_KEYS],
        bindProviderIdentity: "nativeCompositionProvider"
      }
    ]
  }
}

/** A new owned repository is initialized before any native project/model execution. */
export function initializeMutationWorkspace(root: string, workspace: string) {
  const knowledge = join(workspace, "acceptance-knowledge")
  mkdirSync(knowledge, { recursive: true })
  writeFileSync(
    join(knowledge, "AGENTS.md"),
    "AUTOBIZ_MUTATION_KNOWLEDGE：订单查询必须保留2秒性能要求。\n"
  )
  writeFileSync(
    join(knowledge, "orders.md"),
    "---\ntype: Service Knowledge\ndeploy_unit: orders-api\ntitle: 订单服务\n---\nAUTOBIZ_MUTATION_KNOWLEDGE 订单查询2秒。\n"
  )
  writeFileSync(
    join(workspace, ".gitignore"),
    "target/\n__pycache__/\n.devclaw/\n.cmbcoworkagent/\nacceptance-knowledge/\nacceptance-browser/\n" +
      "NORMALIZED_REQUIREMENTS.json\n*.bundle.json\nCODE_RESULT.json\nE2E_REPORT.json\n"
  )
  writeFileSync(
    join(workspace, "pom.xml"),
    "<project><modelVersion>4.0.0</modelVersion><groupId>fixture</groupId><artifactId>orders</artifactId>" +
      "<version>1</version><properties><maven.compiler.source>17</maven.compiler.source>" +
      "<maven.compiler.target>17</maven.compiler.target></properties></project>"
  )
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8", windowsHide: true })
  git("init", "--initial-branch=main")
  git("config", "user.name", "AutoBiz mutation acceptance")
  git("config", "user.email", "autobiz-mutation@example.test")
  git("config", "core.autocrlf", "false")
  git("add", ".gitignore", "pom.xml")
  git("commit", "-m", "Initialize isolated acceptance repository")
  const browserDirectory = join(workspace, "acceptance-browser")
  mkdirSync(browserDirectory)
  const playwright = require.resolve("playwright", { paths: [root] })
  const common = "const {test}=require('node:test');const assert=require('node:assert/strict');\n"
  writeFileSync(
    join(browserDirectory, "pass.test.cjs"),
    common +
      `const {chromium}=require(${JSON.stringify(playwright)});\n` +
      "test('real Chromium renders and interacts with the delivered order query',async()=>{\n" +
      "const {createServer}=require('node:http');const {execFileSync}=require('node:child_process');\n" +
      "const server=createServer((req,res)=>{const url=new URL(req.url,'http://localhost');res.setHeader('content-type',url.pathname==='/query'?'text/plain; charset=utf-8':'text/html; charset=utf-8');if(url.pathname==='/query'){\n" +
      "try{const value=execFileSync('java',['-cp','target/classes','Orders',url.searchParams.get('id')],{encoding:'utf8',windowsHide:true});res.end('Order '+value.trim());}\n" +
      "catch(e){assert.equal(e.status,2);assert.match(String(e.stderr),/ORDER_NOT_FOUND/);res.end('ORDER_NOT_FOUND');}}\n" +
      'else res.end(\'<label>Order <input aria-label="Order"></label><button>Query</button><output></output><script>document.querySelector("button").onclick=async()=>{document.querySelector("output").textContent=await (await fetch("/query?id="+document.querySelector("input").value)).text()}</script>\')});\n' +
      "await new Promise(done=>server.listen(0,'127.0.0.1',done));let browser;try{browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});const page=await browser.newPage();\n" +
      "await page.goto('http://127.0.0.1:'+server.address().port);\n" +
      "await page.getByLabel('Order').fill('42');await page.getByRole('button',{name:'Query'}).click();\n" +
      "await page.getByText('Order 42',{exact:true}).waitFor();assert.equal(await page.locator('output').textContent(),'Order 42');\n" +
      "await page.getByLabel('Order').fill('missing');await page.getByRole('button',{name:'Query'}).click();\n" +
      "await page.getByText('ORDER_NOT_FOUND',{exact:true}).waitFor();assert.equal(await page.locator('output').textContent(),'ORDER_NOT_FOUND');\n" +
      `await page.screenshot({path:${JSON.stringify(join(workspace, "..", "real-browser.png"))}});\n` +
      "console.log('AUTOBIZ_REAL_CHROMIUM',browser.version());}finally{await browser?.close();await new Promise(done=>server.close(done));}});\n"
  )
  writeFileSync(
    join(browserDirectory, "fail.test.cjs"),
    common + "test('actual failing assertion',()=>assert.equal(1,2));\n"
  )
  writeFileSync(join(browserDirectory, "zero.test.cjs"), "// Intentionally no registered tests.\n")
  writeFileSync(
    join(browserDirectory, "smoke.test.cjs"),
    common + "test('unrelated real passing smoke test',()=>assert.equal(1,1));\n"
  )
  writeFileSync(
    join(browserDirectory, "fake.test.cjs"),
    "console.log(JSON.stringify({passed:true,tests:999,failures:0}));\n"
  )
  return { knowledge, browserDirectory }
}
