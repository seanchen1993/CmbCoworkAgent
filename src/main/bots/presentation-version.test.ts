import { expect, it } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { DatabaseSync } from "node:sqlite"
import { build } from "esbuild"
import { BotStore } from "./store"
import { BOT_SCHEMA_VERSION } from "./schema"

it("upgrades the durable presentation format from 68 without rewriting opaque receipts", () => {
  mkdirSync(resolve("output"), { recursive: true })
  const directory = mkdtempSync(resolve("output/presentation-version-")),
    path = join(directory, "bots.sqlite")
  try {
    let store = new BotStore(path)
    store.db.run("INSERT INTO bot_receipts VALUES(?,?,?,?)", [
      "fixture-presentation",
      "original-request",
      '{"version":1,"artifactSha256":"original"}',
      1
    ])
    store.close()
    const prior = new DatabaseSync(path)
    prior.exec("UPDATE bot_schema SET version=68")
    prior.close()
    store = new BotStore(path)
    expect(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
    expect(BOT_SCHEMA_VERSION).toBeGreaterThanOrEqual(69)
    expect(
      store.db.exec("SELECT response FROM bot_receipts WHERE nonce='fixture-presentation'")[0]
        .values[0][0]
    ).toBe('{"version":1,"artifactSha256":"original"}')
    store.close()
    const backupName = readdirSync(join(directory, "backups")).find((x) =>
      x.startsWith("bots-v68-")
    )!
    const backup = new DatabaseSync(join(directory, "backups", backupName), { readOnly: true })
    expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(68)
    expect(
      backup.prepare("SELECT response FROM bot_receipts WHERE nonce=?").get("fixture-presentation")
        ?.response
    ).toBe('{"version":1,"artifactSha256":"original"}')
    backup.close()
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})
it("the unchanged migration admission rejects presentation data for a 68 reader before changing persistent state", async () => {
  mkdirSync(resolve("output"), { recursive: true })
  const directory = mkdtempSync(resolve("output/presentation-older-reader-")),
    path = join(directory, "bots.sqlite")
  try {
    const store = new BotStore(path)
    store.close()
    const before = readFileSync(path)
    const filesBefore = readdirSync(directory)
    const deletionLedger = readFileSync(`${path}.deletions`)
    const entry = join(directory, "reader68.cjs")
    await build({
      entryPoints: ["src/main/bots/migrations.ts"],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
      plugins: [
        {
          name: "prior-version-contract",
          setup(build) {
            build.onResolve({ filter: /^\.\/schema$/ }, () => ({
              path: "schema68",
              namespace: "prior"
            }))
            build.onLoad({ filter: /.*/, namespace: "prior" }, () => ({
              contents: 'export const BOT_SCHEMA_VERSION=68; export const BOT_SCHEMA="";',
              loader: "ts"
            }))
          }
        }
      ]
    })
    const prior = createRequire(import.meta.url)(entry) as {
      initializeBotDatabase(db: DatabaseSync, path: string): void
    }
    const db = new DatabaseSync(path)
    expect(() => prior.initializeBotDatabase(db, path)).toThrow(`不支持 Bot 数据版本 ${BOT_SCHEMA_VERSION}`)
    db.close()
    expect(readFileSync(path)).toEqual(before)
    expect(readFileSync(`${path}.deletions`)).toEqual(deletionLedger)
    expect(readdirSync(directory).sort()).toEqual([...filesBefore, "reader68.cjs"].sort())
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})
