import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { businessInput } from "./autobiz-native-fixture.test-helper"

const scanner = resolve("resources/native-compositions/autobiz/hooks/check-secrets.py")
const scan = (tool_input: unknown) =>
  spawnSync("python", ["-I", "-B", "-X", "utf8", scanner], {
    input: JSON.stringify({ tool_input }),
    encoding: "utf8"
  })

describe("retained AutoBiz write protection", () => {
  it("matches the original pinned secret predicates while suppressing its value-bearing debug output", () => {
    const lines = [
      "password: fixture-plaintext-secret",
      "redis.auth=fixture-plaintext-secret",
      "sasl.jaas.config: fixture-plaintext-secret",
      "password: ${SERVICE_PASSWORD}",
      "password: ENC(encrypted-fixture)",
      "password=***",
      "publickey=public-fixture",
      "normal=value"
    ]
    const original = resolve(
      "tests/fixtures/native-compositions/legacy-reference/check-secrets-new.py"
    )
    expect(createHash("sha256").update(readFileSync(original)).digest("hex")).toBe(
      "38214433b6e305974e81a35c5768f98b6ddd199421c56395c58de6ae90662d2f"
    )
    const reference = spawnSync(
      "python",
      [
        "-I",
        "-B",
        "-X",
        "utf8",
        "-c",
        "import contextlib,io,json,runpy,sys;ns=runpy.run_path(sys.argv[1]);lines=json.loads(sys.stdin.read());capture=io.StringIO()\nwith contextlib.redirect_stderr(capture):\n result=[bool(ns['check_line'](line)) for line in lines]\nprint(json.dumps(result))",
        original
      ],
      {
        input: JSON.stringify(lines),
        encoding: "utf8"
      }
    )
    expect(reference.status, reference.stderr).toBe(0)
    expect(reference.stderr).toBe("")
    expect(
      lines.map((content) => scan({ filePath: "application.yaml", content }).status === 2)
    ).toEqual(JSON.parse(reference.stdout))
  })
  it.each([
    { filePath: "application.yaml", content: "password: fixture-plaintext-secret" },
    { filePath: "application.properties", newString: "redis.auth=fixture-plaintext-secret" },
    { file_path: "application.yml", new_string: "sasl.jaas.config: fixture-plaintext-secret" }
  ])(
    "blocks original secret rules for write/edit without exposing the candidate value",
    (input) => {
      const result = scan(input)
      expect(result.status).toBe(2)
      expect(result.stdout + result.stderr).not.toContain("fixture-plaintext-secret")
      expect(result.stdout).toContain("AUTOBIZ_SECRET_WRITE_GUARD_BLOCKED")
    }
  )

  it.each([
    { filePath: "application.yaml", content: "password: ${SERVICE_PASSWORD}" },
    { filePath: "application.yaml", newString: "password: ENC(encrypted-fixture)" },
    {
      filePath: "application.properties",
      content: "password=***\npublickey=public-fixture\nnormal=value"
    },
    { filePath: "Orders.java", content: "public class Orders {}" }
  ])("accepts original exemptions and ordinary supported writes", (input) => {
    expect(scan(input).status).toBe(0)
  })

  it.each([
    {},
    null,
    { filePath: "a.yaml", patch: "*** Add File: a.yaml\n+password: x" },
    { filePath: "a.yaml", content: 123 }
  ])("fails closed for malformed or unsupported patch input", (input) => {
    expect(scan(input).status).toBe(2)
  })
})

it("retains the original UT task/criteria contract and rejects incomplete repair evidence", () => {
  const receipt = {
    executionId: "native-receipt-fixture",
    status: "failed",
    outputTruncated: false,
    output: {
      passed: false,
      phase: "test",
      workspaceRef: "default",
      exitCode: 1,
      logTruncated: false,
      testFiles: ["test_orders.py"],
      taskIds: ["T001"],
      argv: ["python", "-m", "unittest", "test_orders.py"],
      headCommit: "a".repeat(40)
    }
  }
  const check = (candidate: unknown) => {
    const result = spawnSync(
      "python",
      [
        "-I",
        "-B",
        "-X",
        "utf8",
        "-c",
        "import sys,json;sys.path.insert(0,sys.argv[1]);from check import run;print(json.dumps(run(json.loads(sys.stdin.read()))))",
        resolve("resources/native-compositions/autobiz-rules/checks")
      ],
      {
        input: JSON.stringify({
          stage: "repair-evidence",
          plan: businessInput().plan,
          receipt: candidate
        }),
        encoding: "utf8"
      }
    )
    return result
  }
  const valid = check(receipt)
  expect(valid.status, valid.stderr).toBe(0)
  expect(JSON.parse(valid.stdout)).toMatchObject({
    passed: true,
    failedExecutionId: receipt.executionId,
    errors: [],
    warnings: [],
    attestations: [{ taskId: "T001", targetId: "UT-001", covers: ["AC-T001-01"] }]
  })
  for (const patch of [
    { exitCode: 0 },
    { exitCode: null },
    { logTruncated: true },
    { testFiles: [] },
    { taskIds: ["T999"] },
    { workspaceRef: "unrelated" }
  ]) {
    expect(check({ ...receipt, output: { ...receipt.output, ...patch } }).status).not.toBe(0)
  }
})
