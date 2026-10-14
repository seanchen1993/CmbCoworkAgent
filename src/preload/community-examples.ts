import type { CommunityExamplesApi } from "../shared/mods/community-examples"

export function createCommunityExamplesBridge(
  invoke: (channel: string, input: unknown) => Promise<unknown>
): CommunityExamplesApi {
  return {
    list: () =>
      invoke("mods:community-examples:list", undefined) as ReturnType<CommunityExamplesApi["list"]>,
    install: (input) =>
      invoke("mods:community-examples:install", input) as ReturnType<
        CommunityExamplesApi["install"]
      >
  }
}
