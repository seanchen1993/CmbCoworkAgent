import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ app: {} }))

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-userinfo-refresh-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  vi.stubEnv("CMB_COWORK_AGENT_HOME", directory)
  vi.resetModules()
  const storage = await import("./storage")
  const { subscribeRuntimeConfiguration } = await import("./runtime-configuration-events")
  const { invalidateBotModelSnapshot } = await import("./bots/model-config-fence")
  const modelFile = join(directory, "models.private")
  await writeFile(modelFile, "fixture-model-snapshot")
  let revisions = 0
  cleanup.push(
    subscribeRuntimeConfiguration(() => {
      revisions++
      invalidateBotModelSnapshot(modelFile)
    })
  )
  return {
    storage,
    file: join(directory, "userinfo-models.json"),
    pending: modelFile + ".pending",
    revisions: () => revisions
  }
}

it("keeps an identical login refresh from invalidating the running Bot configuration", async () => {
  const f = await fixture()
  const user = { sapId: "fixture-user", userName: "Fixture", ystAccessToken: "test-only" }
  f.storage.upsertUserInfoConfig(user)
  await rm(f.pending)
  const bytes = await readFile(f.file)
  f.storage.upsertUserInfoConfig({
    ystAccessToken: user.ystAccessToken,
    userName: user.userName,
    sapId: user.sapId,
    ystCode: undefined
  })
  expect(f.revisions()).toBe(1)
  expect(existsSync(f.pending)).toBe(false)
  expect(await readFile(f.file)).toEqual(bytes)
  f.storage.upsertUserInfoConfig({ ...user, ystAccessToken: "rotated-test-only" })
  expect(f.revisions()).toBe(2)
  expect(existsSync(f.pending)).toBe(true)
  await rm(f.pending)
  f.storage.upsertUserInfoConfig({})
  expect(f.revisions()).toBe(3)
  expect(existsSync(f.pending)).toBe(true)
  expect(f.storage.getUserInfo()).toEqual({})
})

it("repairs malformed saved identity and does not notify after a failed write", async () => {
  const f = await fixture()
  await writeFile(f.file, "{incomplete")
  f.storage.upsertUserInfoConfig({ sapId: "fixture-user" })
  expect(f.revisions()).toBe(1)
  expect(f.storage.getUserInfo()).toEqual({ sapId: "fixture-user" })
  await rm(f.pending)
  await rm(f.file)
  await mkdir(f.file)
  expect(() => f.storage.upsertUserInfoConfig({ sapId: "changed-user" })).toThrow()
  expect(f.revisions()).toBe(1)
  expect(existsSync(f.pending)).toBe(false)
})
