/**
 * Unit tests for opt-in user context injection in hooks.
 *
 * Run with:
 *   npx tsx tests/hook-user-context.spec.ts
 */
import assert from "node:assert/strict"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { buildHookResultRecord } from "../src/main/hooks/log-record.ts"
import { runHooks } from "../src/main/hooks/runner.ts"
import type { HookConfig, HookResult } from "../src/main/hooks/types.ts"
import { saveHookLoggingConfig } from "../src/main/storage.ts"

const userInfoPath = join(homedir(), ".cmbcoworkagent", "userinfo-models.json")
const hookLoggingPath = join(homedir(), ".cmbcoworkagent", "hook-logging.json")

function nodeCommand(script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64")
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
}

function makeHook(partial: Partial<HookConfig>): HookConfig {
  return {
    id: partial.id ?? "hook-user-context",
    event: partial.event ?? "PreToolUse",
    matcher: partial.matcher,
    type: "command",
    command: partial.command ?? "node -e \"process.exit(0)\"",
    timeout: 8000,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial
  }
}

async function withBackedUpJsonFile<T>(
  filePath: string,
  body: () => Promise<T>
): Promise<T> {
  const hadOriginal = existsSync(filePath)
  const original = hadOriginal ? readFileSync(filePath) : null
  try {
    return await body()
  } finally {
    if (hadOriginal && original) {
      writeFileSync(filePath, original)
    } else if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
  }
}

async function withUserInfo<T>(body: () => Promise<T>): Promise<T> {
  await mkdir(dirname(userInfoPath), { recursive: true })
  return withBackedUpJsonFile(userInfoPath, async () => {
    writeFileSync(
      userInfoPath,
      JSON.stringify(
        {
          sapId: "sap-001",
          ystId: "yst-002",
          userName: "张三",
          originOrgId: "org-003",
          orgName: "研发部",
          pathName: "总部/研发部",
          originPathId: "path-004",
          ystIdToken: "secret-token"
        },
        null,
        2
      )
    )
    return body()
  })
}

async function withHookLoggingConfig<T>(body: () => Promise<T>): Promise<T> {
  await mkdir(dirname(hookLoggingPath), { recursive: true })
  return withBackedUpJsonFile(hookLoggingPath, async () => {
    saveHookLoggingConfig({ enabled: true, diagnostic: true })
    try {
      return await body()
    } finally {
      saveHookLoggingConfig({ enabled: false, diagnostic: false })
    }
  })
}

async function testDefaultDoesNotInjectUserContext(): Promise<void> {
  await withUserInfo(async () => {
    const dir = await mkdtemp(join(tmpdir(), "hook-user-context-default-"))
    try {
      const out = join(dir, "observed.json")
      const hook = makeHook({
        command: nodeCommand(`
const fs = require("fs")
let input = ""
process.stdin.on("data", (chunk) => { input += chunk })
process.stdin.on("end", () => {
  const payload = JSON.parse(input)
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({
    userContext: payload.user_context ?? null,
    envSap: process.env.HOOK_USER_SAP_ID ?? null,
    envToken: process.env.HOOK_USER_YST_ID_TOKEN ?? null
  }))
})
`)
      })
      await runHooks([hook], "PreToolUse", { toolName: "execute" })
      const observed = JSON.parse(await readFile(out, "utf8")) as Record<string, unknown>
      assert.equal(observed.userContext, null)
      assert.equal(observed.envSap, null)
      assert.equal(observed.envToken, null)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

async function testOptInInjectsSelectedUserContext(): Promise<void> {
  await withUserInfo(async () => {
    const dir = await mkdtemp(join(tmpdir(), "hook-user-context-enabled-"))
    try {
      const out = join(dir, "observed.json")
      const hook = makeHook({
        injectUserContext: {
          enabled: true,
          include: ["sap_id", "name", "yst_id_token"]
        },
        command: nodeCommand(`
const fs = require("fs")
let input = ""
process.stdin.on("data", (chunk) => { input += chunk })
process.stdin.on("end", () => {
  const payload = JSON.parse(input)
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({
    userContext: payload.user_context,
    envSap: process.env.HOOK_USER_SAP_ID ?? null,
    envName: process.env.HOOK_USER_NAME ?? null,
    envToken: process.env.HOOK_USER_YST_ID_TOKEN ?? null
  }))
})
`)
      })
      await runHooks([hook], "PreToolUse", { toolName: "execute" })
      const observed = JSON.parse(await readFile(out, "utf8")) as {
        userContext: Record<string, string>
        envSap: string | null
        envName: string | null
        envToken: string | null
      }
      assert.equal(observed.userContext.sap_id, "sap-001")
      assert.equal(observed.userContext.name, "张三")
      assert.equal(observed.userContext.yst_id_token, "secret-token")
      assert.equal(observed.envSap, "sap-001")
      assert.equal(observed.envName, "张三")
      assert.equal(observed.envToken, null)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

async function testDiagnosticPayloadRedactsToken(): Promise<void> {
  await withUserInfo(async () => {
    await withHookLoggingConfig(async () => {
      const hook = makeHook({
        injectUserContext: {
          enabled: true,
          include: ["sap_id", "yst_id_token"]
        },
        command: nodeCommand("process.stdin.resume()")
      })
      let envelope: ReturnType<typeof buildHookResultRecord> | null = null
      await runHooks([hook], "PreToolUse", { toolName: "execute", turnId: "turn-1" }, (event, h, result) => {
        envelope = buildHookResultRecord(event, h, result as HookResult, "turn-1")
      })
      assert(envelope?.stdinPayload, "diagnostic envelope should include stdinPayload")
      assert(envelope.stdinPayload.includes("sap-001"))
      assert(envelope.stdinPayload.includes("[redacted]"))
      assert(!envelope.stdinPayload.includes("secret-token"))
    })
  })
}

async function run(): Promise<void> {
  await testDefaultDoesNotInjectUserContext()
  await testOptInInjectsSelectedUserContext()
  await testDiagnosticPayloadRedactsToken()
  console.log("PASS hook user context injection")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  console.error(error.stack)
  process.exit(1)
})
