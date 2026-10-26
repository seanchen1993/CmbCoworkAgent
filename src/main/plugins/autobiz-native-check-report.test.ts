import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { transformSync } from "esbuild"
import { describe, expect, it, vi } from "vitest"

type Report = { passed: boolean; errors: unknown[]; warnings: unknown[] }
type ProcessResult = { exitCode: number | null; stdout: string; stderr: string }
type Action = (sdk: unknown, event: unknown) => Promise<{ status: string; output: Report }>

// Exercise the shipped registration and process boundaries. Receipt inspection is isolated here;
// its original-store and Git behavior is covered by the native Code integration suites.
function provider(target: string, result: ProcessResult) {
  const handlers = new Map<string, Action>()
  const module = { exports: {} as { register: (on: unknown) => void } }
  const code = transformSync(
    readFileSync(resolve("resources/native-compositions/autobiz-rules/mods/main.ts"), "utf8"),
    { loader: "ts", format: "cjs" }
  ).code
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (id: string) => {
      if (id === "./rules-bundle") return { rules: {} }
      if (id === "./artifact-reference") {
        const reference = { exports: {} }
        const code = transformSync(
          readFileSync(
            resolve("resources/native-compositions/autobiz-rules/mods/artifact-reference.ts"),
            "utf8"
          ),
          { loader: "ts", format: "cjs" }
        ).code
        runInNewContext(code, {
          module: reference,
          exports: reference.exports,
          require: (dependency: string) => {
            if (dependency === "./rules-bundle") return { rules: {} }
            throw Error(`Unexpected artifact reference module: ${dependency}`)
          }
        })
        return reference.exports
      }
      if (id === "./repair-evidence") return { readFailedTestReceipt: async () => ({}) }
      if (id === "./code-result")
        return {
          checkCodeResult: async (
            _sdk: unknown,
            _input: unknown,
            check: (current: unknown) => Promise<Report>
          ) => {
            const report = await check({})
            if (!report.passed) throw Error("PLAN_CHECK_FAILED")
            return { passed: true }
          }
        }
      throw Error(`Unexpected module: ${id}`)
    }
  })
  module.exports.register({
    capability: (definition: { id: string }, implementation: { act: Action }) =>
      handlers.set(definition.id, implementation.act)
  })
  const process = vi.fn(async (argv: string[], options: { stdin?: string }) => {
    if (argv[0] === "python") {
      const stage = JSON.parse(options.stdin!).request.stage
      if (stage === target) return result
      return response(true)
    }
    return {
      exitCode: 0,
      stdout:
        argv[1] === "rev-parse"
          ? "a".repeat(40)
          : target === "performance" && ["diff", "ls-files"].includes(argv[1])
            ? "src/example.ts\0"
            : "",
      stderr: ""
    }
  })
  return {
    process,
    run: (action: string) =>
      handlers.get(
        ["repair-evidence", "validate-command"].includes(action)
          ? "code-execution"
          : "business-checks"
      )!(
        { fs: { read: async () => "{}" }, process: { run: process } },
        {
          action,
          input: {
            version: 1,
            input: {
              workspaceRef: "secondary",
              phase: "compile",
              expectedCommit: "a".repeat(40),
              baselineCommit: "b".repeat(40),
              taskIds: ["T001"],
              argv: ["actual-build-command"]
            }
          }
        }
      )
  }
}

function response(passed: boolean, exitCode: number | null = passed ? 0 : 1): ProcessResult {
  return { exitCode, stdout: JSON.stringify({ passed, errors: [], warnings: [] }), stderr: "" }
}

const routes = [
  ["convert", "convert"],
  ["code", "plan"],
  ["cicd", "cicd"],
  ["archive", "archive"],
  ["repair-evidence", "repair-evidence"],
  ["validate-command", "command-policy"],
  ["validate-command", "performance"]
]

describe("native business check process report admission", () => {
  it.each(routes)("rejects a successful %s report from a failed process", async (action, stage) => {
    const fixture = provider(stage, response(true, 1))
    await expect(fixture.run(action)).rejects.toThrow("AUTOBIZ_CHECK_PROCESS_RESULT_INVALID")
    expect(fixture.process.mock.calls.some(([argv]) => argv[0] === "actual-build-command")).toBe(
      false
    )
  })

  it.each(routes)("accepts a consistent successful %s process report", async (action, stage) => {
    await expect(provider(stage, response(true)).run(action)).resolves.toMatchObject({
      status: "succeeded",
      output: { passed: true }
    })
  })

  it.each(routes.filter(([action]) => action !== "code"))(
    "retains a consistent %s rule failure as failed",
    async (action, stage) => {
      await expect(provider(stage, response(false)).run(action)).resolves.toMatchObject({
        status: "failed",
        output: { passed: false }
      })
    }
  )

  it.each([
    response(false, 0),
    response(false, null),
    response(false, -1),
    { exitCode: 0, stdout: "null", stderr: "" },
    { exitCode: 0, stdout: "invalid json", stderr: "" },
    { exitCode: 0, stdout: JSON.stringify({ passed: true, errors: [] }), stderr: "" },
    {
      exitCode: 0,
      stdout: JSON.stringify({ passed: "true", errors: [], warnings: [] }),
      stderr: ""
    }
  ])("rejects malformed and contradictory process results", async (result) => {
    await expect(provider("archive", result).run("archive")).rejects.toThrow(
      "AUTOBIZ_CHECK_PROCESS_RESULT_INVALID"
    )
  })
})
