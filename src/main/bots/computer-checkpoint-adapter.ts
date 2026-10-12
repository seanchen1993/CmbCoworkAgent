import { lstat, mkdir, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { BotSharedWorkspace } from "./shared-workspace"
import {
  captureBotDirectory,
  restoreBotDirectory,
  verifyBotDirectory
} from "./directory-checkpoint"
import { browserCheckpointOrigin } from "./browser-maintenance"
import { present, readPrivateJson, writePrivateJson } from "./backup-io"
import type { ComputerCheckpointProgress } from "./computer-checkpoint-progress"
import { opendir } from "node:fs/promises"
import type { ComputerNativeSQLite } from "./computer-checkpoint-native"
import {
  captureComputerData,
  prepareComputerData,
  readComputerData,
  verifyComputerData
} from "./computer-checkpoint-data"
import {
  captureManaged,
  prepareManaged,
  publishManaged,
  readManaged,
  verifyManagedPrepared
} from "./computer-checkpoint-managed"
import {
  computerBrowserManifest,
  computerDataManifest,
  computerSharedManifest,
  COMPUTER_BROWSER_BYTES,
  type ComputerComponent,
  type ComputerPrepared
} from "./computer-checkpoint-manifest"
import {
  ComputerBudget,
  treeBytes,
  type ComputerCaptureInput,
  type ComputerPorts,
  type ComputerPreparationInput
} from "./computer-checkpoint-ports"
const transient = new Set([
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "DevToolsActivePort"
])
const channel = () => (process.platform === "win32" ? ("msedge" as const) : ("chrome" as const))
const failed = () => new Error("电脑恢复点的共享文件或工作浏览器归属、文件摘要与完整性校验失败")
async function exactComponent(root: string, payload: string) {
  const allowed = new Set(["manifest.json", payload]),
    directory = await opendir(root)
  for await (const entry of directory) if (!allowed.delete(entry.name)) throw failed()
  if (allowed.size) throw failed()
}
async function rootIdentity(path: string) {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || (await realpath(path)) !== resolve(path)) throw failed()
  return { dev: String(info.dev), ino: String(info.ino) }
}
async function seal(
  root: string,
  manifest: unknown,
  entries: number,
  bytes: number
): Promise<ComputerComponent> {
  await writePrivateJson(join(root, "manifest.json"), manifest)
  return {
    state: "established",
    sha256: (await readPrivateJson(root, "manifest.json")).sha256,
    entries,
    bytes
  }
}
async function readShared(root: string, component: ComputerComponent) {
  if (component.state === "absent") {
    if (await present(root)) throw failed()
    return undefined
  }
  const record = await readPrivateJson(root, "manifest.json"),
    manifest = computerSharedManifest.parse(record.value)
  if (
    record.sha256 !== component.sha256 ||
    manifest.entries.length !== component.entries ||
    treeBytes(manifest.entries) !== component.bytes
  )
    throw failed()
  await verifyBotDirectory(join(root, "files"), manifest.entries)
  await exactComponent(root, "files")
  return manifest
}
async function readBrowser(root: string, component: ComputerComponent) {
  if (component.state === "absent") {
    if (await present(root)) throw failed()
    return undefined
  }
  const record = await readPrivateJson(root, "manifest.json"),
    manifest = computerBrowserManifest.parse(record.value)
  if (
    record.sha256 !== component.sha256 ||
    manifest.entries.length !== component.entries ||
    treeBytes(manifest.entries) !== component.bytes ||
    manifest.platform !== process.platform ||
    manifest.browser !== channel()
  )
    throw failed()
  await verifyBotDirectory(join(root, "profile"), manifest.entries)
  await exactComponent(root, "profile")
  return manifest
}
async function captureShared(input: ComputerCaptureInput): Promise<ComputerComponent> {
  const state = await BotSharedWorkspace.inspectForRecovery(input.directory)
  if (state.state === "absent") return state
  const source = join(`${input.directory}.workspace`, state.reference.id),
    root = join(input.destination, "shared")
  const check = () => {
    input.owner.assertCurrent()
    input.signal.throwIfAborted()
  }
  const before = await rootIdentity(source)
  if (before.dev !== state.reference.identity.dev || before.ino !== state.reference.identity.ino)
    throw failed()
  await mkdir(root, { mode: 0o700 })
  const remaining = input.budget.remaining(),
    entries = await captureBotDirectory(source, join(root, "files"), check, {
      maxEntries: remaining.entries,
      maxBytes: remaining.bytes
    })
  const after = await rootIdentity(source),
    current = await BotSharedWorkspace.inspectForRecovery(input.directory)
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    current.state !== "established" ||
    current.recordSha256 !== state.recordSha256
  )
    throw failed()
  const bytes = treeBytes(entries)
  input.budget.consume(entries.length, bytes)
  return seal(
    root,
    computerSharedManifest.parse({ format: 1, workspaceId: state.reference.id, entries }),
    entries.length,
    bytes
  )
}
async function captureBrowser(
  input: ComputerCaptureInput,
  native: ComputerNativeSQLite
): Promise<ComputerComponent> {
  const source = join(input.directory, "browser-profile")
  if (!(await present(source))) return { state: "absent" }
  const originId = await browserCheckpointOrigin(
      input.directory,
      () => input.owner.assertCurrent(),
      true
    ),
    before = await rootIdentity(source),
    root = join(input.destination, "browser")
  await mkdir(root, { mode: 0o700 })
  const remaining = input.budget.remaining(),
    entries = await captureBotDirectory(
      source,
      join(root, "profile"),
      () => {
        input.owner.assertCurrent()
        input.signal.throwIfAborted()
      },
      {
        maxEntries: remaining.entries,
        maxBytes: Math.min(remaining.bytes, COMPUTER_BROWSER_BYTES),
        excludeRoot: transient
      }
    )
  const after = await rootIdentity(source)
  if (before.dev !== after.dev || before.ino !== after.ino) throw failed()
  const pages: ReturnType<typeof computerBrowserManifest.parse>["pages"] = []
  if (await present(join(input.destination, "data", "bots.sqlite"))) {
    pages.push(...(await native.bindings(join(input.destination, "data", "bots.sqlite"))).pages)
  }
  const bytes = treeBytes(entries)
  input.budget.consume(entries.length, bytes)
  return seal(
    root,
    computerBrowserManifest.parse({
      format: 1,
      originId,
      platform: process.platform,
      browser: channel(),
      entries,
      pages
    }),
    entries.length,
    bytes
  )
}
async function copyPreparedManifest(
  input: ComputerPreparationInput,
  name: "shared" | "browser",
  manifest: unknown,
  component: ComputerComponent
) {
  await writePrivateJson(join(input.hostStage, `prepared-${name}.json`), manifest)
  if (component.state === "absent") throw failed()
  return {
    ...component,
    sha256: (await readPrivateJson(input.hostStage, `prepared-${name}.json`)).sha256
  }
}
async function readPrepared<T>(
  input: ComputerPreparationInput,
  name: string,
  component: ComputerComponent,
  parse: (value: unknown) => T
): Promise<T | undefined> {
  const file = `prepared-${name}.json`
  if (component.state === "absent") {
    if (await present(join(input.hostStage, file))) throw failed()
    return undefined
  }
  const record = await readPrivateJson(input.hostStage, file)
  if (record.sha256 !== component.sha256) throw failed()
  return parse(record.value)
}
export const createComputerCheckpointPorts = (
  native: ComputerNativeSQLite,
  progress?: ComputerCheckpointProgress
): ComputerPorts => ({
  async capture(input) {
    // The exact frozen SQLite snapshot supplies all data/browser/Git bindings.
    progress?.stage("capture", "data")
    const data = await captureComputerData(input, native)
    progress?.stage("capture", "shared")
    const shared = await captureShared(input)
    progress?.stage("capture", "browser")
    const browser = await captureBrowser(input, native)
    progress?.stage("capture", "managed")
    const managed = await captureManaged(input, native)
    const complete =
      managed.state === "established"
        ? (await readManaged(join(input.destination, "managed"), managed))!.items.length
        : 0
    return {
      components: { data, shared, browser, managed },
      managedGit: { complete, filesOnly: 0 }
    }
  },
  async verifyPoint(root, components) {
    progress?.stage("verify", "data")
    await readComputerData(join(root, "data"), components.data, native)
    progress?.stage("verify", "shared")
    await readShared(join(root, "shared"), components.shared)
    progress?.stage("verify", "browser")
    await readBrowser(join(root, "browser"), components.browser)
    progress?.stage("verify", "managed")
    await readManaged(join(root, "managed"), components.managed)
    const { opendir } = await import("node:fs/promises")
    const allowed = new Set([
      "manifest.json",
      "summary.json",
      ...Object.entries(components)
        .filter(([, c]) => c.state === "established")
        .map(([name]) => name)
    ])
    const directory = await opendir(root)
    for await (const entry of directory) if (!allowed.delete(entry.name)) throw failed()
    if (allowed.size) throw failed()
  },
  async prepare(input, components) {
    progress?.stage("prepare", "data")
    const data = await prepareComputerData(input, components.data, native),
      originalShared = await BotSharedWorkspace.inspectForRecovery(input.directory),
      sharedManifest = await readShared(join(input.pointRoot, "shared"), components.shared),
      browserManifest = await readBrowser(join(input.pointRoot, "browser"), components.browser)
    let replacementShared: ComputerPrepared["replacementShared"] = { state: "absent" },
      shared: ComputerComponent = { state: "absent" },
      browser: ComputerComponent = { state: "absent" }
    const budget = new ComputerBudget()
    if (data.state === "established") budget.consume(data.entries, data.bytes)
    if (sharedManifest) {
      progress?.stage("prepare", "shared")
      const next = join(input.sharedStage, "next")
      await restoreBotDirectory(
        join(input.pointRoot, "shared", "files"),
        next,
        sharedManifest.entries,
        { assertCurrent: () => input.owner.assertCurrent() }
      )
      const reference = { id: sharedManifest.workspaceId, identity: await rootIdentity(next) }
      replacementShared = {
        state: "established",
        reference,
        recordSha256: BotSharedWorkspace.recoveryRecordHash(reference)
      }
      shared = await copyPreparedManifest(input, "shared", sharedManifest, components.shared)
      budget.consume(sharedManifest.entries.length, treeBytes(sharedManifest.entries))
    }
    if (browserManifest) {
      progress?.stage("prepare", "browser")
      if (
        browserManifest.originId !==
        (await browserCheckpointOrigin(input.directory, () => input.owner.assertCurrent(), false))
      )
        throw failed()
      await restoreBotDirectory(
        join(input.pointRoot, "browser", "profile"),
        join(input.hostStage, "next", "browser-profile"),
        browserManifest.entries,
        { maxBytes: COMPUTER_BROWSER_BYTES, assertCurrent: () => input.owner.assertCurrent() }
      )
      browser = await copyPreparedManifest(input, "browser", browserManifest, components.browser)
      budget.consume(browserManifest.entries.length, treeBytes(browserManifest.entries))
    }
    progress?.stage("prepare", "managed")
    const managed = await prepareManaged(input, components.managed, budget)
    return {
      components: { data, shared, browser, managed: managed.component },
      originalShared,
      replacementShared,
      sharedTargetId:
        replacementShared.state === "established"
          ? replacementShared.reference.id
          : originalShared.state === "established"
            ? originalShared.reference.id
            : undefined,
      managedRecoveryId: managed.managedRecoveryId
    }
  },
  async verifyPrepared(input, prepared, locations) {
    const data = await readPrepared(input, "data", prepared.components.data, (value) =>
      computerDataManifest.parse(value)
    )
    if (data) await verifyComputerData(join(input.hostStage, "next"), data, native, locations)
    const shared = await readPrepared(input, "shared", prepared.components.shared, (value) =>
      computerSharedManifest.parse(value)
    )
    if (shared) {
      const path = locations.get("shared")
      if (
        !path ||
        prepared.replacementShared.state !== "established" ||
        shared.workspaceId !== prepared.replacementShared.reference.id
      )
        throw failed()
      await verifyBotDirectory(path, shared.entries)
    }
    const browser = await readPrepared(input, "browser", prepared.components.browser, (value) =>
      computerBrowserManifest.parse(value)
    )
    if (browser) {
      const path = locations.get("browser")
      if (
        !path ||
        browser.originId !==
          (await browserCheckpointOrigin(input.directory, () => input.owner.assertCurrent(), false))
      )
        throw failed()
      await verifyBotDirectory(path, browser.entries)
    }
    await verifyManagedPrepared(input, prepared)
  },
  async publishShared(input, prepared) {
    await BotSharedWorkspace.replaceControlForRecovery(
      input.directory,
      prepared.originalShared,
      prepared.replacementShared,
      async () => {
        await input.owner.checkCurrent()
        input.owner.assertCurrent()
      }
    )
  },
  async verifySharedRecord(input, prepared) {
    const current = await BotSharedWorkspace.inspectForRecovery(input.directory)
    if (
      current.state !== prepared.replacementShared.state ||
      (current.state === "established" &&
        prepared.replacementShared.state === "established" &&
        current.recordSha256 !== prepared.replacementShared.recordSha256)
    )
      throw failed()
  },
  publishManaged
})
