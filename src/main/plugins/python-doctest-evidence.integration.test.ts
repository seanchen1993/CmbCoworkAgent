import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
import { runAutoBizLeanCodeFixture } from "./autobiz-lean-code.test-helper"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it("replaces the entire execution provider with real Python doctest through unchanged workflow and code.verify", async () => {
  const result = await runAutoBizLeanCodeFixture({
    cleanup,
    executionAdapter: "python-doctest/v1",
    deliveryRoot: resolve("resources/native-compositions/python-doctest-evidence"),
    deliveryProviderId: "independent-python-proof",
    productionPaths: ["src/orders.py", "src/validation.py"],
    authorFixture: async (request, cwd) => {
      if (request.label.endsWith("-implement")) {
        await mkdir(join(cwd, "src"), { recursive: true })
        await writeFile(
          join(cwd, "src/validation.py"),
          "def valid(key):\n    return isinstance(key, str) and key == '42'\n"
        )
        await writeFile(
          join(cwd, "src/orders.py"),
          "from validation import valid\ndef lookup(key):\n    return {'id': key} if valid(key) else None\n"
        )
        return { compileArgv: ["python", "-m", "py_compile", "src/orders.py"] }
      }
      if (request.label.endsWith("-review")) return { verdict: "pass", findings: [] }
      if (!request.label.endsWith("-test-author") && !request.label.endsWith("-e2e-author"))
        throw Error("UNEXPECTED_DOCTEST_AUTHOR_STEP:" + request.label)
      const name = request.label.endsWith("-e2e-author")
        ? "tests/e2e.doctest"
        : "tests/orders.doctest"
      await mkdir(join(cwd, "tests"), { recursive: true })
      await writeFile(
        join(cwd, name),
        ">>> from orders import lookup\n>>> lookup('42')\n{'id': '42'}\n>>> lookup('missing') is None\nTrue\n>>> lookup(None) is None\nTrue\n"
      )
      return {
        testInput: {
          files: [name],
          subjects: ["src/orders.py", "src/validation.py"],
          timeoutMs: 10000
        }
      }
    }
  })
  expect(result.evidenceRoute).toBe("standalone-unbound")
  const actions = result.actionFacts
  if (!actions || !result.processes) throw Error("FULL_ORIGINAL_EVIDENCE_REQUIRED")
  const tests = actions.filter((fact) => ["test", "e2e"].includes(String(fact.output?.phase)))
  expect(tests).toHaveLength(2)
  for (const fact of tests) {
    expect(fact).toMatchObject({ provider: { plugin: "python-doctest-evidence" } })
    expect(fact.output?.test).toMatchObject({
      runner: "python-doctest/v1",
      counts: { total: 4, passed: 4, failed: 0, skipped: 0 },
      subjects: ["src/orders.py", "src/validation.py"]
    })
  }
  expect(
    result.processes.filter(
      (argv) => argv[0] === "python" && argv.some((arg) => arg.includes("py_compile.compile"))
    )
  ).toHaveLength(2)
}, 180000)
