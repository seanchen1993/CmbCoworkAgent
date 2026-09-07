import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

async function main(): Promise<void> {
  const source = await readFile(
    resolve("src/renderer/src/components/requirement/RequirementConversationView.tsx"),
    "utf8"
  )

  const loaderStart = source.indexOf("const loadRequirementSpaceManifest")
  const loaderEnd = source.indexOf("  const handlePublishToRequirementSpace", loaderStart)
  assert(loaderStart >= 0, "manifest loader should exist")
  assert(loaderEnd > loaderStart, "manifest loader boundary should be identifiable")

  const loader = source.slice(loaderStart, loaderEnd)
  assert(
    loader.includes("requirements.beginManifestSync"),
    "manifest reads must register their request"
  )
  assert(
    loader.includes("requirements.syncManifest"),
    "manifest reads must sync the requirement index"
  )
  assert(
    loader.includes("threadId: requestThreadId") && loader.includes("requestId"),
    "manifest sync must carry the session and request identity"
  )
  assert(
    loader.includes("manifestCanSync") && loader.includes("if (manifestCanSync)"),
    "missing or invalid manifests must not overwrite the requirement index"
  )
  assert(
    loader.includes("globalThis.crypto.randomUUID()"),
    "manifest sync requests must use a component-instance-independent token"
  )
  assert(
    loader.includes("requestId === manifestRequestRef.current") &&
      loader.includes("requestThreadId === currentThreadIdRef.current"),
    "session manifest reads must reject stale request results"
  )

  const resetMarker = "conversationLoadingObservedRef.current = false"
  const resetMarkerIndex = source.indexOf(resetMarker)
  const threadResetStart = source.lastIndexOf("  useEffect(() => {", resetMarkerIndex)
  const threadResetEnd = source.indexOf("  useEffect(() => {", threadResetStart + 1)
  const threadReset = source.slice(threadResetStart, threadResetEnd)
  assert(
    threadReset.includes("setRequirementSpaceManifest(null)") &&
      threadReset.includes("setManifestThreadId(null)") &&
      threadReset.includes('setPreviewTab("source")'),
    "switching conversations must clear session manifest UI state"
  )

  console.log("requirement-manifest-loading: all assertions passed")
}

void main()
