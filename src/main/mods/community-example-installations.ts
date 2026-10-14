import type { CommunityExample, CommunityExampleId } from "../../shared/mods/community-examples"

/** Read-only inventory; a same-name plugin is never trusted without checking its exact files. */
export async function readCommunityExampleInstallations(
  examples: readonly CommunityExample[],
  plugins: readonly { id: string; name: string; path: string }[],
  verify: (id: CommunityExampleId, directory: string) => Promise<unknown>
): Promise<CommunityExample[]> {
  return Promise.all(
    examples.map(async (example) => {
      const matches = plugins.filter((plugin) => plugin.name === example.pluginName)
      if (!matches.length) return { ...example, installation: { state: "missing" as const } }
      if (matches.length === 1) {
        try {
          await verify(example.id, matches[0].path)
          return {
            ...example,
            installation: {
              state: "installed" as const,
              pluginId: matches[0].id
            }
          }
        } catch {
          /* A changed, missing or unreadable installed tree must be reviewed. */
        }
      }
      return { ...example, installation: { state: "conflict" as const } }
    })
  )
}
