import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { types } from "node:util"
import { AuthoringDraftStore, type AuthoringDraft } from "../mods/devtools/authoring-store"
import { createAuthoringSourceBundle } from "../mods/devtools/authoring-bundle"
import {
  createAuthoringTemplate,
  type AuthoringTemplateKind
} from "../mods/devtools/authoring-templates"
import type { AuthoringDocument, AuthoringSummary } from "../../shared/mods/authoring"

function payload(
  value: unknown,
  required: string[],
  optional: string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value))
    throw Error("AUTHORING_INPUT_INVALID")
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw Error("AUTHORING_INPUT_INVALID")
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || ![...required, ...optional].includes(key)
    ) ||
    required.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some((item) => !("value" in item) || !item.enumerable)
  )
    throw Error("AUTHORING_INPUT_INVALID")
  return Object.fromEntries(Object.entries(descriptors).map(([key, item]) => [key, item.value]))
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value))
    throw Error("AUTHORING_INPUT_INVALID")
  return value
}
function revision(value: unknown, allowZero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1))
    throw Error("AUTHORING_INPUT_INVALID")
  return Number(value)
}
function summary(draft: AuthoringDraft): AuthoringSummary {
  return {
    id: draft.id,
    name: draft.name,
    currentRevision: draft.currentRevision,
    updatedAt: draft.versions.at(-1)!.createdAt
  }
}
function document(
  workspace: string,
  draft: AuthoringDraft,
  selected = draft.currentRevision
): AuthoringDocument {
  const version = draft.versions.find((item) => item.revision === selected)
  if (!version) throw Error("AUTHORING_VERSION_MISSING")
  return {
    ...summary(draft),
    workspace,
    revision: selected,
    source: version.source,
    versions: draft.versions.map(({ revision, createdAt, source, restoredFrom }) => ({
      revision,
      createdAt,
      digest: source.digest,
      ...(restoredFrom === undefined ? {} : { restoredFrom })
    }))
  }
}

/** Draft text only. No runtime preparation, installation, grants or composition changes. */
export function registerModsAuthoringHandlers(
  ipc: IpcMain,
  store: AuthoringDraftStore,
  access: {
    trusted(event: IpcMainInvokeEvent): void
    threadScope(threadId: string): string
  }
): void {
  const register = (
    operation: string,
    fields: string[],
    run: (row: Record<string, unknown>, workspace: string, assertCurrent: () => void) => unknown,
    optional: string[] = []
  ) => {
    ipc.handle(`mods:authoring-${operation}`, (event, input: unknown) => {
      try {
        access.trusted(event)
        const row = payload(input, ["threadId", ...fields], optional)
        if (typeof row.threadId !== "string" || !row.threadId || row.threadId.length > 200)
          throw Error("AUTHORING_INPUT_INVALID")
        const threadId = row.threadId
        const workspace = access.threadScope(threadId)
        if (!workspace || (operation !== "list" && row.expectedWorkspace !== workspace))
          throw Error("AUTHORING_SCOPE_CHANGED")
        const assertCurrent = () => {
          access.trusted(event)
          if (access.threadScope(threadId) !== workspace) throw Error("AUTHORING_SCOPE_CHANGED")
        }
        const result = run(row, workspace, assertCurrent)
        assertCurrent()
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : ""
        const publicErrors = [
          "AUTHORING_VERSION_CHANGED",
          "AUTHORING_VERSION_MISSING",
          "AUTHORING_SCOPE_CHANGED",
          "AUTHORING_INPUT_INVALID",
          "AUTHORING_DRAFT_LIMIT",
          "AUTHORING_VERSION_LIMIT",
          "AUTHORING_STORAGE_LIMIT",
          "AUTHORING_SOURCE_LIMIT",
          "AUTHORING_SOURCE_PATH",
          "AUTHORING_SOURCE_COLLISION",
          "AUTHORING_SOURCE_TEXT",
          "AUTHORING_PLUGIN_MANIFEST_REQUIRED",
          "AUTHORING_TEMPLATE_INPUT"
        ]
        throw Error(publicErrors.includes(message) ? message : "AUTHORING_REQUEST_FAILED")
      }
    })
  }
  register("list", [], (_row, workspace) => ({
    workspace,
    drafts: store.list(workspace).map(summary)
  }))
  register(
    "read",
    ["expectedWorkspace", "id"],
    (row, workspace) => {
      const draft = store.list(workspace).find((item) => item.id === id(row.id))
      if (!draft) throw Error("AUTHORING_VERSION_MISSING")
      return document(
        workspace,
        draft,
        row.revision === undefined ? undefined : revision(row.revision)
      )
    },
    ["revision"]
  )
  register("generate", ["expectedWorkspace", "id", "name", "instruction", "kind"], (row) =>
    createAuthoringTemplate({
      id: id(row.id),
      name: row.name as string,
      instruction: row.instruction as string,
      kind: row.kind as AuthoringTemplateKind
    })
  )
  for (const operation of ["prune", "remove"] as const)
    register(operation, ["expectedWorkspace", "id", "expectedRevision", "expectedSourceDigest",
      "acknowledgeHistoryLoss"], (row, workspace, assertCurrent) => {
      if (row.acknowledgeHistoryLoss !== true || typeof row.expectedSourceDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(row.expectedSourceDigest)) throw Error("AUTHORING_INPUT_INVALID")
      const input = { workspace, id: id(row.id), expectedRevision: revision(row.expectedRevision),
        expectedSourceDigest: row.expectedSourceDigest, acknowledgeHistoryLoss: true, assertCurrent }
      if (operation === "remove") return store.remove(input)
      return document(workspace, store.prune(input))
    })
  register(
    "save",
    ["expectedWorkspace", "id", "name", "expectedRevision", "files"],
    (row, workspace, assertCurrent) =>
      document(
        workspace,
        store.save({
          workspace,
          id: id(row.id),
          name: row.name as string,
          expectedRevision: revision(row.expectedRevision, true),
          source: createAuthoringSourceBundle(row.files),
          assertCurrent
        })
      )
  )
  register(
    "restore",
    ["expectedWorkspace", "id", "expectedRevision", "sourceRevision"],
    (row, workspace, assertCurrent) =>
      document(
        workspace,
        store.restore({
          workspace,
          id: id(row.id),
          expectedRevision: revision(row.expectedRevision),
          sourceRevision: revision(row.sourceRevision),
          assertCurrent
        })
      )
  )
}
