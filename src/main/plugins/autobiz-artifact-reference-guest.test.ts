import { build } from "esbuild"
import { resolve } from "node:path"
import { beforeAll, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import type { FunctionInvocation } from "../../shared/mods/v2/contracts"
import type { ModJson } from "../../shared/mods/types"
import { rules } from "../../../resources/native-compositions/autobiz-rules/mods/rules-bundle"

let program: string
const options: FunctionInvocation = {
  event: "command.run",
  origin: { plugin: "engine", tier: "core" },
  capabilities: ["process.run"],
  plugin: {
    name: "autobiz-native-rules",
    root: resolve("resources/native-compositions/autobiz-rules")
  }
}

beforeAll(async () => {
  const compiled = await build({
    stdin: {
      contents: `import { runReferencedCheck, referenceUtf8Bytes } from "./resources/native-compositions/autobiz-rules/mods/artifact-reference"
        import { rules } from "./resources/native-compositions/autobiz-rules/mods/rules-bundle"
        export function register(on) {
          on("command.run", async ($, event) => {
            if(event.texts) return { counts:event.texts.map(referenceUtf8Bytes) }
            if(event.countBytes) return { bytes:referenceUtf8Bytes("a".repeat(event.countBytes)) }
            if(event.base) return { bytes:referenceUtf8Bytes(JSON.stringify({reference:{padding:""},stage:"convert",mode:"check",rules})) }
            const reference=event.padding===undefined?event.reference:{padding:"a".repeat(event.padding)}
            return runReferencedCheck($, reference, "convert")
          })
        }`,
      resolveDir: process.cwd(),
      loader: "ts"
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "__cmbFunctionMod",
    target: "es2016"
  })
  program = compiled.outputFiles[0].text
})

it("sends the real bounded rule payload through QuickJS without allocating encoded copies", async () => {
  const guest = await FunctionGuestRuntime.create(program)
  const calls: string[] = []
  try {
    const result = await guest.invoke(
      "0",
      { reference: { protocol: "devclaw.artifact-input/v1", unicode: "中文😀\n" } },
      async (method, args) => {
        calls.push(method)
        expect(method).toBe("process.run")
        expect(Array.isArray(args)).toBe(true)
        const [argv, init] = args as [string[], { stdin: string }]
        expect(argv.slice(0, 6)).toEqual(["python", "-I", "-B", "-X", "utf8", "-c"])
        expect(Buffer.byteLength(init.stdin)).toBeGreaterThan(290_000)
        expect(Buffer.byteLength(init.stdin)).toBeLessThanOrEqual(512 * 1024)
        expect(Buffer.byteLength(JSON.stringify(args))).toBeLessThanOrEqual(1024 * 1024)
        expect(JSON.parse(init.stdin).reference.unicode).toBe("中文😀\n")
        return { value: { exitCode: 0, stdout: '{"passed":true}', stderr: "" } }
      },
      options
    )
    expect(calls).toEqual(["process.run"])
    expect(result).toEqual({ value: { exitCode: 0, stdout: '{"passed":true}', stderr: "" } })
  } finally {
    guest.dispose()
  }
})

it("counts UTF-8 exactly inside QuickJS for non-BMP, lone surrogates and escaped JSON", async () => {
  const guest = await FunctionGuestRuntime.create(program)
  const host = vi.fn(async () => ({}))
  const texts = [
    "",
    "ascii\n",
    "\u007f\u0080\u07ff\u0800\uffff",
    "中文😀𠮷",
    "\ud800",
    "\udfff",
    "\ud800x\udfff",
    "\ud800\0\udfff",
    "\ud800\n\udfff",
    "\ud800 中\udfff",
    "\ufffd\0\ufffd",
    "\ud800\ud800\udc00\udc00",
    JSON.stringify({ text: '中文😀\n"\\' })
  ]
  try {
    expect(await guest.invoke("0", { texts }, host, options)).toEqual({
      value: { counts: texts.map((text) => Buffer.byteLength(text)) }
    })
    expect(host).not.toHaveBeenCalled()
  } finally {
    guest.dispose()
  }
})

it("repeatedly sends the unchanged full rule payload within the original Guest budget", async () => {
  const reference = {
    protocol: "devclaw.artifact-input/v1",
    projectId: "repeated-reference",
    stageId: "convert",
    version: 1,
    pluginDigest: "a".repeat(64),
    workspaceIdentity: "b".repeat(64),
    current: {
      artifactId: "normalized",
      path: "NORMALIZED_REQUIREMENTS.json",
      bytes: 25_188,
      sha256: "c".repeat(64),
      maxBytes: 28_000
    },
    sources: []
  }
  const expectedStdin = JSON.stringify({ reference, stage: "convert", mode: "check", rules })
  for (let round = 0; round < 32; round++) {
    const guest = await FunctionGuestRuntime.create(program)
    const host = vi.fn(async (method: string, args: ModJson) => {
      expect(method).toBe("process.run")
      const [, init] = args as [string[], { stdin: string }]
      expect(init.stdin).toBe(expectedStdin)
      return { value: { exitCode: 0, stdout: "{}", stderr: "" } }
    })
    try {
      await guest.invoke("0", { reference }, host, options)
      expect(host).toHaveBeenCalledTimes(1)
    } finally {
      guest.dispose()
    }
  }
})

it("counts the exact 1 MiB byte boundary without enlarging Guest input or RPC limits", async () => {
  for (const countBytes of [1024 * 1024, 1024 * 1024 + 1]) {
    const guest = await FunctionGuestRuntime.create(program)
    const host = vi.fn(async () => ({}))
    try {
      expect(await guest.invoke("0", { countBytes }, host, options)).toEqual({
        value: { bytes: countBytes }
      })
      expect(host).not.toHaveBeenCalled()
    } finally {
      guest.dispose()
    }
  }
})

it("keeps the exact 512 KiB stdin boundary and rejects one extra byte before RPC", async () => {
  const guest = await FunctionGuestRuntime.create(program)
  const host = vi.fn(async (_method: string, args: ModJson) => {
    const [, init] = args as [string[], { stdin: string }]
    expect(Buffer.byteLength(init.stdin)).toBe(512 * 1024)
    return { value: { exitCode: 0, stdout: "{}", stderr: "" } }
  })
  try {
    const base = await guest.invoke("0", { base: true }, host, options)
    const padding = 512 * 1024 - (base.value as { bytes: number }).bytes
    await guest.invoke("0", { padding }, host, options)
    expect(host).toHaveBeenCalledTimes(1)
    await expect(guest.invoke("0", { padding: padding + 1 }, host, options)).rejects.toThrow(
      "ARTIFACT_REFERENCE_STDIN_LIMIT"
    )
    expect(host).toHaveBeenCalledTimes(1)
  } finally {
    guest.dispose()
  }
})
