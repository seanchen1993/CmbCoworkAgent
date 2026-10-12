import { afterEach, expect, it, vi } from "vitest"
import { createServer } from "node:net"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
  realpathSync
} from "node:fs"
import { join, dirname } from "node:path"
import { botHostSocketPath, prepareBotHostSocket } from "./host-socket"

const posix = it.skipIf(process.platform === "win32")
const roots: string[] = []
const identity = "a".repeat(24)
const longTemporaryDirectory = `/tmp/${"临".repeat(40)}`
function fixture() {
  const root = realpathSync(mkdtempSync("/tmp/cmb-socket-test-"))
  roots.push(root)
  const data = join(root, "data")
  mkdirSync(data, { mode: 0o700 })
  writeFileSync(join(data, "host-lock.sqlite"), "fixture inode", {
    mode: 0o600
  })
  return { root, data, lock: authority(data) }
}
function authority(data: string) {
  const root = lstatSync(data, { bigint: true }),
    lock = lstatSync(join(data, "host-lock.sqlite"), { bigint: true })
  const assertCurrent = () => {
    const current = lstatSync(data, { bigint: true }),
      currentLock = lstatSync(join(data, "host-lock.sqlite"), { bigint: true })
    if (
      current.dev !== root.dev ||
      current.ino !== root.ino ||
      currentLock.dev !== lock.dev ||
      currentLock.ino !== lock.ino
    )
      throw new Error("held lock fenced")
  }
  return {
    assertCurrent,
    recoveryOwnershipIdentity() {
      assertCurrent()
      return {
        root: { dev: String(root.dev), ino: String(root.ino) },
        lock: { dev: String(lock.dev), ino: String(lock.ino) }
      }
    }
  }
}
function privateEndpoint(f: ReturnType<typeof fixture>) {
  return prepareBotHostSocket(f.data, identity, f.lock, {
    platform: "darwin",
    privateBase: f.root
  })
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

it("preserves short POSIX paths and the original Windows named pipe", () => {
  if (process.platform !== "win32")
    expect(botHostSocketPath("/tmp", identity, "darwin")).toBe(`/tmp/cmb-bot-${identity}.sock`)
  expect(botHostSocketPath("C:\\temporary", identity, "win32")).toBe(
    `\\\\.\\pipe\\cmb-bot-${identity}`
  )
})
posix.each([
  { platform: "darwin" as const, limit: 103 },
  { platform: "linux" as const, limit: 107 }
])("uses the actual $platform byte boundary", ({ platform, limit }) => {
  const suffix = `/cmb-bot-${identity}.sock`
  expect(
    botHostSocketPath("/" + "x".repeat(limit - suffix.length - 1), identity, platform)
  ).toHaveLength(limit)
  expect(botHostSocketPath("/" + "x".repeat(limit - suffix.length), identity, platform)).toBeNull()
})
posix("counts multibyte UTF-8 instead of JS characters", () => {
  expect(longTemporaryDirectory.length).toBeLessThan(103)
  expect(Buffer.byteLength(longTemporaryDirectory)).toBeGreaterThan(103)
  expect(botHostSocketPath(longTemporaryDirectory, identity, "darwin")).toBeNull()
})
posix(
  "reuses one owned endpoint across short and long TMPDIR for the same physical authority",
  () => {
    const f = fixture()
    vi.stubEnv("TMPDIR", "/tmp")
    const first = privateEndpoint(f)
    first.close()
    vi.stubEnv("TMPDIR", longTemporaryDirectory)
    const second = privateEndpoint(f)
    expect(second.path).toBe(first.path)
    expect(readdirSync(dirname(second.path))).toEqual(["owner.private.json"])
    second.close()
  }
)
posix(
  "provisions a private marked namespace and intentionally retains the bounded marker on clean close",
  () => {
    const f = fixture(),
      endpoint = privateEndpoint(f),
      scope = dirname(endpoint.path)
    expect(Buffer.byteLength(endpoint.path)).toBeLessThanOrEqual(103)
    expect(lstatSync(scope).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(scope, "owner.private.json")).mode & 0o777).toBe(0o600)
    endpoint.close()
    endpoint.close()
    expect(readdirSync(scope)).toEqual(["owner.private.json"])
    const reopened = privateEndpoint(f)
    expect(reopened.path).toBe(endpoint.path)
    expect(readdirSync(scope)).toEqual(["owner.private.json"])
    reopened.close()
  }
)
posix(
  "cleans the exact socket through the normal server-close path and can close a startup failure before bind",
  async () => {
    const f = fixture(),
      endpoint = privateEndpoint(f),
      server = createServer()
    await new Promise<void>((resolve) => server.listen(endpoint.path, resolve))
    chmodSync(endpoint.path, 0o600)
    endpoint.assertCurrent()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    endpoint.close()
    expect(() => lstatSync(endpoint.path)).toThrow()
    const failedBeforeBind = privateEndpoint(f)
    failedBeforeBind.close()
    expect(readdirSync(dirname(endpoint.path))).toEqual(["owner.private.json"])
  }
)
posix("rejects a symlinked private namespace without touching its target", () => {
  const f = fixture(),
    endpoint = privateEndpoint(f),
    scope = dirname(endpoint.path),
    foreign = join(f.root, "foreign")
  endpoint.close()
  rmSync(scope, { recursive: true })
  mkdirSync(foreign, { mode: 0o700 })
  writeFileSync(join(foreign, "untouched"), "foreign")
  symlinkSync(foreign, scope, "dir")
  expect(() => privateEndpoint(f)).toThrow("归属")
  expect(readFileSync(join(foreign, "untouched"), "utf8")).toBe("foreign")
  expect(lstatSync(scope).isSymbolicLink()).toBe(true)
})
posix.each(["missing", "torn", "scope", "permissions"])(
  "refuses $kind marker state, preserving the ambiguous namespace",
  (kind) => {
    const f = fixture(),
      endpoint = privateEndpoint(f),
      scope = dirname(endpoint.path),
      marker = join(scope, "owner.private.json")
    endpoint.close()
    if (kind === "missing") unlinkSync(marker)
    else if (kind === "torn") writeFileSync(marker, '{"version":1')
    else if (kind === "scope") {
      const value = JSON.parse(readFileSync(marker, "utf8"))
      value.authority.lock.ino = "0"
      writeFileSync(marker, JSON.stringify(value))
    } else chmodSync(marker, 0o644)
    expect(() => privateEndpoint(f)).toThrow("归属")
    expect(lstatSync(scope).isDirectory()).toBe(true)
  }
)
posix("refuses foreign entries and non-socket endpoint files without deleting either", () => {
  const f = fixture(),
    endpoint = privateEndpoint(f),
    scope = dirname(endpoint.path)
  writeFileSync(join(scope, "foreign.txt"), "foreign")
  expect(() => endpoint.close()).toThrow("归属")
  expect(readFileSync(join(scope, "foreign.txt"), "utf8")).toBe("foreign")
  unlinkSync(join(scope, "foreign.txt"))
  writeFileSync(endpoint.path, "not a socket")
  expect(() => endpoint.close()).toThrow("归属")
  expect(readFileSync(endpoint.path, "utf8")).toBe("not a socket")
})
posix("refuses a wrong OS owner before adopting the new namespace", () => {
  const f = fixture(),
    uid = process.getuid!()
  // This contract only runs on POSIX, where the optional Node API is available.
  const owner = process as NodeJS.Process & { getuid(): number }
  vi.spyOn(owner, "getuid").mockReturnValue(uid + 1)
  expect(() => privateEndpoint(f)).toThrow("归属")
})
posix("fences replaced markers before cleanup, retaining replacement contents", () => {
  const f = fixture(),
    endpoint = privateEndpoint(f),
    marker = join(dirname(endpoint.path), "owner.private.json")
  renameSync(marker, marker + ".old")
  writeFileSync(marker, "replacement", { mode: 0o600 })
  expect(() => endpoint.close()).toThrow("归属")
  expect(readFileSync(marker, "utf8")).toBe("replacement")
})
posix(
  "separates changed canonical data/lock identities and never removes the old owner's namespace",
  () => {
    const f = fixture(),
      endpoint = privateEndpoint(f),
      oldScope = dirname(endpoint.path)
    renameSync(f.data, f.data + ".old")
    mkdirSync(f.data, { mode: 0o700 })
    writeFileSync(join(f.data, "host-lock.sqlite"), "new owner", {
      mode: 0o600
    })
    expect(() => endpoint.close()).toThrow("fenced")
    const next = prepareBotHostSocket(f.data, identity, authority(f.data), {
      platform: "darwin",
      privateBase: f.root
    })
    expect(next.path).not.toBe(endpoint.path)
    expect(readFileSync(join(oldScope, "owner.private.json"), "utf8")).toContain('"version":1')
    next.close()
  }
)
posix(
  "rejects a private base whose physical path cannot fit before provisioning namespace files",
  () => {
    const f = fixture(),
      base = join(f.root, "x".repeat(70))
    mkdirSync(base, { mode: 0o700 })
    expect(() =>
      prepareBotHostSocket(f.data, identity, f.lock, {
        platform: "darwin",
        privateBase: base
      })
    ).toThrow("不可用")
    expect(readdirSync(base)).toEqual([])
  }
)
