import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { HostPackageSnapshots } from "./package-snapshots"
import { hostProjectFixture } from "./host-fixtures.test-helper"

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "host-package-snapshot-"))
  roots.push(root)
  const source = join(root, "source")
  mkdirSync(source)
  const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
  writeFileSync(
    join(source, "devclaw.project-runtime.json"),
    JSON.stringify(hostProjectFixture(root).manifest)
  )
  writeFileSync(join(source, "plugin.json"), '{"name":"docs","version":"1.0.0"}')
  return { root, source, snapshots }
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe("retained complete package snapshots", () => {
  it("preserves binary resources, scripts and empty directories across installation changes", () => {
    const { source, snapshots } = fixture()
    mkdirSync(join(source, "empty"))
    writeFileSync(join(source, "resource.bin"), Buffer.from([0, 1, 255]))
    writeFileSync(join(source, "hook.py"), "print('original')")
    const first = snapshots.capture(source)
    writeFileSync(join(source, "hook.py"), "print('updated')")
    const second = snapshots.capture(source)
    expect(second.digest).not.toBe(first.digest)
    expect(readFileSync(join(snapshots.read(first.digest).root, "resource.bin"))).toEqual(
      Buffer.from([0, 1, 255])
    )
    expect(readFileSync(join(first.root, "hook.py"), "utf8")).toBe("print('original')")
    expect(snapshots.capture(source).digest).toBe(second.digest)
    writeFileSync(join(first.root, "hook.py"), "tampered")
    expect(() => snapshots.read(first.digest)).toThrow("PACKAGE_CHANGED")
  })
  it("rejects sensitive paths and hard links instead of silently creating an incomplete package", () => {
    const { source, snapshots } = fixture()
    writeFileSync(join(source, ".env"), "fake-test-only")
    expect(() => snapshots.capture(source)).toThrow("PACKAGE_SENSITIVE_PATH")
    rmSync(join(source, ".env"))
    linkSync(join(source, "plugin.json"), join(source, "linked.json"))
    expect(() => snapshots.capture(source)).toThrow()
  })
})
