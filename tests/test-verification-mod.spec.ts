/* eslint-disable @typescript-eslint/no-explicit-any -- Adversarial receipt fixtures deliberately corrupt runtime contract shapes. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, linkSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { register } from "../resources/native-compositions/test-verification/mods/main"
import { runnerBootstrap } from "../resources/native-compositions/test-verification/mods/runner"
import { compileFunctionPlugin } from "../src/main/mods/v2/loader"
import { parseClawActionExports } from "../src/shared/mods/claw-actions"
import { validateRegisteredToolInput, validateToolSchema } from "../src/main/mods/v2/tool-schema"
import { analyzeAuthoringPreview } from "../src/main/mods/devtools/authoring-preflight"
import { FunctionGuestRuntime } from "../src/main/mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../src/main/mods/v2/session"
import { PROJECT_RUNTIME_CAPABILITY_DESCRIPTOR } from "../src/shared/mods/v2/project-runtime-capability"
import { validateWorkflowScript } from "../src/main/agent/workflow/script"

const require = createRequire(import.meta.url)
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const roots: string[] = []
let checks = 0
const test = async (name: string, run: () => unknown | Promise<unknown>) => {
  await run()
  checks++
  console.log("PASS " + name)
}
const provider = {
  pluginId: "installed-test-verification",
  plugin: "test-verification",
  digest: "a".repeat(64),
  actionId: "e2e"
}
let handler: (sdk: unknown, event: unknown) => Promise<any>
let descriptor: any
register({
  capability: (value, implementation) => {
    descriptor = value
    handler = implementation.act
  }
})

function fixture(
  source = 'const {test}=require("node:test"); const assert=require("node:assert/strict"); test("actual case",()=>assert.equal(require("./app.js"),42))'
) {
  const root = mkdtempSync(join(tmpdir(), "independent-test-verification-"))
  roots.push(root)
  writeFileSync(join(root, "browser.test.cjs"), source)
  writeFileSync(join(root, "INPUT.json"), JSON.stringify({ requirement: "actual test input" }))
  writeFileSync(join(root, "app.js"), "module.exports=42")
  const scope = {
    status: "ready",
    reviewAvailable: false,
    currentVersion: true,
    projectId: "project",
    version: 4,
    stageId: "acceptance",
    operationId: "operation"
  }
  const inputs: {
    files: string[]
    sources: { artifactId: string; path: string; maxBytes: number }[]
    subjects?: string[]
    timeoutMs: number
  } = {
    files: ["browser.test.cjs"],
    sources: [{ artifactId: "input", path: "INPUT.json", maxBytes: 28000 }],
    subjects: ["app.js"],
    timeoutMs: 10000
  }
  const configuration = {
    e2eTestFiles: JSON.stringify(inputs.files),
    e2eSubjects: JSON.stringify(inputs.subjects),
    e2eTimeoutMs: inputs.timeoutMs
  }
  const selection = {
    protocol: "devclaw.test-report-selection/v1",
    runId: "workflow-run",
    executionId: "wfa_actual"
  }
  let original: any,
    calls = 0,
    receiptMutation = (value: any) => value
  const sdk = {
    process: {
      run: async (argv: string[], options: any) => {
        calls++
        assert.equal(argv[0], "node")
        assert.equal(argv[1], "-")
        assert.equal(options.integrity, "native")
        assert.equal(options.stdin, runnerBootstrap)
        const result = spawnSync(argv[0], argv.slice(1), {
          cwd: root,
          input: options.stdin,
          encoding: "utf8",
          timeout: options.timeoutMs,
          windowsHide: true,
          env: { ...process.env, ...options.env },
          maxBuffer: 1024 * 1024
        })
        assert.ifError(result.error)
        assert.equal(result.stderr, "")
        return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
      }
    },
    platform: {
      read: async () => ({ value: { ...scope } }),
      act: async (request: any) => {
        assert.equal(request.ref.provider, "native.project-runtime")
        assert.equal(request.action, "inspect-workflow-evidence")
        assert.equal(request.input.stageId, scope.stageId)
        const value = {
          status: "succeeded",
          value: {
            found: true,
            evidence: {
              projectId: "project",
              operationId: "operation",
              stageId: "acceptance",
              pluginDigest: "b".repeat(64),
              inputFingerprint: "immutable-host-owned"
            },
            run: {
              runId: selection.runId,
              status: "completed",
              resultTruncated: false,
              result: selection,
              actionCount: 1,
              nextActionOffset: null,
              deterministicActions: [
                {
                  executionId: selection.executionId,
                  provider: { ...provider, actionId: "execute-e2e" },
                  status: original?.status,
                  outputTruncated: false,
                  output: original?.output
                }
              ]
            }
          }
        }
        return receiptMutation(structuredClone(value))
      }
    }
  }
  const reference = () => {
    const row = (path: string, artifactId: string) => {
      const raw = readFileSync(join(root, path))
      return { artifactId, path, bytes: raw.length, maxBytes: 28000, sha256: hash(raw) }
    }
    return {
      protocol: "devclaw.artifact-input/v1",
      projectId: "project",
      stageId: "acceptance",
      version: 4,
      pluginDigest: "b".repeat(64),
      workspaceIdentity: "c".repeat(64),
      current: row("E2E_REPORT.json", "e2e-report"),
      sources: [row("INPUT.json", "input")],
      configuration: structuredClone(configuration)
    }
  }
  const check = (ref = reference(), config: Record<string, unknown> = {}) =>
    handler(sdk, {
      action: "e2e",
      input: {
        version: 1,
        executionId: "check_execution",
        config: { nativeCompositionProvider: provider, ...config },
        input: ref
      }
    })
  return {
    root,
    scope,
    inputs,
    configuration,
    selection,
    sdk,
    reference,
    check,
    calls: () => calls,
    mutate: (fn: (value: any) => any) => {
      receiptMutation = fn
    },
    execute: async () => {
      original = await handler(sdk, {
        action: "execute-e2e",
        input: { version: 1, executionId: selection.executionId, input: inputs }
      })
      writeFileSync(join(root, "E2E_REPORT.json"), JSON.stringify(selection))
      return original
    }
  }
}

async function main() {
  try {
    await test("independent resource compiles with real public action schemas and no AutoBiz imports", async () => {
      const root = resolve("resources/native-compositions/test-verification")
      const compiled = await compileFunctionPlugin(root)
      assert(compiled)
      const authoring = await analyzeAuthoringPreview(root)
      assert.equal(authoring.sdk.strictCompatible, true, JSON.stringify(authoring.sdk.diagnostics))
      assert.equal(authoring.typecheck.valid, true, JSON.stringify(authoring.typecheck))
      assert.deepEqual(
        compiled.actions?.map((action) => action.id),
        ["execute-e2e", "e2e"]
      )
      const manifest = JSON.parse(readFileSync(join(root, "mods/manifest.json"), "utf8"))
      for (const action of parseClawActionExports(manifest.claw)) {
        validateToolSchema(action.inputSchema)
        if (action.configSchema) validateToolSchema(action.configSchema)
      }
      assert.equal(descriptor.version, "2.0.0")
      for (const file of ["main.ts", "runner.ts"])
        assert.doesNotMatch(readFileSync(join(root, "mods", file), "utf8"), /autobiz/i)
      const f = fixture()
      const schema = compiled.actions!.find((action) => action.id === "execute-e2e")!.inputSchema
      validateRegisteredToolInput(schema, f.inputs)
      assert.throws(() =>
        validateRegisteredToolInput(schema, { ...f.inputs, argv: ["echo", "PASS"] })
      )
      assert.deepEqual(
        descriptor.actions.find((action) => action.id === "execute-e2e").requiredPermissions,
        ["process.run", "platform.read"]
      )
    })
    await test("real Node cases create a compact receipt bound to the original project workflow action", async () => {
      const f = fixture(),
        executed = await f.execute()
      assert.equal(executed.status, "succeeded", JSON.stringify(executed))
      assert.deepEqual(executed.output.counts, { total: 1, passed: 1, failed: 0, skipped: 0 })
      assert(Buffer.byteLength(JSON.stringify(executed.output)) <= 2000)
      assert.equal((await f.check()).output.passed, true)
      assert.equal(f.calls(), 3)
    })
    await test("Host UI entry rejects genuinely successful substituted files, subjects and timeout", async () => {
      for (const changed of ["files", "subjects", "timeoutMs"]) {
        const f = fixture()
        if (changed === "files") {
          writeFileSync(
            join(f.root, "other.test.cjs"),
            'require("node:test").test("different but genuine success",()=>{})'
          )
          f.inputs.files = ["other.test.cjs"]
        } else if (changed === "subjects") {
          writeFileSync(join(f.root, "other.js"), "module.exports=42")
          f.inputs.subjects = ["other.js"]
        } else f.inputs.timeoutMs++
        const actual = await f.execute()
        assert.equal(actual.status, "succeeded", JSON.stringify(actual))
        await assert.rejects(f.check(), /TEST_EXPECTED_ENTRY_MISMATCH/)
      }
      const f = fixture()
      await f.execute()
      f.configuration.e2eTimeoutMs++
      await assert.rejects(f.check(), /TEST_EXPECTED_ENTRY_MISMATCH/)
    })
    await test("missing or malformed Host configuration never silently becomes a static or legacy expectation", async () => {
      const f = fixture()
      await f.execute()
      const missing: any = f.reference()
      delete missing.configuration
      await assert.rejects(f.check(missing), /TEST_EXPECTED_CONFIGURATION_REQUIRED/)
      await assert.rejects(
        f.check(missing, { testEntry: f.inputs }),
        /TEST_EXPECTED_CONFIGURATION_REQUIRED/
      )
      const legacy = await f.check(missing, { allowLegacyInput: true })
      assert.equal(legacy.output.expectedEntryBound, false)
      assert.deepEqual(legacy.output.warnings, [{ code: "TEST_LEGACY_ENTRY_UNBOUND" }])
      assert.equal((await f.check()).output.expectedEntryBound, true)
      const invalid: any[] = [
        undefined,
        null,
        {},
        [],
        { ...f.configuration, extra: "not selected" },
        { ...f.configuration, e2eTestFiles: "not JSON" },
        { ...f.configuration, e2eTestFiles: "[]" },
        { ...f.configuration, e2eTestFiles: '["../outside.test.cjs"]' },
        { ...f.configuration, e2eTestFiles: '["browser.test.cjs","BROWSER.test.cjs"]' },
        { ...f.configuration, e2eTestFiles: JSON.stringify(Array(5).fill("browser.test.cjs")) },
        { ...f.configuration, e2eSubjects: "[]" },
        { ...f.configuration, e2eSubjects: '["app.js",123]' },
        { ...f.configuration, e2eSubjects: '["C:\\\\private.js"]' },
        { ...f.configuration, e2eTimeoutMs: "10000" },
        { ...f.configuration, e2eTimeoutMs: 100.5 },
        { ...f.configuration, e2eTimeoutMs: 99 },
        { ...f.configuration, e2eTimeoutMs: 300001 }
      ]
      const before = f.calls()
      for (const configuration of invalid) {
        const ref = { ...f.reference(), configuration }
        await assert.rejects(
          f.check(ref, { allowLegacyInput: true }),
          /TEST_EXPECTED_CONFIGURATION_INVALID/
        )
      }
      assert.equal(f.calls(), before)
    })
    await test("the bundled workflow parses selected UI values and calls the original real runner action", async () => {
      const script = validateWorkflowScript(
        readFileSync(
          resolve("resources/native-compositions/test-verification/workflows/verify.workflow.js"),
          "utf8"
        )
      )
      // Script adaptation contract only; FunctionSession/native process admission is verified separately.
      const executeScript = new Function(
        "args",
        "action",
        "return (async()=>{" + script.body + "})()"
      )
      const f = fixture()
      const invoke = async (request: any) => {
        assert.deepEqual(request.provider, { ...provider, actionId: "execute-e2e" })
        assert.deepEqual(request.input, f.inputs)
        const result = await f.execute()
        return { ...result, parentRunId: f.selection.runId, executionId: f.selection.executionId }
      }
      const selected = await executeScript(
        {
          provider: { ...provider, actionId: "execute-e2e" },
          configuration: f.configuration,
          sources: f.inputs.sources,
          files: ["must-not-override.test.cjs"],
          subjects: ["must-not-override.js"],
          timeoutMs: 101
        },
        invoke
      )
      assert.deepEqual(selected, f.selection)
      assert.equal((await f.check()).output.expectedEntryBound, true)
      await assert.rejects(
        executeScript(
          {
            provider: { ...provider, actionId: "execute-e2e" },
            files: f.inputs.files,
            subjects: f.inputs.subjects
          },
          invoke
        ),
        /TEST_EXPECTED_CONFIGURATION_REQUIRED/
      )
    })
    await test("compiled guest runs a real native process only after FunctionSession admission", async () => {
      const f = fixture()
      const compiled = await compileFunctionPlugin(
        resolve("resources/native-compositions/test-verification")
      )
      const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
      const plugin = {
        name: compiled.name,
        root: compiled.root,
        tier: "user" as const,
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
      let approvals = 0,
        allowed = true
      const session = new FunctionSession([plugin], {
        workspace: f.root,
        threadId: "native-test-verification",
        platformIncarnation: "actual-runtime",
        assertLive() {
          /* The fixture holds its original thread and grant throughout the call. */
        },
        publish: async (value) => value,
        platformNativeProviders: [
          {
            provider: "native.project-runtime",
            digest: "native-project-fixture",
            descriptor: PROJECT_RUNTIME_CAPABILITY_DESCRIPTOR,
            read: () => f.scope,
            act: () => {
              throw Error("UNEXPECTED_NATIVE_ACTION")
            }
          }
        ],
        authorizeProcess: async (_plugin, request) => {
          approvals++
          assert.equal(request.argv[0], "node")
          if (!allowed) throw Error("NATIVE_PROCESS_APPROVAL_DENIED")
        }
      })
      try {
        const request = {
          ref: { provider: "test-verification", id: "test-verification", version: "2.0.0" },
          target: { kind: "current" as const },
          action: "execute-e2e",
          input: { version: 1, executionId: "wfa_native", input: f.inputs },
          requestKey: "real-process"
        }
        const receipt = (await session.platform.act(
          plugin,
          request,
          new AbortController().signal
        )) as any
        assert.equal(receipt.status, "succeeded", JSON.stringify(receipt))
        assert.equal(receipt.value.status, "succeeded", JSON.stringify(receipt))
        assert.equal(receipt.value.output.counts.total, 1)
        assert.equal(approvals, 1)
        allowed = false
        const denied = (await session.platform.act(
          plugin,
          { ...request, requestKey: "denied-process" },
          new AbortController().signal
        )) as any
        assert.notEqual(denied.status, "succeeded", JSON.stringify(denied))
        assert.equal(approvals, 2)
      } finally {
        await session.close(true)
      }
    })
    await test("native process integrity preserves observing middleware and rejects changed or denied results", async () => {
      const compiled = await compileFunctionPlugin(
        resolve("resources/native-compositions/test-verification")
      )
      for (const mode of ["observe", "replace", "short-circuit", "deny"] as const) {
        const f = fixture()
        await f.execute()
        const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
        const plugin = {
          name: compiled.name,
          root: compiled.root,
          tier: "user" as const,
          guest,
          capabilities: [...SESSION_CAPABILITIES]
        }
        const body =
          mode === "observe"
            ? "return await next(event)"
            : mode === "deny"
              ? 'return {deny:"fixture process denied"}'
              : mode === "short-circuit"
                ? 'return {value:{exitCode:0,stdout:"fixture synthetic value",stderr:""}}'
                : 'const original=await next(event); return {value:{...original.value,stdout:"fixture replacement"}}'
        const observerGuest = await FunctionGuestRuntime.create(
          `globalThis.__cmbFunctionMod={register(on){on("process.run",async($,event,next)=>{${body}})}}`
        )
        const observer = {
          name: "process-observer",
          root: compiled.root,
          tier: "user" as const,
          guest: observerGuest,
          capabilities: [...SESSION_CAPABILITIES]
        }
        let approvals = 0
        const session = new FunctionSession([observer, plugin], {
          workspace: f.root,
          threadId: "integrity-" + mode,
          platformIncarnation: "actual-integrity",
          assertLive() {
            /* Original fixture scope remains current. */
          },
          publish: async (value) => value,
          platformNativeProviders: [
            {
              provider: "native.project-runtime",
              digest: "native-project-fixture",
              descriptor: PROJECT_RUNTIME_CAPABILITY_DESCRIPTOR,
              read: () => f.scope,
              act: async (_context, action, input) =>
                (
                  await f.sdk.platform.act({
                    ref: { provider: "native.project-runtime" },
                    action,
                    input
                  })
                ).value
            }
          ],
          authorizeProcess: async () => {
            approvals++
          }
        })
        try {
          const receipt = (await session.platform.act(
            plugin,
            {
              ref: { provider: "test-verification", id: "test-verification", version: "2.0.0" },
              target: { kind: "current" },
              action: "execute-e2e",
              input: { version: 1, executionId: "wfa_integrity", input: f.inputs },
              requestKey: "integrity-" + mode
            },
            new AbortController().signal
          )) as any
          if (mode === "observe") {
            assert.equal(receipt.status, "succeeded", JSON.stringify(receipt))
            assert.equal(receipt.value.status, "succeeded", JSON.stringify(receipt))
            assert.equal(receipt.value.output.counts.total, 1)
            assert.equal(approvals, 1)
          } else {
            assert.notEqual(receipt.status, "succeeded", JSON.stringify(receipt))
            assert.match(
              receipt.error,
              mode === "deny" ? /fixture process denied/ : /MODS_PROCESS_INTEGRITY/
            )
            assert.equal(approvals, mode === "deny" || mode === "short-circuit" ? 0 : 1)
          }
          const checked = (await session.platform.act(
            plugin,
            {
              ref: { provider: "test-verification", id: "test-verification", version: "2.0.0" },
              target: { kind: "current" },
              action: "e2e",
              input: {
                version: 1,
                executionId: "check_integrity",
                input: f.reference(),
                config: { nativeCompositionProvider: provider }
              },
              requestKey: "integrity-check-" + mode
            },
            new AbortController().signal
          )) as any
          if (mode === "observe") {
            assert.equal(checked.status, "succeeded", JSON.stringify(checked))
            assert.equal(checked.value.output.passed, true, JSON.stringify(checked))
            assert.equal(approvals, 3)
          } else {
            assert.notEqual(checked.status, "succeeded", JSON.stringify(checked))
            assert.match(
              checked.error,
              mode === "deny" ? /fixture process denied/ : /MODS_PROCESS_INTEGRITY/
            )
            assert.equal(approvals, mode === "deny" || mode === "short-circuit" ? 0 : 2)
          }
        } finally {
          await session.close(true)
        }
      }
    })
    await test("real Chromium browser click and visible UI assertion execute through the same adapter", async () => {
      const source = `const {test}=require("node:test")
const assert=require("node:assert/strict")
const http=require("node:http")
const fs=require("node:fs")
const {chromium}=require(${JSON.stringify(require.resolve("playwright"))})
test("real browser updates user-visible count",async()=>{
  const server=http.createServer((request,response)=>response.end(fs.readFileSync("app.html")))
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve))
  let browser
  try {
    browser=await chromium.launch({headless:true}).catch(()=>chromium.launch({headless:true,channel:"msedge"}))
    const page=await browser.newPage()
    await page.goto("http://127.0.0.1:"+server.address().port)
    await page.locator("#add").click()
    assert.equal(await page.locator("#count").innerText(),"1")
  } finally { if(browser) await browser.close(); await new Promise(resolve=>server.close(resolve)) }
})`
      const f = fixture(source)
      writeFileSync(
        join(f.root, "app.html"),
        '<button id="add">Add</button><output id="count">0</output><script>let n=0;document.querySelector("#add").onclick=()=>document.querySelector("#count").textContent=String(++n)</script>'
      )
      f.inputs.subjects = ["app.html"]
      f.inputs.timeoutMs = 30000
      f.configuration.e2eSubjects = JSON.stringify(f.inputs.subjects)
      f.configuration.e2eTimeoutMs = f.inputs.timeoutMs
      const executed = await f.execute()
      assert.equal(executed.status, "succeeded", JSON.stringify(executed))
      assert.equal(executed.output.counts.total, 1)
      assert.equal((await f.check()).output.passed, true)
      writeFileSync(join(f.root, "app.html"), '<button id="add">Broken application</button>')
      await assert.rejects(f.check(), /TEST_REPORT_OR_INPUT_CHANGED/)
    })
    await test("declared subject byte changes during or after execution invalidate real successful evidence", async () => {
      const f = fixture()
      const executed = await f.execute()
      assert.equal(executed.status, "succeeded")
      assert.deepEqual(executed.output.subjects, ["app.js"])
      assert.match(executed.output.subjectFingerprint, /^[a-f0-9]{64}$/)
      const sourcesBefore = readFileSync(join(f.root, "INPUT.json"), "utf8")
      const testsBefore = readFileSync(join(f.root, "browser.test.cjs"), "utf8")
      writeFileSync(join(f.root, "app.js"), "module.exports=43")
      assert.equal(readFileSync(join(f.root, "INPUT.json"), "utf8"), sourcesBefore)
      assert.equal(readFileSync(join(f.root, "browser.test.cjs"), "utf8"), testsBefore)
      await assert.rejects(f.check(), /TEST_REPORT_OR_INPUT_CHANGED/)
      const during = fixture(
        'const {test}=require("node:test"); test("mutates subject",()=>require("node:fs").writeFileSync("app.js","module.exports=43"))'
      )
      const changed = await during.execute()
      assert.equal(changed.status, "failed")
      assert.deepEqual(changed.output.errors, [{ code: "TEST_FILE_CHANGED" }])
      const escaped = fixture()
      escaped.inputs.subjects = ["../outside.js"]
      assert.equal((await escaped.execute()).status, "failed")
      const legacy = fixture()
      delete legacy.inputs.subjects
      const legacyExecution = await legacy.execute()
      assert.equal(legacyExecution.status, "succeeded")
      assert.deepEqual(legacyExecution.output.subjects, [])
      await assert.rejects(legacy.check(), /TEST_ORIGINAL_RECEIPT_INVALID/)
    })
    await test("zero cases, forged stdout JSON, failure, skipped and timed-out tests never pass", async () => {
      const samples = [
        "",
        "console.log(JSON.stringify({passed:true,counts:{total:100,passed:100,failed:0,skipped:0}}))",
        'const {test}=require("node:test"); test("failure",()=>{throw Error("private detail")})',
        'const {test}=require("node:test"); test.skip("skip",()=>{})',
        'const {test}=require("node:test"); test("timeout",async()=>new Promise(()=>{}))'
      ]
      for (const source of samples) {
        const f = fixture(source)
        f.inputs.timeoutMs = 200
        const executed = await f.execute()
        assert.equal(executed.status, "failed", source)
        assert.equal(executed.output.passed, false)
        assert(!JSON.stringify(executed).includes("private detail"))
        await assert.rejects(f.check(), /TEST_ORIGINAL_RECEIPT_INVALID/)
      }
    })
    await test("handwritten PASS and forged selections have no original action authority", async () => {
      const f = fixture()
      await f.execute()
      writeFileSync(
        join(f.root, "E2E_REPORT.json"),
        JSON.stringify({ passed: true, total: 1, failed: 0 })
      )
      await assert.rejects(f.check(), /TEST_REPORT_REFERENCE_INVALID/)
      writeFileSync(
        join(f.root, "E2E_REPORT.json"),
        JSON.stringify({ ...f.selection, executionId: "forged" })
      )
      await assert.rejects(f.check(), /TEST_ORIGINAL_RUN_UNAVAILABLE/)
    })
    await test("foreign, failed, truncated, changed and multiplied original action receipts are rejected", async () => {
      const mutations = [
        (v: any) => {
          v.value.run.deterministicActions[0].provider.digest = "f".repeat(64)
        },
        (v: any) => {
          v.value.run.deterministicActions[0].provider.pluginId = "foreign"
        },
        (v: any) => {
          v.value.run.deterministicActions[0].provider.actionId = "echo"
        },
        (v: any) => {
          v.value.run.deterministicActions[0].status = "failed"
        },
        (v: any) => {
          v.value.run.deterministicActions[0].outputTruncated = true
        },
        (v: any) => {
          v.value.run.deterministicActions[0].output.counts.total = 0
        },
        (v: any) => {
          v.value.run.deterministicActions[0].output.counts.failed = 1
        },
        (v: any) => {
          v.value.evidence.operationId = "old-operation"
        },
        (v: any) => {
          v.value.run.status = "running"
        },
        (v: any) => {
          v.value.run.actionCount = 2
        },
        (v: any) => {
          const other = structuredClone(v.value.run.deterministicActions[0])
          other.executionId = "second"
          v.value.run.deterministicActions.push(other)
          v.value.run.actionCount = 2
        }
      ]
      const f = fixture()
      await f.execute()
      for (const mutation of mutations) {
        f.mutate((value) => {
          mutation(value)
          return value
        })
        await assert.rejects(f.check(), /TEST_/)
      }
    })
    await test("old project version, stage or operation and changed sources/tests cannot replay success", async () => {
      const f = fixture()
      await f.execute()
      for (const key of ["projectId", "stageId", "operationId", "version"]) {
        const original = f.scope[key]
        f.scope[key] = key === "version" ? 5 : "changed"
        await assert.rejects(f.check(), /TEST_/)
        f.scope[key] = original
      }
      writeFileSync(join(f.root, "INPUT.json"), JSON.stringify({ requirement: "changed" }))
      await assert.rejects(f.check(), /TEST_ORIGINAL_RECEIPT_INVALID/)
      writeFileSync(
        join(f.root, "INPUT.json"),
        JSON.stringify({ requirement: "actual test input" })
      )
      writeFileSync(
        join(f.root, "browser.test.cjs"),
        'const {test}=require("node:test");test("changed",()=>{})'
      )
      await assert.rejects(f.check(), /TEST_REPORT_OR_INPUT_CHANGED/)
    })
    await test("undeclared paths, links and execution denial remain bounded by native interfaces", async () => {
      const f = fixture()
      f.inputs.files = ["../outside.test.cjs"]
      assert.equal((await f.execute()).status, "failed")
      f.inputs.files = ["browser.test.cjs"]
      linkSync(join(f.root, "browser.test.cjs"), join(f.root, "linked.cjs"))
      assert.equal((await f.execute()).status, "failed")
      unlinkSync(join(f.root, "linked.cjs"))
      f.sdk.process.run = async () => {
        throw Error("MODS_PROCESS_APPROVAL_DENIED")
      }
      await assert.rejects(f.execute(), /MODS_PROCESS_APPROVAL_DENIED/)
      assert.equal(f.calls(), 2)
    })
    console.log(`${checks} independent test verification contracts passed`)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
