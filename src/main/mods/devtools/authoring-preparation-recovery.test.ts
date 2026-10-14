import { describe, expect, it, afterEach } from "vitest"
import fs from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  inspectAuthoringPreparation,
  recoverAuthoringPreparation,
  measureAuthoringQuarantine
} from "./authoring-preparation-recovery"
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
const versionId = "12345678-1234-4234-8234-123456789abc"
function fixture(live = false) {
  const root = fs.mkdtempSync(join(tmpdir(), "authoring-crash-"))
  roots.push(root)
  const child = live
    ? undefined
    : spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
        encoding: "utf8",
        windowsHide: true
      })
  if (child) expect(child.status).toBe(0)
  const pid = live ? process.pid : Number(child!.stdout)
  const lock = join(root, ".prepare-lock"),
    source = join(root, versionId)
  fs.mkdirSync(join(source, "source"), { recursive: true })
  fs.writeFileSync(join(source, "source", "main.ts"), "preserved unsaved preparation")
  fs.writeFileSync(
    lock,
    JSON.stringify({ schemaVersion: 1, pid, workspace: "workspace", versionId })
  )
  return { root, lock, source, pid }
}
describe("explicit preparation crash recovery", () => {
  it("requires actual process death and preserves the incomplete source in bounded quarantine", () => {
    const f = fixture(),
      view = inspectAuthoringPreparation(f.root, "workspace")
    expect(view.state).toBe("stale")
    const result = recoverAuthoringPreparation(
      f.root,
      "workspace",
      view.fingerprint!,
      () => {},
      () => {
        throw Error("not published")
      }
    )
    expect(result.preserved).toBe("quarantine")
    expect(fs.existsSync(f.lock)).toBe(false)
    expect(fs.existsSync(f.source)).toBe(false)
    expect(
      fs.readFileSync(join(f.root, ".quarantine", versionId, "version/source/main.ts"), "utf8")
    ).toBe("preserved unsaved preparation")
    expect(measureAuthoringQuarantine(f.root).count).toBe(1)
    expect(measureAuthoringQuarantine(f.root).bytes).toBeGreaterThan(20)
    expect(inspectAuthoringPreparation(f.root, "workspace").state).toBe("none")
  })
  it("never steals a live or legacy unknown lock or exposes another workspace owner", () => {
    const f = fixture(true),
      view = inspectAuthoringPreparation(f.root, "workspace")
    expect(view.state).toBe("live")
    expect(() =>
      recoverAuthoringPreparation(
        f.root,
        "workspace",
        view.fingerprint!,
        () => {},
        () => {}
      )
    ).toThrow("CHANGED")
    expect(inspectAuthoringPreparation(f.root, "other")).toEqual({
      state: "unknown",
      canRecover: false
    })
    fs.writeFileSync(f.lock, "")
    expect(inspectAuthoringPreparation(f.root, "workspace").state).toBe("unknown")
    expect(fs.existsSync(f.source)).toBe(true)
  })
  it("preserves published records and requires their real repository validation", () => {
    const f = fixture()
    fs.writeFileSync(join(f.source, "record.json"), "record")
    const view = inspectAuthoringPreparation(f.root, "workspace")
    expect(() =>
      recoverAuthoringPreparation(
        f.root,
        "workspace",
        view.fingerprint!,
        () => {},
        () => {
          throw Error("invalid published")
        }
      )
    ).toThrow("invalid published")
    expect(fs.existsSync(f.lock)).toBe(true)
    let validated = ""
    const result = recoverAuthoringPreparation(
      f.root,
      "workspace",
      view.fingerprint!,
      () => {},
      (id) => {
        validated = id
      }
    )
    expect(validated).toBe(versionId)
    expect(result.preserved).toBe("published")
    expect(fs.readFileSync(join(f.source, "record.json"), "utf8")).toBe("record")
  })
  it("rejects replaced lock content, scope revocation and links without moving data", () => {
    const f = fixture(),
      view = inspectAuthoringPreparation(f.root, "workspace")
    fs.writeFileSync(f.lock, fs.readFileSync(f.lock, "utf8") + " ")
    expect(() =>
      recoverAuthoringPreparation(
        f.root,
        "workspace",
        view.fingerprint!,
        () => {},
        () => {}
      )
    ).toThrow("CHANGED")
    const current = inspectAuthoringPreparation(f.root, "workspace")
    expect(() =>
      recoverAuthoringPreparation(
        f.root,
        "workspace",
        current.fingerprint!,
        () => {
          throw Error("revoked")
        },
        () => {}
      )
    ).toThrow("revoked")
    fs.linkSync(join(f.source, "source/main.ts"), join(f.source, "source/alias.ts"))
    expect(inspectAuthoringPreparation(f.root, "workspace").canRecover).toBe(false)
    expect(fs.existsSync(f.source)).toBe(true)
  })
  it("can finish a crash after quarantine rename without deleting its retained source", () => {
    const f = fixture(),
      archive = join(f.root, ".quarantine", versionId)
    fs.mkdirSync(archive, { recursive: true })
    fs.copyFileSync(f.lock, join(archive, "owner.json"))
    fs.renameSync(f.source, join(archive, "version"))
    const view = inspectAuthoringPreparation(f.root, "workspace")
    expect(view.state).toBe("stale")
    recoverAuthoringPreparation(
      f.root,
      "workspace",
      view.fingerprint!,
      () => {},
      () => {}
    )
    expect(fs.existsSync(join(archive, "version/source/main.ts"))).toBe(true)
    expect(fs.existsSync(f.lock)).toBe(false)
  })
})
