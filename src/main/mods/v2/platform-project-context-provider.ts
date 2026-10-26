import { lstatSync, opendirSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import {
  runtimeDirectoryIdentity,
  runtimeRelativePath,
  runtimeDigest
} from "../../harness-board/project-runtime/safe-files"
import { readScopedContextContent } from "../../harness-board/project-runtime/package-context-content"
import {
  nativeProjectContext,
  nativeProjectContextAccessScope,
  consumeNativeProjectContextBudget
} from "./project-context-scope"
import type {
  NativePlatformCallContext,
  NativePlatformCapabilityProvider
} from "./platform-capabilities-types"

const sensitive =
  /^(?:\..*|(?:credentials?|secrets?|tokens?|passwords?|authorized_keys|known_hosts)(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i
const input = z
  .object({
    rootId: z.string().min(1).max(64),
    path: z.string().max(512).optional(),
    offset: z.number().int().min(0).max(512).optional(),
    limit: z.number().int().min(1).max(32).optional()
  })
  .strict()
const fileInput = z
  .object({ rootId: z.string().min(1).max(64), path: z.string().min(1).max(512) })
  .strict()
function safePath(path: string): string {
  runtimeRelativePath(path)
  if (path.split("/").some((part) => sensitive.test(part)))
    throw Error("PROJECT_CONTEXT_PATH_DENIED")
  return path
}
function rootFor(context: NativePlatformCallContext, id: string) {
  const root = nativeProjectContext(context).roots.find((root) => root.id === id)
  if (!root) throw Error("PROJECT_CONTEXT_ROOT_UNKNOWN")
  // Host-approved roots still cannot expose credential directories.
  if (
    root.path
      .replace(/\\/g, "/")
      .split("/")
      .some((part) => /^(?:\.ssh|\.aws|\.azure|\.gnupg|\.git|credentials?|secrets?)$/i.test(part))
  )
    throw Error("PROJECT_CONTEXT_ROOT_DENIED")
  return root
}

/** Read-only view of the exact material roots bound by the current Host context action. */
export function createNativeProjectContextPlatformProvider(): NativePlatformCapabilityProvider {
  return {
    provider: "native.project-context",
    digest: "native.project-context/materials/1.0.0",
    accessScope: nativeProjectContextAccessScope,
    descriptor: {
      apiVersion: "devclaw.capability/v1",
      id: "materials",
      version: "1.0.0",
      title: "原生上下文材料",
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: [
        {
          id: "list",
          title: "列出已绑定材料",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["rootId"],
            properties: {
              rootId: { type: "string", maxLength: 64 },
              path: { type: "string", maxLength: 512 },
              offset: { type: "integer", minimum: 0, maximum: 512 },
              limit: { type: "integer", minimum: 1, maximum: 32 }
            }
          },
          outputSchema: { type: "object" },
          requiredPermissions: ["platform.read"],
          cancellable: true,
          idempotency: "keyed"
        },
        {
          id: "read",
          title: "读取已绑定材料",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["rootId", "path"],
            properties: {
              rootId: { type: "string", maxLength: 64 },
              path: { type: "string", maxLength: 512 }
            }
          },
          outputSchema: { type: "object" },
          requiredPermissions: ["platform.read"],
          cancellable: true,
          idempotency: "keyed"
        }
      ]
    },
    read(context) {
      const scope = nativeProjectContext(context)
      const result = {
        stageId: scope.stageId,
        roots: scope.roots.map(({ id, label }) => ({ id, ...(label ? { label } : {}) })),
        configuration: structuredClone(scope.configuration)
      }
      consumeNativeProjectContextBudget(context, Buffer.byteLength(JSON.stringify(result)))
      return result
    },
    async act(context, action, raw) {
      if (action === "read") {
        const request = fileInput.parse(raw),
          root = rootFor(context, request.rootId)
        const path = safePath(request.path)
        const file = readScopedContextContent(root.path, path, 8000, root.source === "package")
        if (!file.present || !file.bytes || !file.content) throw Error("PROJECT_CONTEXT_FILE_MISSING")
        const text = new TextDecoder("utf-8", { fatal: true }).decode(file.content)
        if (text.includes("\0")) throw Error("PROJECT_CONTEXT_TEXT_INVALID")
        const result = {
          rootId: root.id,
          path,
          text,
          bytes: file.content.length,
          digest: runtimeDigest(file.bytes)
        }
        if (Buffer.byteLength(JSON.stringify(result)) > 12_000)
          throw Error("PROJECT_CONTEXT_FILE_LIMIT")
        consumeNativeProjectContextBudget(context, file.content.length)
        return result
      }
      if (action !== "list") throw Error("PROJECT_CONTEXT_ACTION_UNKNOWN")
      const request = input.parse(raw),
        root = rootFor(context, request.rootId)
      const path = request.path ? safePath(request.path) : ""
      const parents = [root.path]
      for (const part of path ? path.split("/") : [])
        parents.push(join(parents[parents.length - 1], part))
      const identities = parents.map(runtimeDirectoryIdentity)
      const directory = parents[parents.length - 1]
      const before = lstatSync(directory, { bigint: true })
      const handle = opendirSync(directory)
      const entries: Array<{
        name: string
        path: string
        kind: "file" | "directory"
        bytes?: number
      }> = []
      let count = 0
      try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          if (++count > 512) throw Error("PROJECT_CONTEXT_DIRECTORY_LIMIT")
          if (sensitive.test(entry.name)) continue
          const relative = path ? path + "/" + entry.name : entry.name
          safePath(relative)
          const full = join(directory, entry.name),
            stat = lstatSync(full)
          if (
            stat.isSymbolicLink() ||
            (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
          )
            continue
          if (stat.isDirectory()) runtimeDirectoryIdentity(full)
          entries.push({
            name: entry.name,
            path: relative,
            kind: stat.isDirectory() ? "directory" : "file",
            ...(stat.isFile() ? { bytes: stat.size } : {})
          })
        }
      } finally {
        handle.closeSync()
      }
      const after = lstatSync(directory, { bigint: true })
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        parents.some((parent, i) => runtimeDirectoryIdentity(parent) !== identities[i])
      )
        throw Error("PROJECT_CONTEXT_DIRECTORY_CHANGED")
      entries.sort((a, b) => a.path.localeCompare(b.path, "en"))
      const offset = request.offset ?? 0,
        end = offset + (request.limit ?? 32)
      const page = entries.slice(offset, end)
      while (Buffer.byteLength(JSON.stringify(page)) > 11_000) page.pop()
      const next = offset + page.length
      const result = {
        rootId: root.id,
        path,
        entries: page,
        nextOffset: next < entries.length ? next : null
      }
      consumeNativeProjectContextBudget(context, Buffer.byteLength(JSON.stringify(result)))
      return result
    }
  }
}
