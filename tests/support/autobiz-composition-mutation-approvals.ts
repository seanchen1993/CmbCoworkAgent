/** Deterministic presentation decisions for real native process approvals, after exact review. */
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { ElectronApplication } from "playwright"
import type { FunctionProcessRequest } from "../../src/main/mods/v2/process-sdk"
import { sha256 } from "./autobiz-composition-mutation-fixture"

type Pending = { id: number; title: string; detail: string; message: string; buttons: string[] }

export async function mutationProcessApprovals(input: {
  app: ElectronApplication
  root: string
  isolated: string
  artifacts?: string
  maven: string
  record: (value: Record<string, unknown>) => void
}) {
  const { app } = input
  const reviews = join(input.artifacts ?? input.isolated, "native-process-reviews")
  mkdirSync(reviews)
  const userData = await app.evaluate(({ app, dialog }, reviews) => {
    const fs = process.getBuiltinModule("fs")
    const path = process.getBuiltinModule("path")
    let sequence = 0
    const original = dialog.showMessageBox
    dialog.showMessageBox = ((...args: unknown[]) => {
      const options = args.at(-1) as Pending & { signal?: AbortSignal }
      if (options.title !== "批准插件运行本机命令") return Reflect.apply(original, dialog, args)
      const id = ++sequence
      fs.writeFileSync(
        path.join(reviews, `${id}.proposal.json`),
        JSON.stringify({
          id,
          title: options.title,
          detail: options.detail,
          message: options.message,
          buttons: options.buttons
        }),
        { flag: "wx" }
      )
      return new Promise((decide) => {
        const timer = setInterval(() => {
          const decision = path.join(reviews, `${id}.approved.json`)
          if (options.signal?.aborted) {
            clearInterval(timer)
            decide({ response: 0 })
            return
          }
          if (!fs.existsSync(decision)) return
          const value = JSON.parse(fs.readFileSync(decision, "utf8"))
          const digest = /完整请求 SHA-256：([a-f0-9]{64})/.exec(options.detail)?.[1]
          clearInterval(timer)
          decide({ response: value.approved === true && value.digest === digest ? 1 : 0 })
        }, 100)
      })
    }) as typeof dialog.showMessageBox
    return app.getPath("userData")
  }, reviews)
  const knownScripts = [
    ["autobiz-rules/mods/main.ts", /const bootstrap = `([\s\S]*?)`/],
    [
      "autobiz-rules/mods/artifact-reference.ts",
      /export const referenceBootstrap = String.raw`([\s\S]*?)`/
    ],
    ["test-verification/mods/runner.ts", /export const runnerBootstrap = String.raw`([\s\S]*?)`/]
  ] as const
  const scriptDigests = knownScripts.map(([file, matcher]) => {
    const value = matcher.exec(
      readFileSync(join(input.root, "resources/native-compositions", file), "utf8")
    )?.[1]
    assert(value, `Pinned native process script missing: ${file}`)
    return sha256(value)
  })
  const done = new Set<number>()
  return async () => {
    const pending = readdirSync(reviews)
      .filter((name) => /^\d+\.proposal\.json$/.test(name))
      .map((name) => JSON.parse(readFileSync(join(reviews, name), "utf8")) as Pending)
    for (const approval of pending) {
      if (done.has(approval.id)) continue
      assert(approval.id <= 96, "Bounded native process review count")
      assert.deepEqual(approval.buttons, ["拒绝", "允许本次命令", "查看完整请求"])
      const digest = /完整请求 SHA-256：([a-f0-9]{64})/.exec(approval.detail)?.[1]
      assert(digest, "Actual original approval digest required")
      const files = readdirSync(userData)
        .filter((name) => /^cmb-process-review-/.test(name))
        .map((name) => join(userData, name, "request.json"))
      const reviewed = files
        .map((path) => ({ path, bytes: readFileSync(path, "utf8") }))
        .filter(({ bytes }) => sha256(bytes) === digest)
      assert.equal(reviewed.length, 1, "Native frozen request must match the displayed digest once")
      const request = JSON.parse(reviewed[0].bytes) as FunctionProcessRequest
      const below = relative(input.isolated, resolve(request.cwd))
      assert(below && !below.startsWith("..") && !isAbsolute(below), "Review only owned isolation")
      const argv = [...request.argv]
      let category: string
      if (argv[0] === "python" && argv[1] === "-I") {
        assert.deepEqual(argv.slice(0, 6), ["python", "-I", "-B", "-X", "utf8", "-c"])
        assert.equal(argv.length, 7)
        assert(
          scriptDigests.slice(0, 2).includes(sha256(argv[6])),
          "Original approved Python checker only"
        )
        category = "original-python-checker"
      } else if (argv[0] === "node") {
        assert.equal(argv[1], "-")
        assert.equal(argv.length, 3)
        assert.equal(
          sha256(request.input ?? ""),
          scriptDigests[2],
          "Original fixed Node runner only"
        )
        const value = JSON.parse(argv[2])
        assert(["execute", "reference"].includes(value.mode), "Known native runner mode")
        category = "original-node-test-reporter"
      } else if (argv[0] === "git") {
        assert(
          ["rev-parse", "status", "diff", "ls-files"].includes(argv[1]),
          "Read-only Git inspection only"
        )
        category = "native-readonly-git-check"
      } else if (resolve(argv[0]) === resolve(input.maven)) {
        assert.deepEqual(argv.slice(1), ["-q", "-o", "compile"])
        category = "actual-maven-production-compile"
      } else {
        assert.deepEqual(argv.slice(0, 4), ["python", "-B", "-m", "unittest"])
        assert.equal(argv.length, 5)
        assert(["test_orders.py", "test_e2e.py"].includes(argv[4]))
        category = "actual-python-behavior-tests"
      }
      input.record({
        type: "native-process-approval",
        at: Date.now(),
        id: approval.id,
        category,
        requestDigest: digest,
        cwd: request.cwd,
        argv: argv.map((arg) => (arg.length > 300 ? `sha256:${sha256(arg)}` : arg)),
        inputBytes: Buffer.byteLength(request.input ?? ""),
        inputSha256: sha256(request.input ?? ""),
        presentation: "deterministic native dialog decision after exact frozen request review"
      })
      writeFileSync(
        join(reviews, `${approval.id}.approved.json`),
        JSON.stringify({ approved: true, digest }),
        { flag: "wx" }
      )
      done.add(approval.id)
    }
  }
}
