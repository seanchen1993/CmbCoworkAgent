import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RequirementCredentialStore, type RequirementSafeStorage } from "./credential-store"
import { LeanstarRequirementGateway } from "./leanstar-gateway"
import {
  RequirementPublishService,
  readRequirementPublishInput,
  type RequirementPublisher
} from "./publisher"
import type { PreparedRequirementPublish } from "../../../shared/requirement-credentials"

const SENTINEL = "F02_FAKE_CREDENTIAL_NEVER_LOGGED+/="
let root: string, indexPath: string, directory: string
let storage: RequirementSafeStorage, credentials: RequirementCredentialStore
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "f02-security-"))
  indexPath = path.join(root, "requirements", "index.json")
  directory = path.join(root, "private-profile", "credentials")
  const ciphers = new Map<string, string>()
  storage = {
    isEncryptionAvailable: () => true,
    encryptString: (token) => {
      const cipher = randomUUID()
      ciphers.set(cipher, token)
      return Buffer.from(cipher)
    },
    decryptString: (cipher) => {
      const token = ciphers.get(cipher.toString())
      if (!token) throw new Error(SENTINEL)
      return token
    }
  }
  credentials = makeStore()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})
function makeStore(
  overrides: Partial<ConstructorParameters<typeof RequirementCredentialStore>[0]> = {}
): RequirementCredentialStore {
  return new RequirementCredentialStore({
    directory,
    legacyIndexPath: () => indexPath,
    safeStorage: storage,
    platform: "darwin",
    ...overrides
  })
}
async function legacy(): Promise<string> {
  const bytes = JSON.stringify({ token: SENTINEL, list: [], lastWorkDir: "fake-dir" })
  await fs.mkdir(path.dirname(indexPath), { recursive: true })
  await fs.writeFile(indexPath, bytes)
  return bytes
}
async function save(): Promise<string> {
  const result = await credentials.save(SENTINEL)
  expect(result.success).toBe(true)
  if (!result.success || !result.credentialRef) throw new Error("fake storage setup failed")
  return result.credentialRef
}

describe("OS-backed requirement credential boundary", () => {
  it("persists ciphertext outside workspace, tightens permissions, exposes only reference/status", async () => {
    const ref = await save()
    const status = await credentials.status()
    expect(status).toMatchObject({
      success: true,
      configured: true,
      available: true,
      credentialRef: ref
    })
    expect(JSON.stringify(status).includes(SENTINEL)).toBe(false)
    expect(
      (await fs.readFile(path.join(directory, "leanstar.json"), "utf8")).includes(SENTINEL)
    ).toBe(false)
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(directory, "leanstar.json"))).mode & 0o777).toBe(0o600)
    await expect(fs.stat(indexPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(credentials.consume("cred-unknown", async () => null)).rejects.toMatchObject({
      code: "UNKNOWN_CREDENTIAL"
    })
  })
  it.each(["basic_text", "unknown", "unsupported", ""])(
    "refuses insecure Linux backend %s",
    async (backend) => {
      const store = makeStore({
        platform: "linux",
        safeStorage: { ...storage, getSelectedStorageBackend: () => backend }
      })
      expect(await store.save(SENTINEL)).toMatchObject({ code: "STORAGE_UNAVAILABLE" })
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" })
    }
  )
  it("R1: preserves exact original bytes, refuses edits and creates no plaintext temp on migration failure", async () => {
    const original = await legacy()
    const write = vi.fn(fs.writeFile)
    const store = makeStore({
      safeStorage: { ...storage, isEncryptionAvailable: () => false },
      filesystem: { ...fs, writeFile: write } as typeof fs
    })
    expect(await store.status()).toMatchObject({ code: "MIGRATION_FAILED" })
    await expect(
      store.updateLegacyIndex((index) => ({ ...index, list: [{ reqId: "new" }] }))
    ).rejects.toMatchObject({ code: "MIGRATION_FAILED" })
    expect(await store.save("NEW_FAKE_CREDENTIAL")).toMatchObject({ code: "MIGRATION_FAILED" })
    expect((await fs.readFile(indexPath, "utf8")) === original).toBe(true)
    expect(write).not.toHaveBeenCalled()
    await expect(store.consume("cred-any", async () => true)).rejects.toMatchObject({
      code: "MIGRATION_FAILED"
    })
  })
  it("serializes migration, concurrent saves and stale edits without reintroducing plaintext", async () => {
    await legacy()
    await Promise.all([
      credentials.status(),
      credentials.save("NEW_FAKE_CREDENTIAL"),
      credentials.updateLegacyIndex((index) => ({
        ...index,
        token: SENTINEL,
        list: [{ reqId: "new" }]
      })),
      credentials.save("LAST_FAKE_CREDENTIAL")
    ])
    const index = await fs.readFile(indexPath, "utf8")
    expect(index.includes(SENTINEL)).toBe(false)
    expect(JSON.parse(index)).not.toHaveProperty("token")
    const status = await credentials.status()
    if (!status.success || !status.credentialRef) throw new Error("status setup failed")
    await credentials.consume(status.credentialRef, async (token) => {
      expect(token === "LAST_FAKE_CREDENTIAL").toBe(true)
    })
  })
  it("handles corrupt ciphertext and permission errors with fixed safe codes", async () => {
    await save()
    await fs.writeFile(
      path.join(directory, "leanstar.json"),
      JSON.stringify({ version: 1, credentialRef: "cred-fake", ciphertext: "bad" })
    )
    expect(await credentials.status()).toMatchObject({ code: "CORRUPT_CREDENTIAL" })
    const denied = makeStore({
      filesystem: {
        ...fs,
        chmod: async () => {
          throw new Error(SENTINEL)
        }
      } as typeof fs
    })
    const result = await denied.save(SENTINEL)
    expect(result).toMatchObject({ code: "STORAGE_FAILURE" })
    expect(JSON.stringify(result).includes(SENTINEL)).toBe(false)
  })
  it("keeps the sole legacy copy if encryption verification or index cleanup fails", async () => {
    const original = await legacy()
    const broken = makeStore({
      safeStorage: {
        ...storage,
        decryptString: () => {
          throw new Error(SENTINEL)
        }
      }
    })
    expect(await broken.status()).toMatchObject({ code: "MIGRATION_FAILED" })
    expect((await fs.readFile(indexPath, "utf8")) === original).toBe(true)
    const rename = vi.fn(
      async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
        if (to === indexPath) throw new Error(SENTINEL)
        return fs.rename(from, to)
      }
    )
    expect(await makeStore({ filesystem: { ...fs, rename } as typeof fs }).status()).toMatchObject({
      code: "MIGRATION_FAILED"
    })
    expect((await fs.readFile(indexPath, "utf8")) === original).toBe(true)
    expect(
      (await fs.readdir(path.dirname(indexPath))).filter((name) => name.endsWith(".tmp"))
    ).toEqual([])
  })
})

describe("fixed Leanstar read-only gateway", () => {
  const queries = [
    { operation: "listDigitalProducts" },
    { operation: "listProductRequirements", domainId: "org-a", domainType: "ORG" },
    { operation: "getImplementationDetail", code: "P2603-1" },
    { operation: "getRequirementDetail", code: "P2603-1" },
    { operation: "getRequirementDocumentContent", code: "P2603-1" },
    { operation: "getNamespaceTree" }
  ]
  function gateway(
    fakeFetch: typeof fetch,
    extra: Partial<ConstructorParameters<typeof LeanstarRequirementGateway>[0]> = {}
  ): LeanstarRequirementGateway {
    return new LeanstarRequirementGateway({
      credentials,
      gatewayUrl: () => "https://gateway.example.test/base",
      fetch: fakeFetch,
      ...extra
    })
  }
  it("preserves six operations with main-only credentials, fixed methods and fixed bodies", async () => {
    await save()
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! })
      return Response.json({ body: { content: [{ code: "safe" }], total: 1 } })
    }) as typeof fetch
    for (const query of queries) {
      const result = await gateway(fakeFetch).query(query)
      expect(result).toMatchObject({ success: true, data: { body: { total: 1 } } })
      expect(JSON.stringify(result).includes(SENTINEL)).toBe(false)
    }
    expect(calls.map((call) => call.url.replace("https://gateway.example.test/base", ""))).toEqual([
      "/api/requirement/digital-products/person/page",
      "/api/requirement/product-requirements/page",
      "/api/requirement/product-requirements/P2603-1/impl-detail",
      "/api/requirement/product-requirements/P2603-1/detail",
      "/api/requirement/document-content/P2603-1",
      "/api/leanstar/namespaces/tree"
    ])
    expect(calls.map((call) => call.init.method)).toEqual([
      "POST",
      "POST",
      "GET",
      "GET",
      "GET",
      "GET"
    ])
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ pageIndex: 1, pageSize: 50 })
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      pageIndex: 1,
      pageSize: 15,
      domain: { id: "org-a", type: "ORG" }
    })
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>)["Ls-Access-Token"] === SENTINEL).toBe(
        true
      )
      expect(call.init.redirect).toBe("error")
    }
  })
  it("does not call fetch when credentials are missing", async () => {
    const fakeFetch = vi.fn() as typeof fetch
    expect(await gateway(fakeFetch).query(queries[0])).toMatchObject({ code: "CREDENTIAL_MISSING" })
    expect(fakeFetch).not.toHaveBeenCalled()
  })
  it.each([
    { operation: "arbitrary", url: "https://evil.test" },
    { operation: "getNamespaceTree", headers: {} },
    { operation: "getNamespaceTree", method: "DELETE" },
    { operation: "getNamespaceTree", body: {} },
    { operation: "getRequirementDetail", code: "../private" },
    { operation: "getRequirementDetail", code: "x?inject=true" },
    { operation: "getRequirementDetail", code: "https://evil.test" }
  ])("rejects payload injection before fetch", async (query) => {
    const fakeFetch = vi.fn() as typeof fetch
    expect(await gateway(fakeFetch).query(query)).toMatchObject({ code: "INVALID_INPUT" })
    expect(fakeFetch).not.toHaveBeenCalled()
  })
  it.each([
    "",
    "http://gateway.test",
    "https://user:pass@gateway.test",
    "https://gateway.test?x=1",
    "https://gateway.test#x",
    "https://gateway.test?",
    "https://gateway.test#"
  ])("rejects invalid gateway %s", async (url) => {
    const fakeFetch = vi.fn() as typeof fetch
    expect(await gateway(fakeFetch, { gatewayUrl: () => url }).query(queries[0])).toMatchObject({
      code: "GATEWAY_UNAVAILABLE"
    })
    expect(fakeFetch).not.toHaveBeenCalled()
  })
  it.each([401, 403, 500, 302])("does not echo upstream error at status %s", async (status) => {
    await save()
    const result = await gateway(
      vi.fn(async () => new Response(SENTINEL, { status, statusText: SENTINEL })) as typeof fetch
    ).query(queries[0])
    expect(result).toMatchObject({
      code: status === 401 || status === 403 ? "CREDENTIAL_INVALID" : "UPSTREAM_FAILURE"
    })
    expect(JSON.stringify(result).includes(SENTINEL)).toBe(false)
  })
  it("bounds malformed, large, redirected, throwing and stalled responses", async () => {
    await save()
    for (const [response, code] of [
      [new Response("x"), "INVALID_RESPONSE"],
      [new Response("0123456789"), "RESPONSE_TOO_LARGE"],
      [new Response("{}", { headers: { "Content-Length": "100" } }), "RESPONSE_TOO_LARGE"]
    ] as const) {
      expect(
        await gateway(vi.fn(async () => response) as typeof fetch, { maxResponseBytes: 5 }).query(
          queries[0]
        )
      ).toMatchObject({ code })
    }
    const redirected = Response.json({ safe: true })
    Object.defineProperty(redirected, "redirected", { value: true })
    expect(
      await gateway(vi.fn(async () => redirected) as typeof fetch).query(queries[0])
    ).toMatchObject({ code: "UPSTREAM_FAILURE" })
    const failure = await gateway(
      vi.fn(async () => {
        throw new Error(SENTINEL)
      }) as typeof fetch
    ).query(queries[0])
    expect(failure).toMatchObject({ code: "NETWORK_FAILURE" })
    expect(JSON.stringify(failure).includes(SENTINEL)).toBe(false)
    expect(
      await gateway(vi.fn(async () => new Promise<Response>(() => {})) as typeof fetch, {
        timeoutMs: 5
      }).query(queries[0])
    ).toMatchObject({ code: "TIMEOUT" })
  })
  it.each(["raw", "url", "base64"])(
    "blocks successful nested %s credential echoes",
    async (encoding) => {
      await save()
      const echo =
        encoding === "raw"
          ? SENTINEL
          : encoding === "url"
            ? encodeURIComponent(SENTINEL)
            : Buffer.from(SENTINEL).toString("base64")
      if (encoding !== "raw") expect(echo === SENTINEL).toBe(false)
      const result = await gateway(
        vi.fn(async () => Response.json({ body: [{ echo }] })) as typeof fetch
      ).query(queries[0])
      expect(result).toMatchObject({ code: "SECRET_ECHO" })
      expect(JSON.stringify(result).includes(SENTINEL)).toBe(false)
    }
  )
})

describe("explicit publication approval and process-local idempotency", () => {
  let record: {
    reqId: string
    threadIds: string[]
    systemId: string
    title: string
    requirementPath: string
  }
  let now: number
  beforeEach(async () => {
    await save()
    now = 1000
    record = {
      reqId: "req-a",
      threadIds: ["thread-a", "thread-b"],
      systemId: "system-a",
      title: "fake title",
      requirementPath: path.join(root, "workspace")
    }
    await fs.mkdir(path.join(record.requirementPath, "prd"), { recursive: true })
    await fs.writeFile(
      path.join(record.requirementPath, "prd", "prd-manifest.json"),
      JSON.stringify({ prd: { status: "generated", file: "formal.md" }, functions: [] })
    )
    await fs.writeFile(
      path.join(record.requirementPath, "prd", "formal.md"),
      "# Formal PRD\n\nApproved content."
    )
  })
  function service(
    publisher?: RequirementPublisher,
    extra: Partial<ConstructorParameters<typeof RequirementPublishService>[0]> = {}
  ): RequirementPublishService {
    return new RequirementPublishService({
      credentials,
      publisher,
      now: () => now,
      findRequirement: async (id) => (id === record.reqId ? record : undefined),
      ...extra
    })
  }
  async function prepare(
    publishing: RequirementPublishService,
    threadId = "thread-a"
  ): Promise<PreparedRequirementPublish> {
    const result = await publishing.prepare({ reqId: "req-a", threadId })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("fake approval setup failed")
    return result.approval
  }
  it("production connector is unavailable and does not change the manifest", async () => {
    const original = await fs.readFile(
      path.join(record.requirementPath, "prd", "prd-manifest.json"),
      "utf8"
    )
    expect(await service().prepare({ reqId: "req-a", threadId: "thread-a" })).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE"
    })
    expect(
      await fs.readFile(path.join(record.requirementPath, "prd", "prd-manifest.json"), "utf8")
    ).toBe(original)
  })
  it("requires exact approval and shares concurrent same-command results without exposing credentials", async () => {
    const publish: RequirementPublisher["publish"] = vi.fn(async (input, token) => {
      expect(token === SENTINEL).toBe(true)
      expect(input.files[0].bytes.toString()).toContain("Approved content")
      return { outcome: "published" as const }
    })
    const publishing = service({ publish })
    expect(await publishing.confirm({ commandId: "no-approval" })).toMatchObject({
      code: "INVALID_INPUT"
    })
    const approval = await prepare(publishing)
    expect(JSON.stringify(approval).includes(SENTINEL)).toBe(false)
    const command = { ...approval, commandId: "command-a" }
    const results = await Promise.all([publishing.confirm(command), publishing.confirm(command)])
    expect(results).toEqual([
      { success: true, published: true },
      { success: true, published: true }
    ])
    expect(publish).toHaveBeenCalledTimes(1)
    expect(await publishing.confirm({ ...command, threadId: "thread-b" })).toMatchObject({
      code: "COMMAND_CONFLICT"
    })
    expect(JSON.stringify(results).includes(SENTINEL)).toBe(false)
  })
  it("rejects unbound/cross-requirement input, caller paths, traversal and symlink escape", async () => {
    const publishing = service({ publish: vi.fn() })
    expect(await publishing.prepare({ reqId: "req-a", threadId: "foreign" })).toMatchObject({
      code: "REQUIREMENT_UNAVAILABLE"
    })
    expect(await publishing.prepare({ reqId: "foreign", threadId: "thread-a" })).toMatchObject({
      code: "REQUIREMENT_UNAVAILABLE"
    })
    expect(
      await publishing.prepare({ reqId: "req-a", threadId: "thread-a", path: "/private" })
    ).toMatchObject({ code: "INVALID_INPUT" })
    for (const file of ["../outside.md", path.join(root, "outside.md")]) {
      await fs.writeFile(
        path.join(record.requirementPath, "prd", "prd-manifest.json"),
        JSON.stringify({ prd: { status: "generated", file } })
      )
      expect(await publishing.prepare({ reqId: "req-a", threadId: "thread-a" })).toMatchObject({
        code: "PRD_UNAVAILABLE"
      })
    }
    await fs.writeFile(path.join(root, "outside.md"), "outside")
    await fs.symlink(
      path.join(root, "outside.md"),
      path.join(record.requirementPath, "prd", "link.md")
    )
    await fs.writeFile(
      path.join(record.requirementPath, "prd", "prd-manifest.json"),
      JSON.stringify({ prd: { status: "generated", file: "link.md" } })
    )
    expect(await publishing.prepare({ reqId: "req-a", threadId: "thread-a" })).toMatchObject({
      code: "PRD_UNAVAILABLE"
    })
  })
  it("R3/R4: rejects non-regular/oversized files and holds actual-sized snapshots for many small files", async () => {
    const file = path.join(record.requirementPath, "prd", "formal.md")
    await fs.rm(file)
    await fs.mkdir(file)
    expect(
      await service({ publish: vi.fn() }).prepare({ reqId: "req-a", threadId: "thread-a" })
    ).toMatchObject({ code: "PRD_UNAVAILABLE" })
    await fs.rm(file, { recursive: true })
    await fs.writeFile(file, Buffer.alloc(5 * 1024 * 1024 + 1))
    expect(
      await service({ publish: vi.fn() }).prepare({ reqId: "req-a", threadId: "thread-a" })
    ).toMatchObject({ code: "PRD_UNAVAILABLE" })
    await fs.writeFile(file, "small")
    const functions = [] as Array<{ file: string }>
    for (let i = 0; i < 99; i++) {
      const filename = `f${i}.md`
      await fs.writeFile(path.join(record.requirementPath, "prd", filename), "small")
      functions.push({ file: filename })
    }
    await fs.writeFile(
      path.join(record.requirementPath, "prd", "prd-manifest.json"),
      JSON.stringify({ prd: { status: "generated", file: "formal.md" }, functions })
    )
    const input = await readRequirementPublishInput(record, "thread-a")
    expect(input.files).toHaveLength(100)
    expect(input.files.every(({ bytes }) => bytes.buffer.byteLength < 5 * 1024 * 1024)).toBe(true)
  })
  it("R3: rejects a temporary FIFO promptly without attempting to open it", async () => {
    if (process.platform === "win32") return
    const fifo = path.join(record.requirementPath, "prd", "formal.md")
    await fs.rm(fifo)
    execFileSync("mkfifo", [fifo])
    let fifoOpenAttempted = false
    const open = async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === fifo) {
        fifoOpenAttempted = true
        throw new Error("FIFO must not be opened")
      }
      return fs.open(...args)
    }
    const result = readRequirementPublishInput(record, "thread-a", { ...fs, open } as typeof fs)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await expect(
        Promise.race([
          result,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("FIFO check exceeded deadline")), 200)
          })
        ])
      ).rejects.toMatchObject({ code: "PRD_UNAVAILABLE" })
      expect(fifoOpenAttempted).toBe(false)
    } finally {
      if (timer) clearTimeout(timer)
    }
  })
  it.each(["growth", "overwrite"])(
    "R3: refuses %s occurring during bounded PRD reading",
    async (change) => {
      const file = await fs.realpath(path.join(record.requirementPath, "prd", "formal.md"))
      let changed = false
      const open = async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args)
        if (String(args[0]) !== file) return handle
        return new Proxy(handle, {
          get(target, property) {
            if (property === "read")
              return async (...readArgs: Parameters<typeof handle.read>) => {
                if (!changed) {
                  changed = true
                  if (change === "growth") await fs.appendFile(file, "growth")
                  else {
                    const original = await fs.readFile(file)
                    await fs.writeFile(file, Buffer.alloc(original.length, "x"))
                    const future = new Date(Date.now() + 10_000)
                    await fs.utimes(file, future, future)
                  }
                }
                return handle.read(...readArgs)
              }
            const value = Reflect.get(target, property)
            return typeof value === "function" ? value.bind(target) : value
          }
        })
      }
      await expect(
        readRequirementPublishInput(record, "thread-a", { ...fs, open } as typeof fs)
      ).rejects.toMatchObject({ code: "PRD_UNAVAILABLE" })
      expect(changed).toBe(true)
    }
  )
  it("rejects expired/tampered approvals and actual PRD byte changes with unchanged manifest", async () => {
    const publish = vi.fn(async () => ({ outcome: "published" as const })),
      publishing = service({ publish })
    const approval = await prepare(publishing)
    expect(
      await publishing.confirm({ ...approval, reqId: "another", commandId: "tamper" })
    ).toMatchObject({ code: "AUTHORIZATION_INVALID" })
    now = approval.expiresAt
    expect(await publishing.confirm({ ...approval, commandId: "expired" })).toMatchObject({
      code: "AUTHORIZATION_EXPIRED"
    })
    now = 1000
    const changed = await prepare(publishing)
    await fs.writeFile(
      path.join(record.requirementPath, "prd", "formal.md"),
      "changed actual bytes; manifest untouched"
    )
    expect(await publishing.confirm({ ...changed, commandId: "changed" })).toMatchObject({
      code: "INPUT_CHANGED"
    })
    expect(publish).not.toHaveBeenCalled()
  })
  it("rejects replaced credential references and old tickets after service restart", async () => {
    const publish = vi.fn(),
      publishing = service({ publish }),
      approval = await prepare(publishing)
    await credentials.save("REPLACEMENT_FAKE_CREDENTIAL")
    expect(await publishing.confirm({ ...approval, commandId: "replaced" })).toMatchObject({
      code: "UNKNOWN_CREDENTIAL"
    })
    expect(await service({ publish }).confirm({ ...approval, commandId: "restart" })).toMatchObject(
      { code: "AUTHORIZATION_INVALID" }
    )
    expect(publish).not.toHaveBeenCalled()
  })
  it("rejects removed credentials and detached threads after approval", async () => {
    const publish = vi.fn(),
      publishing = service({ publish })
    const missing = await prepare(publishing)
    await fs.rm(path.join(directory, "leanstar.json"))
    expect(await publishing.confirm({ ...missing, commandId: "missing" })).toMatchObject({
      code: "CREDENTIAL_MISSING"
    })
    await save()
    const detached = await prepare(publishing)
    record.threadIds = []
    expect(await publishing.confirm({ ...detached, commandId: "detached" })).toMatchObject({
      code: "REQUIREMENT_UNAVAILABLE"
    })
    expect(publish).not.toHaveBeenCalled()
  })
  it("does not authorize a draft PRD", async () => {
    await fs.writeFile(
      path.join(record.requirementPath, "prd", "prd-manifest.json"),
      JSON.stringify({ prd: { status: "draft", file: "formal.md" } })
    )
    expect(
      await service({ publish: vi.fn() }).prepare({ reqId: "req-a", threadId: "thread-a" })
    ).toMatchObject({ code: "PRD_UNAVAILABLE" })
  })
  it("R2: locks different commands/threads in flight and after unknown outcomes, no new ticket retry", async () => {
    const publish = vi.fn(async () => new Promise<{ outcome: "published" }>(() => {})),
      publishing = service({ publish }, { publishTimeoutMs: 10 })
    const first = await prepare(publishing),
      other = await prepare(publishing, "thread-b"),
      command = { ...first, commandId: "first" }
    const [one, two] = await Promise.all([
      publishing.confirm(command),
      publishing.confirm({ ...other, commandId: "different" })
    ])
    expect(one).toMatchObject({ code: "OUTCOME_UNKNOWN" })
    expect(two).toMatchObject({ code: "OUTCOME_UNKNOWN" })
    expect(await publishing.confirm(command)).toEqual(one)
    expect(await publishing.prepare({ reqId: "req-a", threadId: "thread-b" })).toMatchObject({
      code: "OUTCOME_UNKNOWN"
    })
    expect(await publishing.confirm({ ...first, commandId: "new-command" })).toMatchObject({
      code: "AUTHORIZATION_INVALID"
    })
    expect(publish).toHaveBeenCalledTimes(1)
  })
  it.each(["throw", "echo", "reject"])(
    "sanitizes publisher %s failure and leaves manifest untouched",
    async (kind) => {
      const publish = vi.fn(async () => {
        if (kind === "throw") throw new Error(SENTINEL)
        if (kind === "echo") return { outcome: "published" as const, unsafe: SENTINEL }
        return { outcome: "rejected" as const }
      })
      const publishing = service({ publish }),
        original = await fs.readFile(
          path.join(record.requirementPath, "prd", "prd-manifest.json"),
          "utf8"
        ),
        approval = await prepare(publishing)
      const result = await publishing.confirm({ ...approval, commandId: "fake-command" })
      expect(result).toMatchObject({
        code:
          kind === "throw"
            ? "OUTCOME_UNKNOWN"
            : kind === "echo"
              ? "SECRET_ECHO"
              : "PUBLISH_REJECTED"
      })
      expect(JSON.stringify(result).includes(SENTINEL)).toBe(false)
      expect(
        await fs.readFile(path.join(record.requirementPath, "prd", "prd-manifest.json"), "utf8")
      ).toBe(original)
    }
  )
})
