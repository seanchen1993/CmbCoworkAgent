import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, rmSync, linkSync, unlinkSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { rules } from "../resources/native-compositions/autobiz-rules/mods/rules-bundle"
import { referenceBootstrap, runReferencedCheck } from "../resources/native-compositions/autobiz-rules/mods/artifact-reference"
import { register } from "../resources/native-compositions/autobiz-rules/mods/main"
import { parseClawActionExports } from "../src/shared/mods/claw-actions"
import { validateRegisteredToolInput, validateToolSchema } from "../src/main/mods/v2/tool-schema"

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const packageRoot = "resources/native-compositions/autobiz-rules"
const names = ["NORMALIZED_REQUIREMENTS.json", "PRD.bundle.json", "SPECS.bundle.json",
  "DESIGN.bundle.json", "PLAN.bundle.json", "CODE_RESULT.json", "CICD.bundle.json", "ARCHIVE.bundle.json"]
const stages = ["convert", "prd", "specs", "design", "plan", "code", "cicd", "archive"]
const roots: string[] = []
let checks = 0
const check = (name: string, run: () => void | Promise<void>) => Promise.resolve().then(run).then(() => {
  checks++
  console.log("PASS " + name)
})
const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), "autobiz-reference-test-"))
  roots.push(root)
  return root
}
function reference(root: string, stage: string) {
  const index = stages.indexOf(stage)
  const descriptor = (name: string, i: number) => {
    const bytes = readFileSync(join(root, name))
    return { artifactId: i === 0 ? "normalized" : stages[i], path: name,
      bytes: bytes.length, sha256: hash(bytes), maxBytes: i === 7 ? 524288 : 28000 }
  }
  return { protocol: "devclaw.artifact-input/v1", projectId: "test-project", stageId: stage,
    version: index + 1, pluginDigest: "a".repeat(64), workspaceIdentity: "b".repeat(64),
    current: descriptor(names[index], index), sources: names.slice(0, index).map(descriptor) }
}
function execute(root: string, ref: unknown, stage: string, mode = "check", checkRules = rules) {
  const stdin = JSON.stringify({ reference: ref, stage, mode, rules: checkRules })
  const args = ["-I", "-B", "-X", "utf8", "-c", referenceBootstrap]
  const result = spawnSync("python", args, { cwd: root, input: stdin, encoding: "utf8", timeout: 30000,
    windowsHide: true, maxBuffer: 1024 * 1024 })
  assert.ifError(result.error)
  assert.equal(result.stderr, "")
  const report = JSON.parse(result.stdout)
  return { report, status: result.status, stdinBytes: Buffer.byteLength(stdin),
    wireBytes: Buffer.byteLength(JSON.stringify([["python", ...args], { stdin, timeoutMs: 30000,
      env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" } }])) }
}
function normalized(root: string) {
  writeFileSync(join(root, names[0]), JSON.stringify({ feature: "feedback", revision: 2,
    requirements: ["支持中文、😀和换行\n保留原文"] }))
  return reference(root, "convert")
}

async function main() {
try {
  await check("all 28 original Python and bundle byte identities remain unchanged", () => {
    const rows = JSON.parse(readFileSync(join(packageRoot, "tests/original-rules-sha256.json"), "utf8").replace(/^\uFEFF/, ""))
    assert.equal(rows.length, 28)
    for (const row of rows) {
      const bytes = readFileSync(row.path)
      assert.equal(bytes.length, row.bytes, row.path)
      assert.equal(hash(bytes), row.sha256, row.path)
    }
  })
  await check("reference and original inline schemas fit unchanged export budget", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "mods/manifest.json"), "utf8"))
    const exports = parseClawActionExports(manifest.claw)
    const root = workspace(), ref = normalized(root)
    for (const action of exports) validateToolSchema(action.inputSchema)
    const schema = exports.find(a => a.id === "convert")!.inputSchema
    validateRegisteredToolInput(schema, ref)
    validateRegisteredToolInput(schema, JSON.parse(readFileSync(join(root, names[0]), "utf8")))
    assert.throws(() => validateRegisteredToolInput(schema, { ...ref, extra: true }))
    const source = JSON.parse(readFileSync("resources/native-compositions/autobiz/composition/source.json", "utf8"))
    for (const module of source.modules) for (const row of module.checks.filter(c => c.kind === "action")) {
      assert.equal(row.format, "artifact-reference-v1")
      assert.equal(row.maxBytes, module.id === "archive" ? 524288 : 28000)
    }
  })
  await check("actual original convert rule receives full referenced JSON", () => {
    const root = workspace(), ref = normalized(root)
    const first = execute(root, ref, "convert")
    assert.equal(first.report.passed, true, JSON.stringify(first.report))
    writeFileSync(join(root, names[0]), JSON.stringify({ feature: "feedback", revision: 1, requirements: ["x"] }))
    assert.equal(execute(root, reference(root, "convert"), "convert").report.passed, false)
  })
  await check("real Python preserves the exact original content rejection for Chinese and non-BMP bytes", () => {
    const root = workspace()
    normalized(root)
    writeFileSync(join(root, names[1]), JSON.stringify({ feature: "feedback", stage: "prd",
      files: { "PRD.md": "x", "UI_CONTEXT.json": "{}", "IMPLEMENTATION_SCOPE.json": "{}" } }))
    writeFileSync(join(root, names[2]), JSON.stringify({ feature: "feedback", stage: "specs",
      files: { "proposal.md": "x", "UI_CONTEXT.json": "{}" } }))
    for (const text of ["中".repeat(6667), "😀".repeat(5001)]) {
      assert(text.length <= 20000)
      assert(Buffer.byteLength(text) > 20000)
      const raw = JSON.stringify({ feature: "feedback", stage: "design",
        files: { "design.md": text, ".design-contract.lock.json": "{}" } })
      assert(Buffer.byteLength(raw) < 28000)
      writeFileSync(join(root, names[3]), raw)
      const result = execute(root, reference(root, "design"), "design")
      assert.equal(result.status, 1)
      assert.deepEqual(result.report, { passed: false,
        errors: [{ code: "ARTIFACT_BUNDLE_CONTENT_INVALID" }], warnings: [] })
    }
  })
  await check("unknown checker exceptions and decorated or wrong-type codes never disclose details", () => {
    const root = workspace(), ref = normalized(root)
    const privateDetail = "C:/private/fixture-secret.json content=private-fixture-data"
    for (const statement of [
      `raise ValueError(${JSON.stringify(privateDetail)})`,
      `raise ValueError(${JSON.stringify("ARTIFACT_BUNDLE_CONTENT_INVALID " + privateDetail)})`,
      'raise RuntimeError("ARTIFACT_BUNDLE_CONTENT_INVALID")',
      `raise OSError(${JSON.stringify(privateDetail)})`,
      'class CustomError(ValueError): pass\n    raise CustomError("ARTIFACT_BUNDLE_CONTENT_INVALID")'
    ]) {
      const result = execute(root, ref, "convert", "check", {
        ...rules, "check.py": `def run(request):\n    ${statement}\n`
      })
      assert.equal(result.status, 1)
      assert.deepEqual(result.report, { passed: false,
        errors: [{ code: "ARTIFACT_REFERENCE_READ_OR_CHECK_FAILED" }], warnings: [] })
    }
  })
  await check("published Design self-check measures actual UTF-8 file and inner text boundaries", () => {
    const root = workspace()
    const skill = readFileSync("resources/native-compositions/autobiz/modules/design/SKILL.md", "utf8")
    const script = skill.match(/<!-- autobiz-design-size-check:start -->\s*```python\n([\s\S]*?)```/)
    assert(script)
    const run = (text: string, padding = "") => {
      const raw = JSON.stringify({ feature: "feedback", stage: "design",
        files: { "design.md": text, ".design-contract.lock.json": "{}" } }) + padding
      writeFileSync(join(root, names[3]), raw)
      return spawnSync("python", ["-I", "-B", "-X", "utf8", "-c", script[1]], {
        cwd: root, encoding: "utf8", timeout: 30000, windowsHide: true
      })
    }
    for (const text of ["中".repeat(6666) + "aa", "😀".repeat(5000)]) {
      assert.equal(Buffer.byteLength(text), 20000)
      const result = run(text)
      assert.ifError(result.error)
      assert.equal(result.status, 0, result.stderr)
      const tooLarge = run(text + "a")
      assert.equal(tooLarge.status, 1)
      assert.match(tooLarge.stderr, /DESIGN_FILE_UTF8_BYTES_EXCEEDED/)
    }
    run("x")
    const bytes = readFileSync(join(root, names[3])).length
    assert.equal(run("x", " ".repeat(28000 - bytes)).status, 0)
    const tooLarge = run("x", " ".repeat(28001 - bytes))
    assert.equal(tooLarge.status, 1)
    assert.match(tooLarge.stderr, /DESIGN_BUNDLE_UTF8_BYTES_EXCEEDED/)
  })
  await check("original 20,000-byte content, 40-file and 100,000-byte rules remain effective", () => {
    const script = String.raw`import json,sys,tempfile
from pathlib import Path
payload=json.loads(sys.stdin.read())
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory)
    for name,source in payload.items():
        path=root/name
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(source,encoding="utf-8")
    sys.path.insert(0,str(root))
    from check import merge_bundle,run
    def bundle(files):
        return {"feature":"bounded","stage":"prd","files":files}
    def failure(call):
        try:
            call()
            return ""
        except Exception as error:
            return str(error)
    files={"PRD.md":"x"*20000,"UI_CONTEXT.json":"{}","IMPLEMENTATION_SCOPE.json":"{}"}
    merge_bundle({},bundle(files),"prd","bounded")
    assert failure(lambda:merge_bundle({},bundle({**files,"PRD.md":"x"*20001}),"prd","bounded"))=="ARTIFACT_BUNDLE_CONTENT_INVALID"
    normalized={"feature":"bounded","revision":2,"requirements":["r"]}
    def check(files):
        return failure(lambda:run({"stage":"prd","normalized":normalized,"current":bundle(files)}))
    many={**files,**{"sources/SRC-"+str(i).zfill(3)+"/source.txt":"x" for i in range(37)}}
    assert check(many)=="ARTIFACT_BUNDLE_LIMIT" # normalized is the 41st effective file.
    del many["sources/SRC-036/source.txt"]
    assert check(many)!="ARTIFACT_BUNDLE_LIMIT"
    big={**files,"UI_CONTEXT.json":"x"*20000,"IMPLEMENTATION_SCOPE.json":"x"*20000,
        "sources/SRC-000/source.txt":"x"*20000,"sources/SRC-001/source.txt":"x"*(20000-len(json.dumps(normalized,ensure_ascii=False).encode()))}
    assert check(big)!="ARTIFACT_BUNDLE_LIMIT"
    big["sources/SRC-001/source.txt"]+="x"
    assert check(big)=="ARTIFACT_BUNDLE_LIMIT"
print("original business limits retained")`
    const result = spawnSync("python", ["-I", "-B", "-X", "utf8", "-c", script], {
      input: JSON.stringify(rules), encoding: "utf8", timeout: 30000, windowsHide: true
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
  })
  await check("modified bytes, substituted hashes, bounds, fields and undeclared paths fail", () => {
    const root = workspace(), ref = normalized(root)
    const failures = [
      { ...ref, current: { ...ref.current, sha256: "c".repeat(64) } },
      { ...ref, current: { ...ref.current, bytes: ref.current.bytes + 1 } },
      { ...ref, current: { ...ref.current, maxBytes: 524288 } },
      { ...ref, current: { ...ref.current, bytes: 28001 } },
      { ...ref, current: { ...ref.current, path: "../NORMALIZED_REQUIREMENTS.json" } },
      { ...ref, current: { ...ref.current, path: "C:/secret.json" } },
      { ...ref, current: { ...ref.current, path: "undeclared.json" } },
      { ...ref, sources: [ref.current] }, { ...ref, sources: Array(8).fill(ref.current) },
      { ...ref, extra: true }, { ...ref, version: true }
    ]
    for (const invalid of failures) assert.equal(execute(root, invalid, "convert").report.passed, false)
    writeFileSync(join(root, names[0]), "{}")
    assert.equal(execute(root, ref, "convert").report.passed, false)
  })
  await check("hard links and available OS symbolic links are refused", () => {
    const root = workspace(), ref = normalized(root), file = join(root, names[0])
    linkSync(file, join(root, "second-link.json"))
    assert.equal(execute(root, ref, "convert").report.errors[0].code, "ARTIFACT_REFERENCE_LINK")
    unlinkSync(join(root, "second-link.json"))
    const target = join(root, "target.json")
    writeFileSync(target, readFileSync(file)); unlinkSync(file)
    try { symlinkSync(target, file, "file") }
    catch (error) {
      if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
      console.log("NOTE OS symbolic-link creation unavailable; hard-link rejection exercised")
      return
    }
    assert.equal(execute(root, ref, "convert").report.errors[0].code, "ARTIFACT_REFERENCE_LINK")
  })
  await check("referenced Code still requires its actual original workflow before reporting success", async () => {
    const root = workspace()
    for (let i = 0; i < 6; i++) writeFileSync(join(root, names[i]), JSON.stringify(i === 5
      ? { feature: "feedback", runId: "missing-original-run" } : { feature: "feedback", stage: stages[i], files: {} }))
    let handler
    register({ capability: (descriptor, implementation) => {
      if (descriptor.id === "business-checks") handler = implementation.act
    } })
    let inspections = 0
    let scopeReads = 0
    const sdk = { process: { run: async (argv, init) => {
      const result = spawnSync(argv[0], argv.slice(1), { cwd: root, input: init.stdin, encoding: "utf8",
        timeout: 30000, windowsHide: true })
      assert.ifError(result.error)
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
    } }, platform: { read: async request => {
      scopeReads++
      assert.deepEqual(request, { ref: { provider: "native.project-runtime", id: "project", version: "1.0.0" },
        target: { kind: "current" } })
      // This adapter-only fixture has no Host project; full Host integration uses the real provider.
      return { value: { status: "unavailable", code: "PROJECT_RUNTIME_PUBLIC_UNBOUND" } }
    }, act: async request => {
      inspections++
      assert.equal(request.ref.provider, "native.workflow")
      assert.equal(request.input.runId, "missing-original-run")
      return { status: "succeeded", value: { found: false } }
    } } }
    await assert.rejects(handler(sdk, { action: "code", input: { version: 1,
      input: reference(root, "code"), executionId: "check-test", config: { nativeCompositionProvider: {
        plugin: "autobiz-native-rules", actionId: "code", pluginId: "test", digest: "a".repeat(64)
      } } } }), /AUTOBIZ_CODE_ORIGINAL_RUN_UNAVAILABLE/)
    assert.equal(inspections, 1)
    assert.equal(scopeReads, 1)
  })
  await check("seven 28,000-byte files preserve exact archive bytes within original transport limits", async () => {
    const root = workspace()
    const checklist = "## 交付范围\n## 验证证据\n## 发布状态\n## 已知阻断问题\n## 回滚计划\n未请求外部发布 prepared-only run-test PRD.bundle.json SPECS.bundle.json DESIGN.bundle.json"
    const values = names.slice(0, 7).map((_, i) => i === 5 ? { feature: "feedback", runId: "run-test" }
      : i === 6 ? { feature: "feedback", stage: "cicd", publication: { mode: "not-requested", status: "prepared-only" },
        codeRunId: "run-test", files: { "CICD_CHECKLIST.md": checklist, "PR_BODY.md": "prepared-only" } }
      : { feature: "feedback", text: '引号"反斜杠\\换行\n😀' })
    const sources = Object.fromEntries(names.slice(0, 7).map((name, i) => {
      const text = JSON.stringify(values[i]), padded = text + "\t".repeat(28000 - Buffer.byteLength(text))
      writeFileSync(join(root, name), padded)
      return [name, padded]
    }))
    const archive = { feature: "feedback", stage: "archive", publicationStatus: "prepared-only", files: sources,
      artifactDigests: Object.fromEntries(Object.entries(sources).map(([name, text]) => [name, hash(text)])) }
    const archiveText = JSON.stringify(archive)
    assert(Buffer.byteLength(archiveText) > 128 * 1024)
    assert(Buffer.byteLength(archiveText) < 512 * 1024)
    writeFileSync(join(root, names[7]), archiveText)
    const ref = reference(root, "archive")
    const result = execute(root, ref, "archive")
    assert.equal(result.report.passed, true, JSON.stringify(result.report))
    assert.equal(result.report.publicationStatus, "prepared-only")
    assert(Buffer.byteLength(JSON.stringify(ref)) <= 8192)
    assert(result.stdinBytes < 512 * 1024)
    assert(result.wireBytes < 1024 * 1024)
    console.log(JSON.stringify({ capacityOnly: true, archiveBytes: Buffer.byteLength(archiveText),
      referenceBytes: Buffer.byteLength(JSON.stringify(ref)), stdinBytes: result.stdinBytes, wireBytes: result.wireBytes }))
    let call
    await runReferencedCheck({ process: { run: async (argv, init) => { call = { argv, init }; return {} } } }, ref, "archive")
    assert.equal(call.argv.at(-1), referenceBootstrap)
    assert(!call.init.stdin.includes(checklist))
    // A valid transport/archive test is not evidence that these synthetic inputs pass every business stage.
    archive.files[names[0]] += " "
    writeFileSync(join(root, names[7]), JSON.stringify(archive))
    assert.equal(execute(root, reference(root, "archive"), "archive").report.passed, false)
  })
  console.log(`Completed ${checks} reference adapter checks`)
} finally {
  const prefix = resolve(tmpdir(), "autobiz-reference-test-")
  for (const root of roots) {
    assert(resolve(root).startsWith(prefix) && resolve(root) !== resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  }
}
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
