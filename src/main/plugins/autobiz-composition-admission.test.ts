import { expect, it, vi } from "vitest"
import { writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { withPinnedAutobiz } from "../mods/v2/autobiz-source"
import { snapshotDerivationSource } from "./derivation-source"
import { prepareFlowCompositionFiles } from "./derivation-flow-composition"
import { readNativeCapabilityCatalog } from "./capability-catalog"
import { readProjectCompositionCatalog } from "./project-composition-catalog"
import { preflightLegacyCompositionSource } from "../harness-board/project-runtime/composition-legacy-preflight"
import type { PluginMetadata } from "../types"
vi.mock("../storage", () => ({ parsePluginHooks: () => [], parseMcpJsonFile: () => null }))

it("admits only the reviewed original commands and code, and rejects source edits before execution", async () => {
  await withPinnedAutobiz(undefined, async (path) => {
    const snapshot = await snapshotDerivationSource(path)
    const metadata = JSON.parse(
      snapshot.files.find((file) => file.path === snapshot.manifests[0])!.bytes.toString("utf8")
    )
    for (const file of prepareFlowCompositionFiles(snapshot).files)
      await writeFile(join(path, file.path), file.after, { flag: "wx" })
    const plugin = {
      path,
      name: metadata.name,
      version: metadata.version,
      id: "local-reviewed",
      enabled: true
    } as PluginMetadata
    const catalog = await readNativeCapabilityCatalog(plugin, "project")
    expect(catalog.status, catalog.reasons.join()).toBe("declared")
    expect(catalog.legacyAdapter).toBe("autobiz-v1")
    const source = (await readProjectCompositionCatalog([plugin])).sources[0]
    expect(source.entry.available).toBe(process.platform === "win32")
    if (process.platform === "win32") await preflightLegacyCompositionSource(plugin)
    else
      await expect(preflightLegacyCompositionSource(plugin)).rejects.toThrow("PLATFORM_UNSUPPORTED")
    const boardPath = join(path, "board_core/board_config.json")
    const original = await readFile(boardPath)
    const board = JSON.parse(original.toString("utf8"))
    board.inspectCommands.win32.create_feature = "python another-driver.py"
    await writeFile(boardPath, JSON.stringify(board))
    expect((await readProjectCompositionCatalog([plugin])).sources[0].entry.available).toBe(false)
    if (process.platform === "win32")
      await expect(preflightLegacyCompositionSource(plugin)).rejects.toThrow("PROTOCOL_UNSUPPORTED")
    await writeFile(boardPath, original)
    await writeFile(join(path, "hooks/state_checkpoint.py"), "changed")
    expect((await readProjectCompositionCatalog([plugin])).sources[0].entry.available).toBe(false)
    if (process.platform === "win32")
      await expect(preflightLegacyCompositionSource(plugin)).rejects.toThrow("PROTOCOL_UNSUPPORTED")
  })
}, 60000)
