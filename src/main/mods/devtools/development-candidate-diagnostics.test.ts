import { transformSync } from "esbuild"
import { expect, it } from "vitest"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { FunctionGuestRuntime } from "../v2/guest-runtime"
import { FunctionSession } from "../v2/session"
import { FunctionSessionInitializer } from "../v2/session-initializer"
import { DevelopmentCandidateError } from "./development-candidate-diagnostics"

const target = { id: "weather-bar", revision: 4, digest: "a".repeat(64) }
const source = [
  '// on("session.start", async () => {})',
  "export function register(on) {",
  '  on("session.start", async ($) => {',
  '    await $.store.get("weather-bar.city")',
  "  })",
  "}"
].join("\n")
const files = [{ path: "mods/main.ts", text: source }]

it("locates a real missing-return startup failure in the source rather than its comment", async () => {
  const code = transformSync(source, {
    loader: "ts",
    format: "iife",
    globalName: "__cmbFunctionMod",
    target: "es2016"
  }).code
  const guest = await FunctionGuestRuntime.create(code)
  const session = new FunctionSession(
    [{ name: target.id, root: "/candidate", tier: "user", guest, capabilities: ["store.get"] }],
    {
      threadId: "candidate-diagnostics",
      workspace: "/candidate",
      initializer: new FunctionSessionInitializer(true),
      assertLive: () => {},
      publish: async (value) => value,
      state: () => ({
        get: async () => undefined,
        set: async () => {
          throw Error("UNEXPECTED_STATE_WRITE")
        },
        delete: () => {
          throw Error("UNEXPECTED_STATE_WRITE")
        },
        keys: async () => []
      })
    }
  )
  try {
    const failure = await session.start().then(
      () => {
        throw Error("EXPECTED_STARTUP_FAILURE")
      },
      (error: unknown) => error
    )
    expect(failure).toMatchObject({ code: "MODS_RETURN_UNDEFINED" })
    const result = new DevelopmentCandidateError(failure, target, files)
    expect(result.message).toBe("MODS_RETURN_UNDEFINED")
    expect(result.target).toEqual(target)
    expect(result.repairable).toBe(true)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "MODS_RETURN_UNDEFINED",
        stage: "candidate-startup",
        event: "session.start",
        file: "mods/main.ts",
        line: 3,
        column: 3,
        hint: expect.stringContaining("return next(event)")
      })
    ])
  } finally {
    await session.close()
  }
})

it("does not infer source locations from comments, strings or non-source assets", () => {
  const result = new DevelopmentCandidateError(
    new ModFunctionError("MODS_RETURN_UNDEFINED"),
    target,
    [
      {
        path: "mods/main.ts",
        text: [
          '// on("session.start", async () => {})',
          '/* on("session.start", async () => {}) */',
          "const example = 'on(\"session.start\", async () => {})'"
        ].join("\n")
      },
      { path: "README.md", text: 'on("session.start", async () => {})' }
    ]
  )
  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]).toMatchObject({ event: "session.start" })
  expect(result.diagnostics[0]).not.toHaveProperty("file")
  expect(result.diagnostics[0]).not.toHaveProperty("line")
})

it.each(["http.fetch", "store.set", "clock.every"])(
  "extracts only the known startup SDK method %s without publishing the raw message",
  (method) => {
    const secret = "PRIVATE_CREDENTIAL_82741"
    const result = new DevelopmentCandidateError(
      new ModFunctionError(
        "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED",
        `插件启动时需要 ${method}；token=${secret}`
      ),
      target,
      files
    )
    expect(result.repairable).toBe(true)
    expect(result.diagnostics[0]).toMatchObject({
      code: "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED",
      stage: "candidate-startup",
      event: "session.start",
      method
    })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(result.message).not.toContain(secret)
  }
)

it.each(["private.invoke", "http.fetch.secret", "http.fetch2"])(
  "does not infer an unlisted SDK method from %s",
  (method) => {
    const result = new DevelopmentCandidateError(
      new ModFunctionError("MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED", `插件启动时需要 ${method}；`),
      target,
      files
    )
    expect(result.diagnostics[0]).not.toHaveProperty("method")
  }
)

it.each([
  "Bearer private-credential-82741",
  "C:\\private\\credentials.json: private-credential-82741",
  "PRIVATE_CREDENTIAL_82741"
])("does not expose an arbitrary error message: %s", (secret) => {
  const result = new DevelopmentCandidateError(new Error(secret), target, files)
  expect(result.repairable).toBe(false)
  expect(result.message).not.toContain(secret)
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(result.diagnostics[0]).not.toHaveProperty("file")
})

it.each([
  "MODS_PRIVATE_UNKNOWN",
  "MODS_DEVELOPMENT_CLEANUP_UNCONFIRMED",
  "MODS_DEVELOPMENT_RETIRE_UNCONFIRMED",
  "MODS_RUNTIME_LOST"
])("does not authorize automatic source repair for %s", (code) => {
  const secret = "private-credential-82741"
  const result = new DevelopmentCandidateError(new ModFunctionError(code, secret), target, files)
  expect(result.repairable).toBe(false)
  expect(result.diagnostics[0]).toMatchObject({ stage: "candidate-startup" })
  expect(result.diagnostics[0]).not.toHaveProperty("event")
  expect(result.diagnostics[0]).not.toHaveProperty("file")
  expect(JSON.stringify(result)).not.toContain(secret)
})
