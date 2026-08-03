import { describe, expect, it, vi } from "vitest"
import { existsSync } from "fs"
import { spawnSync } from "child_process"

vi.mock("electron", () => ({
  app: {
    getPath: () => "/opt/CMBDevClaw/cmbdevclaw",
    getVersion: () => "1.4.5",
    quit: vi.fn()
  }
}))

import { generateFullZipUpdateSh } from "./installer"

describe("generateFullZipUpdateSh", () => {
  it("streams a GitHub artifact's single nested tar.gz into the staged app", () => {
    const script = generateFullZipUpdateSh(
      "/tmp/CMBDevClaw-linux-unpacked-1.4.7.zip",
      "/opt/CMBDevClaw",
      "/opt/CMBDevClaw/cmbdevclaw",
      "1.3.9",
      "1.4.5",
      "1.4.7",
      "staging",
      "1.4.5"
    )

    expect(script).toContain("validate_archive_paths() {")
    expect(script).toContain('mapfile -t ZIP_FILES < <(unzip -Z1 "$ZIP"')
    expect(script).toContain('unzip -Z1 "$ZIP" | validate_archive_paths')
    expect(script.indexOf("validate_archive_paths() {")).toBeLessThan(
      script.indexOf('unzip -Z1 "$ZIP" | validate_archive_paths')
    )
    expect(script).toContain('[[ "${ZIP_FILES[0]}" =~ \\.(tar\\.gz|tgz)$ ]]')
    expect(script).toContain(
      'unzip -p "$ZIP" "$NESTED_TAR" | tar -tzf - | validate_archive_paths'
    )
    expect(script).toContain('unzip -p "$ZIP" "$NESTED_TAR" | tar -xzf - -C "$PAYLOAD_DIR"')
    expect(script).toContain('cp -a "$SOURCE_DIR"/. "$STAGE_DIR"/')
    expect(script).toContain(
      '{"fromVersion":"1.3.9","toVersion":"1.4.5","updateType":"full","releaseVersion":"1.4.7","channel":"staging","minVersion":"1.4.5"}'
    )

    const windowsGitBash = "C:\\Program Files\\Git\\bin\\bash.exe"
    const bash = process.platform === "win32" && existsSync(windowsGitBash) ? windowsGitBash : "bash"
    const syntaxCheck = spawnSync(bash, ["-n"], { input: script, encoding: "utf8" })
    if (!syntaxCheck.error) {
      expect(syntaxCheck.status, syntaxCheck.stderr).toBe(0)
    }
  })

  it("keeps support for flat zip packages and a single outer directory", () => {
    const script = generateFullZipUpdateSh(
      "/tmp/full.zip",
      "/opt/CMBDevClaw",
      "/opt/CMBDevClaw/cmbdevclaw",
      "1.4.5",
      "1.4.7",
      "1.4.7"
    )

    expect(script).toContain('unzip -o "$ZIP" -d "$ARCHIVE_DIR"')
    expect(script).toContain('find "$ARCHIVE_DIR" -mindepth 1 -maxdepth 1 -print')
  })
})
