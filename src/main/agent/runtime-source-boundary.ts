import { createMiddleware } from "langchain"

/** A content fence at execution boundaries, separate from inexpensive runtime identity getters. */
export function createRuntimeSourceBoundary(
  assertContent: (() => void) | undefined,
  onModelBoundary?: () => void
) {
  const modelBoundary = () => {
    assertContent?.()
    onModelBoundary?.()
    return undefined
  }
  return createMiddleware({
    name: "hostSourceBoundary",
    beforeModel: modelBoundary,
    afterModel: modelBoundary,
    wrapToolCall: async (request, handler) => {
      assertContent?.()
      try {
        return await handler(request)
      } finally {
        assertContent?.()
      }
    }
  })
}

/** Restricted file/prompt runtimes own their middleware, so extend their existing profile fence. */
export function bindRuntimeSourceProfile<T extends { assertCurrent(): void }>(
  profile: T,
  assertContent: (() => void) | undefined
): T {
  if (!assertContent) return profile
  return {
    ...profile,
    assertCurrent: () => {
      assertContent()
      profile.assertCurrent()
    }
  }
}
