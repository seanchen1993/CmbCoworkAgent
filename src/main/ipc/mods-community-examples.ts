import { getPlugins } from "../storage"
import { readCommunityExampleInstallations } from "../mods/community-example-installations"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import {
  BUNDLED_EXAMPLES,
  communityExampleId,
  verifyCommunityExample,
  withMaterializedCommunityExample
} from "../mods/community-examples"
import { installBundledCommunityPlugin } from "./plugins"

export function registerCommunityExampleHandlers(
  ipc: Pick<IpcMain, "handle">,
  root: string,
  trusted: (event: IpcMainInvokeEvent) => void
): void {
  ipc.handle("mods:community-examples:list", async (event) => {
    trusted(event)
    return {
      examples: await readCommunityExampleInstallations(
        BUNDLED_EXAMPLES,
        getPlugins(),
        (id, directory) => verifyCommunityExample(root, id, directory)
      )
    }
  })
  ipc.handle("mods:community-examples:install", async (event, input: unknown) => {
    trusted(event)
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      !Object.hasOwn(input, "exampleId")
    )
      throw Error("MODS_COMMUNITY_EXAMPLE_INVALID")
    const id = communityExampleId((input as { exampleId: unknown }).exampleId)
    const example = BUNDLED_EXAMPLES.find((row) => row.id === id)!
    const frame = event.sender.mainFrame
    const assertCurrent = () => {
      trusted(event)
      if (event.sender.mainFrame !== frame) throw Error("MODS_IPC_SENDER")
    }
    return withMaterializedCommunityExample(root, id, async (directory) => {
      assertCurrent()
      return installBundledCommunityPlugin(
        directory,
        example.pluginName,
        (target) => verifyCommunityExample(root, id, target),
        assertCurrent
      )
    })
  })
}
