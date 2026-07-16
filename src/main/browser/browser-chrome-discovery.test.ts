import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { describe, expect, it } from "vitest"
import {
  BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES,
  checkBrowserChromeEnvironment,
  getBrowserChromeScriptPaths,
  runBrowserChromeJsonScript
} from "./browser-chrome-discovery"

function createScript(root: string, name: string, body: string): void {
  const scripts = join(root, "scripts")
  mkdirSync(scripts, { recursive: true })
  writeFileSync(
    join(scripts, name),
    `#!/usr/bin/env node\n${body}\n`,
    "utf8"
  )
}

describe("browser chrome discovery", () => {
  it("resolves the official Browser plugin Chrome diagnostic script paths", () => {
    const paths = getBrowserChromeScriptPaths("/tmp/browser-plugin")

    expect(paths.installedBrowsers).toBe(
      "/tmp/browser-plugin/scripts/installed-browsers.js"
    )
    expect(paths.chromeIsRunning).toBe(
      "/tmp/browser-plugin/scripts/chrome-is-running.js"
    )
    expect(paths.checkExtensionInstalled).toBe(
      "/tmp/browser-plugin/scripts/check-extension-installed.js"
    )
    expect(paths.checkNativeHostManifest).toBe(
      "/tmp/browser-plugin/scripts/check-native-host-manifest.js"
    )
  })

  it("runs official-style JSON diagnostics and preserves meaningful non-zero status", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-browser-chrome-discovery-"))
    try {
      createScript(
        root,
        BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES.installedBrowsers,
        `console.log(JSON.stringify({ platform: "test", installed_browsers: [{ name: "Google Chrome", path: "/chrome" }] }));`
      )
      createScript(
        root,
        BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES.chromeIsRunning,
        `console.log(JSON.stringify({ platform: "test", running: true, processes: [{ pid: 1, process_name: "chrome" }] }));`
      )
      createScript(
        root,
        BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES.checkExtensionInstalled,
        `console.log(JSON.stringify({ extensionId: "ext", installed: true, enabled: false, exitCode: 1 })); process.exit(1);`
      )
      createScript(
        root,
        BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES.checkNativeHostManifest,
        `console.log(JSON.stringify({ expectedHostName: "host", correct: true }));`
      )

      const result = await checkBrowserChromeEnvironment({ pluginRoot: root })

      expect(result.summary).toEqual({
        chromeInstalled: true,
        chromeRunning: true,
        extensionBackendReady: false,
        extensionEnabled: false,
        nativeHostManifestCorrect: true
      })
      expect(result.extensionInstalled.exitCode).toBe(1)
      expect(result.extensionInstalled.json).toMatchObject({
        installed: true,
        enabled: false
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("reports missing diagnostic scripts without throwing", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-browser-chrome-discovery-missing-"))
    try {
      const result = await runBrowserChromeJsonScript(
        root,
        BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES.installedBrowsers
      )

      expect(result.ok).toBe(false)
      expect(result.exitCode).toBeNull()
      expect(result.error).toContain("Browser Chrome discovery script is missing")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
