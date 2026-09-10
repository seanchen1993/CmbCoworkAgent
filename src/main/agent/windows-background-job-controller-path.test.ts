import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resolveWindowsBackgroundJobControllerPath } from "./windows-background-job-controller-path"

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cmb-controller-path-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("resolveWindowsBackgroundJobControllerPath", () => {
  it("keeps a packaged build on resourcesPath when the helper is missing", async () => {
    const root = await temporaryDirectory()
    const resourceRoot = path.join(root, "packaged-resources")
    const workingDirectory = path.join(root, "attacker-working-directory")
    const fakeController = path.join(
      workingDirectory,
      "resources",
      "bin",
      "win32",
      "background-job-controller.exe"
    )
    await mkdir(path.dirname(fakeController), { recursive: true })
    await writeFile(fakeController, "must not be selected", "utf8")

    const resolved = resolveWindowsBackgroundJobControllerPath({
      cwd: workingDirectory,
      isPackaged: true,
      moduleDirectory: path.join(root, "out", "main"),
      pathExists: existsSync,
      resourcesPath: resourceRoot
    })

    expect(resolved).toBe(path.join(resourceRoot, "bin", "win32", "background-job-controller.exe"))
    expect(existsSync(resolved)).toBe(false)
    expect(resolved).not.toBe(fakeController)
  })

  it("uses repository candidates only for development", async () => {
    const root = await temporaryDirectory()
    const workingDirectory = path.join(root, "workspace")
    const controller = path.join(
      workingDirectory,
      "resources",
      "bin",
      "win32",
      "background-job-controller.exe"
    )
    await mkdir(path.dirname(controller), { recursive: true })
    await writeFile(controller, "development helper", "utf8")

    expect(
      resolveWindowsBackgroundJobControllerPath({
        cwd: workingDirectory,
        isPackaged: false,
        moduleDirectory: path.join(root, "out", "main"),
        pathExists: existsSync
      })
    ).toBe(controller)
  })

  it("resolves the bundled development directory two levels above out/main", async () => {
    const root = await temporaryDirectory()
    const controller = path.join(root, "resources", "bin", "win32", "background-job-controller.exe")
    await mkdir(path.dirname(controller), { recursive: true })
    await writeFile(controller, "bundled development helper", "utf8")

    expect(
      resolveWindowsBackgroundJobControllerPath({
        cwd: path.join(root, "empty-cwd"),
        isPackaged: false,
        moduleDirectory: path.join(root, "out", "main"),
        pathExists: existsSync
      })
    ).toBe(controller)
  })

  it("resolves the source development directory three levels above src/main/agent", async () => {
    const root = await temporaryDirectory()
    const controller = path.join(root, "resources", "bin", "win32", "background-job-controller.exe")
    await mkdir(path.dirname(controller), { recursive: true })
    await writeFile(controller, "source development helper", "utf8")

    expect(
      resolveWindowsBackgroundJobControllerPath({
        cwd: path.join(root, "empty-cwd"),
        isPackaged: false,
        moduleDirectory: path.join(root, "src", "main", "agent"),
        pathExists: existsSync
      })
    ).toBe(controller)
  })

  it("fails closed when a packaged runtime has no absolute resources path", () => {
    expect(() =>
      resolveWindowsBackgroundJobControllerPath({ isPackaged: true, resourcesPath: "relative" })
    ).toThrow("resource path is unavailable")
  })
})
