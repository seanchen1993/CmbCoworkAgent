import { resolve } from "node:path"
import {
  BUNDLED_EXAMPLES,
  PLATFORM_EXAMPLES,
  verifyCommunityExample
} from "../mods/community-examples"
import { mirrorRequiredDirectorySync } from "./directory-mirror"

/** Use the install catalogue for packaging too, then reject stale pins before shipping. */
export async function mirrorBundledModExamples(
  projectDirectory: string,
  destination: string
): Promise<void> {
  mirrorRequiredDirectorySync(
    resolve(projectDirectory, "resources/mods/community-originals"),
    resolve(destination, "community-originals")
  )
  for (const example of PLATFORM_EXAMPLES) {
    if (example.origin !== "devclaw") throw Error("Invalid platform example provenance")
    mirrorRequiredDirectorySync(
      resolve(projectDirectory, example.sourcePath),
      resolve(destination, "platform-examples", example.id)
    )
  }
  for (const example of BUNDLED_EXAMPLES) {
    try {
      await verifyCommunityExample(resolve(destination, "community-originals"), example.id)
    } catch (cause) {
      throw new Error(`Bundled example failed packaging verification: ${example.id}`, { cause })
    }
  }
}
