import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import initSqlJs from "sql.js"
import { describe, expect, it } from "vitest"
import {
  readBrowserProfileImportData
} from "../../../src/main/browser/chrome/browser-profile-importer"

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value), "utf8")
}

async function writeCookieStore(filePath: string): Promise<void> {
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  database.run(`
    CREATE TABLE cookies (
      host_key TEXT,
      name TEXT,
      value TEXT,
      encrypted_value BLOB,
      path TEXT,
      expires_utc INTEGER,
      is_secure INTEGER,
      is_httponly INTEGER,
      samesite INTEGER,
      top_frame_site_key TEXT,
      is_partitioned INTEGER
    )
  `)
  const insert = database.prepare(`
    INSERT INTO cookies (
      host_key,
      name,
      value,
      encrypted_value,
      path,
      expires_utc,
      is_secure,
      is_httponly,
      samesite,
      top_frame_site_key,
      is_partitioned
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insert.run([
    ".example.com",
    "sid",
    "abc123",
    new Uint8Array(),
    "/",
    0,
    1,
    1,
    1,
    "",
    0
  ])
  insert.run([
    ".example.com",
    "partitioned",
    "skip",
    new Uint8Array(),
    "/",
    0,
    1,
    0,
    0,
    "https://example.com",
    1
  ])
  insert.run([
    ".example.com",
    "encrypted",
    "",
    new Uint8Array([118, 49, 48, 1, 2, 3]),
    "/",
    0,
    1,
    0,
    0,
    "",
    0
  ])
  insert.free()
  writeFileSync(filePath, Buffer.from(database.export()))
  database.close()
}

async function createFakeChromeUserData(): Promise<{
  options: {
    env?: NodeJS.ProcessEnv
    homeDir?: string
    platform?: NodeJS.Platform
    timeoutMs?: number
  }
  root: string
}> {
  const root = mkdtempSync(join(tmpdir(), "cmb-browser-profile-import-"))
  const profilePath = join(root, "Profile 1")
  mkdirSync(join(profilePath, "Network"), { recursive: true })
  writeJson(join(root, "Local State"), {
    profile: {
      last_used: "Profile 1",
      last_active_profiles: ["Profile 1"],
      info_cache: {
        "Profile 1": {}
      }
    }
  })
  writeJson(join(profilePath, "Preferences"), {
    profile: {
      name: "Work"
    }
  })
  await writeCookieStore(join(profilePath, "Network", "Cookies"))
  return {
    root,
    options: {
      env: { CODEX_CHROME_USER_DATA_DIR: root },
      homeDir: root,
      platform: "linux",
      timeoutMs: 50
    }
  }
}

describe("browser profile importer", () => {
  it("reads plaintext cookies and skips partitioned or undecryptable cookies", async () => {
    const fixture = await createFakeChromeUserData()
    try {
      const result = await readBrowserProfileImportData(
        { sourceBrowser: "chrome", importCookies: true },
        fixture.options
      )

      expect(result.profileDirectory).toBe("Profile 1")
      expect(result.skippedCookies).toBe(2)
      expect(result.skippedWebsites).toEqual([
        {
          domain: "example.com",
          reasons: ["partitioned", "encrypted"],
          skippedCookies: 2,
          url: "https://example.com/"
        }
      ])
      expect(result.data.localStorage).toEqual([])
      expect(result.data.cookies).toEqual([
        {
          domain: ".example.com",
          expires: undefined,
          httpOnly: true,
          name: "sid",
          path: "/",
          sameSite: "lax",
          secure: true,
          value: "abc123"
        }
      ])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
