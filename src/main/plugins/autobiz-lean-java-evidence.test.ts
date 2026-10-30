import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { build } from "esbuild"
import { expect, it, vi } from "vitest"

async function moduleExports(file: string) {
  const result = await build({
    entryPoints: [
      resolve("resources/native-compositions/autobiz-lean/providers/delivery/mods", file)
    ],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node"
  })
  const module = {
    exports: {} as {
      workflowReceiptOrder(actions: unknown[], executionIds: string[]): unknown[]
      assertJavaTestCompilation(actions: unknown[], record: unknown): void
      compileJavaSources(sdk: unknown, argv: string[], files: string[]): Promise<unknown>
    }
  }
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports })
  return module.exports
}

it.each([
  ["-Dmaven.main.skip=true", "compile"],
  ["-Dmaven.compiler.skip=true", "compile"],
  ["-pl", "only-one", "compile"],
  ["-f", "other/pom.xml", "compile"],
  ["-Dmaven.compiler.includes=One.java", "compile"],
  ["-Dmaven.compiler.excludes=Other.java", "compile"],
  ["compile", "exec:exec"]
])("rejects Maven options that bypass full root compilation: %j", async (...args) => {
  const api = await moduleExports("java-compile.ts")
  const run = vi.fn(async () => {
    throw Error("DENIED_COMMAND_MUST_NOT_START")
  })
  await expect(
    api.compileJavaSources({ process: { run } }, ["mvn", ...args], ["pom.xml", "src/Orders.java"])
  ).rejects.toThrow("LEAN_MAVEN_COMPILE_COMMAND_REQUIRED")
  expect(run).not.toHaveBeenCalled()
})

it("binds each batch, repair rerun and E2E to its latest matching original compilation", async () => {
  const api = await moduleExports("java-evidence.ts")
  const compiled = (fingerprint = "a".repeat(64)) => ({
    provider: { actionId: "execute-command" },
    status: "succeeded",
    output: {
      phase: "compile",
      executionAdapter: "python-unittest/v1",
      workspaceRef: "default",
      taskIds: ["T001"],
      compilation: {
        mode: "maven-java",
        passed: true,
        files: ["pom.xml", "src/Orders.java"],
        sourceFingerprint: fingerprint
      }
    }
  })
  const tested = (fingerprint = "a".repeat(64), phase = "test") => ({
    provider: { actionId: "execute-command" },
    status: "succeeded",
    output: {
      phase,
      executionAdapter: "python-unittest/v1",
      workspaceRef: "default",
      taskIds: ["T001"],
      test: { subjects: ["pom.xml", "src/Orders.java"], subjectFingerprint: fingerprint }
    }
  })
  for (const phase of ["test", "e2e"]) {
    const record = tested("a".repeat(64), phase)
    expect(() => api.assertJavaTestCompilation([compiled(), record], record)).not.toThrow()
    const changed = tested("b".repeat(64), phase)
    expect(() => api.assertJavaTestCompilation([compiled(), changed], changed)).toThrow(
      "LEAN_COMPILE_TEST_SOURCE_CHANGED"
    )
  }
  const record = tested(),
    foreign = compiled()
  foreign.output.workspaceRef = "other"
  expect(() => api.assertJavaTestCompilation([foreign, record], record)).toThrow(
    "LEAN_COMPILE_TEST_SOURCE_CHANGED"
  )
  const otherTask = compiled()
  otherTask.output.taskIds = ["T002"]
  expect(() => api.assertJavaTestCompilation([otherTask, record], record)).toThrow(
    "LEAN_COMPILE_TEST_SOURCE_CHANGED"
  )
  const missingPom = tested()
  missingPom.output.test.subjects = ["src/Orders.java"]
  expect(() => api.assertJavaTestCompilation([compiled(), missingPom], missingPom)).toThrow(
    "LEAN_COMPILE_TEST_SOURCE_CHANGED"
  )
  const failed = compiled()
  failed.status = "failed"
  expect(() => api.assertJavaTestCompilation([compiled(), failed, record], record)).toThrow(
    "LEAN_COMPILE_TEST_SOURCE_CHANGED"
  )
  const repaired = tested("b".repeat(64))
  expect(() =>
    api.assertJavaTestCompilation([compiled(), compiled("b".repeat(64)), repaired], repaired)
  ).not.toThrow()
  expect(() =>
    api.assertJavaTestCompilation([compiled(), compiled("b".repeat(64)), record], record)
  ).toThrow("LEAN_COMPILE_TEST_SOURCE_CHANGED")
  expect(() => api.assertJavaTestCompilation([record, compiled()], record)).toThrow(
    "LEAN_COMPILE_TEST_SOURCE_CHANGED"
  )
})

it("orders hashed native pages by the verified fixed workflow receipt sequence", async () => {
  const api = await moduleExports("java-evidence.ts")
  const compile = {
    executionId: "compile-id",
    provider: { actionId: "execute-command" },
    status: "succeeded",
    output: {
      phase: "compile",
      executionAdapter: "python-unittest/v1",
      workspaceRef: "default",
      taskIds: ["T001"],
      compilation: {
        mode: "maven-java",
        passed: true,
        files: ["pom.xml", "src/Orders.java"],
        sourceFingerprint: "a".repeat(64)
      }
    }
  }
  const test = {
    executionId: "test-id",
    output: {
      workspaceRef: "default",
      taskIds: ["T001"],
      test: { subjects: ["pom.xml", "src/Orders.java"], subjectFingerprint: "a".repeat(64) }
    }
  }
  const nativePage = [test, compile]
  const ordered = api.workflowReceiptOrder(nativePage, ["compile-id", "test-id"])
  expect(() => api.assertJavaTestCompilation(ordered, test)).not.toThrow()
  test.output.test.subjectFingerprint = "b".repeat(64)
  expect(() => api.assertJavaTestCompilation(ordered, test)).toThrow(
    "LEAN_COMPILE_TEST_SOURCE_CHANGED"
  )
  expect(() => api.workflowReceiptOrder(nativePage, ["compile-id", "unknown"])).toThrow(
    "AUTOBIZ_CODE_ACTION_EVIDENCE_INCOMPLETE"
  )
  expect(() => api.workflowReceiptOrder(nativePage, ["compile-id", "compile-id"])).toThrow(
    "AUTOBIZ_CODE_ACTION_EVIDENCE_INCOMPLETE"
  )
})
