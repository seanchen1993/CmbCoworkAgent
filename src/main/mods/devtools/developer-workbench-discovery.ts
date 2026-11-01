import {
  DEVELOPER_CODE_CAPABILITY_REF,
  DEVELOPER_CODE_LIMITS,
  DEVELOPER_CODE_METHODS,
  developerCodeInputSchema
} from "../../../shared/mods/v2/developer-code-capability"

/** Public protocol descriptions only. Discovery never resolves a server, file or permission. */
export function developerWorkbenchDiscovery(query: string, cursor: number) {
  let description: unknown
  if (
    query === "native.code" ||
    DEVELOPER_CODE_METHODS.some((method) => query === `native.code.${method}`)
  ) {
    const methods =
      query === "native.code"
        ? DEVELOPER_CODE_METHODS
        : DEVELOPER_CODE_METHODS.filter((method) => query === `native.code.${method}`)
    description = {
      ref: DEVELOPER_CODE_CAPABILITY_REF,
      invocation:
        "Use platform.read for actual availability; platform.act with this ref/action/input and a new requestKey for a fresh query. No $.native.code SDK exists.",
      actions: methods.map((id) => ({
        id,
        inputSchema: developerCodeInputSchema(id),
        outputSchema: { type: "object" },
        requiredPermissions: ["platform.read"],
        cancellable: true,
        idempotency: "keyed"
      })),
      limits: DEVELOPER_CODE_LIMITS,
      scope:
        "Current workspace/thread/source only; Java service must already be running. No automatic install/start.",
      observation:
        "1-based line/UTF-16 column; historical observations, explicit truncation. Cached diagnostics have versionUnknown; empty does not prove no errors for this file version.",
      cancellation:
        "Ending the wait is not proof the native query stopped; unsettled queries retain admission. Unknown results never replay automatically."
    }
  } else if (query === "native.editor" || query === "native.editor.preview") {
    description = {
      ref: { provider: "native.editor", id: "navigation", version: "1.0.0" },
      actions: [
        {
          id: "preview",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string", minLength: 1, maxLength: 512 },
              line: { type: "integer", minimum: 1, maximum: 100000 },
              column: { type: "integer", minimum: 1, maximum: 100000 }
            },
            required: ["path"]
          },
          outputSchema: { type: "object" },
          requiredPermissions: ["platform.read"],
          cancellable: true,
          idempotency: "keyed"
        }
      ],
      invocation:
        "platform.act; visible effect, unavailable in query-only callbacks. Relative workspace path only; original read policy still applies.",
      preview:
        "64KiB safe source text; preview-loaded requires real renderer line/column acknowledgement. No HTML script execution.",
      external:
        "Only the native preview's explicit user button can request the fixed configured IDE; external display remains unknown. Windows shell-sensitive/whitespace paths remain source-preview only.",
      receipt:
        "Historical navigation receipt; use a new requestKey to open again. Revocation, reload or scope changes retire the preview."
    }
  } else if (query === "native.workspace") {
    description = {
      ref: { provider: "native.workspace", id: "changes", version: "1.0.0" },
      actions: [],
      invocation:
        "platform.read/subscribe/poll/unsubscribe; no scan/start action. Native state and events are isolated to the exact caller.",
      state: { kind: "status", observing: "boolean", observationId: "opaque string or null" },
      events:
        "patch: allowed upserts[{path,size,modifiedAt}]/deletes[path], or invalidate(resyncRequired). Observed facts, not add/change classification or final deletion proof.",
      limits: { paths: 128, outputBytes: 15000, queuedBatches: 4, queuedBytes: 65536 },
      availability:
        "Uses the existing physical watcher. Missing, stopped, evicted or replaced-root watcher is not observing; subscribing never starts a scan or watcher.",
      policy:
        "Original path policy is checked for publication and cached poll; overflow/rescan requires authoritative reread, never a fabricated exact event."
    }
  } else return undefined
  const content = JSON.stringify(description, null, 2)
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > content.length)
    throw Error("DEVELOPMENT_CATALOG_CURSOR")
  const end = Math.min(cursor + 5500, content.length)
  return {
    query,
    kind: "native-capability",
    matched: true,
    declarationAvailable: false,
    descriptorAvailable: true,
    grantsAuthority: false,
    events: [],
    sdkMethods: [],
    runtimeExports: [],
    content: content.slice(cursor, end),
    totalCharacters: content.length,
    complete: end === content.length,
    ...(end < content.length ? { nextCursor: end } : {}),
    discovery:
      "Static public protocol, not an execution grant. Query platform.list/read after authorization for actual runtime availability; this is not a new SDK namespace."
  }
}
