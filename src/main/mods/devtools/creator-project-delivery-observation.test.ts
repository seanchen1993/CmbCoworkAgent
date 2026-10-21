import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { PluginMetadata } from "../../types"
import {
  observeProjectDeliveryInstallation,
  readProjectDeliveryInventory
} from "../../plugins/plugin-delivery-observation"

const cleanups: string[] = []
afterEach(async () => {
  for (const root of cleanups.splice(0)) await rm(root, { recursive: true, force: true })
})
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "delivery-observation-"))
  cleanups.push(root)
  return root
}
const missing = () => {
  throw Object.assign(Error("inventory missing"), { code: "ENOENT" })
}

describe("project delivery native inventory observation", () => {
  it("permits pristine first installation while retaining missing registry with disk copies as unknown", async () => {
    const root = await directory()
    expect(readProjectDeliveryInventory(root, missing, () => [])).toEqual([])
    await writeFile(join(root, "other-installed-copy"), "orphan source")
    expect(() => readProjectDeliveryInventory(root, missing, () => [])).toThrow("inventory missing")
  })

  it("never treats parse, access and filtered or duplicated inventory records as empty", async () => {
    const root = await directory()
    for (const cause of [
      SyntaxError("broken registry"),
      Object.assign(Error("denied"), { code: "EACCES" })
    ])
      expect(() =>
        readProjectDeliveryInventory(
          root,
          () => {
            throw cause
          },
          () => []
        )
      ).toThrow(cause)
    expect(() =>
      readProjectDeliveryInventory(
        root,
        () => new Set(["installed"]),
        () => []
      )
    ).toThrow("INVENTORY_INVALID")
    expect(() => readProjectDeliveryInventory(root, () => new Set(["installed"]), missing)).toThrow(
      "inventory missing"
    )
    const item = { id: "same", name: "plugin", path: root } as PluginMetadata
    expect(() =>
      readProjectDeliveryInventory(
        root,
        () => new Set(["same", "other"]),
        () => [item, item]
      )
    ).toThrow("INVENTORY_INVALID")
  })

  it("does not admit a pristine-looking installation root through a directory junction", async () => {
    const root = await directory()
    const target = join(root, "target")
    await mkdir(target)
    const link = join(root, "link")
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir")
    expect(() => readProjectDeliveryInventory(link, missing, () => [])).toThrow("inventory missing")
  })

  it("keeps a native numeric collision directory unresolved instead of authorizing another attempt", async () => {
    const root = await directory()
    await mkdir(join(root, "new-plugin-12"))
    const observed = await observeProjectDeliveryInstallation(
      root,
      () => [],
      {
        pluginId: "wanted",
        name: "new-plugin",
        version: "1.0.0",
        digest: "a".repeat(64)
      },
      () => {}
    )
    expect(observed).toMatchObject({
      outcome: "conflict",
      reason: "PROJECT_DELIVERY_INSTALL_DIRECTORY_UNCONFIRMED"
    })
  })

  it("rejects inventory mutation between disk inspection and publication", async () => {
    const root = await directory()
    let reads = 0
    await expect(
      observeProjectDeliveryInstallation(
        root,
        () =>
          ++reads === 1
            ? []
            : [
                {
                  id: "late",
                  name: "late",
                  path: root
                } as PluginMetadata
              ],
        {
          pluginId: "wanted",
          name: "new-plugin",
          version: "1.0.0",
          digest: "a".repeat(64)
        },
        () => {}
      )
    ).rejects.toThrow("OBSERVATION_CHANGED")
  })
})
