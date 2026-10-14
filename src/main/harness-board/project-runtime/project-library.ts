import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname, posix } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type {
  HostProjectOperation,
  HostProjectState
} from "../../../shared/project-runtime/host-types"
import type { ProjectLibraryEntry } from "../../../shared/project-runtime/project-library"
import { readRuntimeScopedFile, runtimeDigest, runtimeRelativePath } from "./safe-files"

const MAX_BYTES = 16 * 1024 * 1024
function fail(reason: string): never {
  throw Error(`PROJECT_LIBRARY_${reason}`)
}

export function projectDeliveryDestination(endpoint: string, remotePath: string) {
  if (typeof endpoint !== "string" || endpoint.length > 2048 || typeof remotePath !== "string")
    fail("DESTINATION_INVALID")
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return fail("DESTINATION_INVALID")
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    fail("DESTINATION_INVALID")
  runtimeRelativePath(remotePath)
  return { endpoint: url.href, remotePath }
}

/** Own database; opened on explicit library actions, never on chat tokens or project polling. */
export class ProjectLibrary {
  private readonly db: DatabaseSync
  private readonly active = new Set<string>()
  constructor(
    path: string,
    private readonly upload: typeof fetch = fetch
  ) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path, { timeout: 1000 })
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entries_project ON entries(project_id);
      CREATE TABLE IF NOT EXISTS files (entry_id TEXT NOT NULL, path TEXT NOT NULL, bytes BLOB NOT NULL,
        PRIMARY KEY(entry_id,path));`)
    // A crash during a POST has an unknown remote outcome. Never retry automatically.
    for (const row of this.db
      .prepare("SELECT data FROM entries WHERE json_extract(data,'$.status')='sending'")
      .all()) {
      const entry: ProjectLibraryEntry = JSON.parse(String(row.data))
      if (entry.status !== "sending") continue
      entry.status = "unknown"
      entry.error = "应用上次发送时退出，请先核对接收方，再决定是否重试。"
      this.save(entry)
    }
  }
  close() {
    this.db.close()
  }
  private save(entry: ProjectLibraryEntry) {
    this.db
      .prepare("INSERT OR REPLACE INTO entries(id,project_id,data) VALUES (?,?,?)")
      .run(entry.id, entry.projectId, JSON.stringify(entry))
  }
  list(projectId: string): ProjectLibraryEntry[] {
    return this.db
      .prepare("SELECT data FROM entries WHERE project_id=? ORDER BY rowid DESC LIMIT 50")
      .all(projectId)
      .map((row) => JSON.parse(String(row.data)))
  }
  private entry(projectId: string, id: string): ProjectLibraryEntry {
    const row = this.db
      .prepare("SELECT data FROM entries WHERE project_id=? AND id=?")
      .get(projectId, id)
    if (!row) fail("NOT_FOUND")
    return JSON.parse(String(row!.data))
  }
  capture(
    project: HostProjectState,
    operation: HostProjectOperation,
    input: {
      kind: "knowledge" | "delivery"
      title: string
      note: string
    }
  ): ProjectLibraryEntry {
    if (
      !input ||
      !["knowledge", "delivery"].includes(input.kind) ||
      typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.length > 100 ||
      typeof input.note !== "string" ||
      input.note.length > 4000
    )
      fail("INPUT_INVALID")
    if (
      operation.projectId !== project.projectId ||
      operation.pluginDigest !== project.pluginDigest ||
      !["succeeded", "transitioned"].includes(operation.status)
    )
      fail("CHECK_REQUIRED")
    const stage = project.manifest.stages.find((value) => value.id === operation.stageId)
    if (!stage || !stage.artifactIds.length || !stage.checkIds.length) fail("CHECK_REQUIRED")
    if (this.list(project.projectId).length >= 50) fail("LIMIT")
    let total = 0
    const captured = stage.artifactIds.map((id) => {
      const artifact = project.manifest.artifacts.find((value) => value.id === id)!
      if (
        artifact.path
          .split("/")
          .some((part) =>
            /^(?:\.env.*|\.git|\.git-credentials|\.ssh|\.aws|\.azure|\.npmrc|\.pypirc|\.netrc|credentials.*|secrets?.*|id_(?:rsa|dsa|ecdsa|ed25519).*)$/iu.test(
              part
            )
          )
      )
        fail("SENSITIVE_PATH")
      if (artifact.path.toLowerCase() === "devclaw_artifact_catalog.json") fail("RESERVED_PATH")
      const file = readRuntimeScopedFile(project.workspace, artifact.path, 5 * 1024 * 1024)
      total += file.bytes?.length ?? 0
      if (total > MAX_BYTES) fail("LIMIT")
      const checks = project.manifest.checks.filter(
        (check) => stage.checkIds.includes(check.id) && check.artifactId === id
      )
      if (
        !file.bytes ||
        !checks.length ||
        checks.some(
          (check) =>
            !operation.receipts.some(
              (receipt) =>
                receipt.checkId === check.id &&
                receipt.result === "passed" &&
                receipt.artifactFingerprint === file.fingerprint
            )
        )
      )
        fail("EVIDENCE_STALE")
      return { path: artifact.path, bytes: file.bytes! }
    })
    const entry: ProjectLibraryEntry = {
      id: randomUUID(),
      projectId: project.projectId,
      operationId: operation.operationId,
      stageId: operation.stageId,
      kind: input.kind,
      title: input.title.trim(),
      note: input.note,
      createdAt: Date.now(),
      status: "saved",
      files: captured.map((file) => ({
        path: file.path,
        sha256: runtimeDigest(file.bytes),
        size: file.bytes.length,
        status: "pending"
      }))
    }
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.save(entry)
      for (const file of captured)
        this.db.prepare("INSERT INTO files VALUES (?,?,?)").run(entry.id, file.path, file.bytes)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
    return entry
  }
  private bytes(entry: ProjectLibraryEntry, path: string) {
    const file = entry.files.find((value) => value.path === path)
    const row = this.db
      .prepare("SELECT bytes FROM files WHERE entry_id=? AND path=?")
      .get(entry.id, path)
    if (!file || !row) return fail("NOT_FOUND")
    const bytes = Buffer.from(row.bytes as Uint8Array)
    if (runtimeDigest(bytes) !== file.sha256 || bytes.length !== file.size) fail("SNAPSHOT_CHANGED")
    return bytes
  }
  read(projectId: string, id: string, path: string) {
    const entry = this.entry(projectId, id)
    const bytes = this.bytes(entry, path)
    const limited = bytes.subarray(0, 32 * 1024)
    return { text: limited.toString("utf8"), truncated: bytes.length > limited.length }
  }
  reuse(sourceProjectId: string, id: string, targetProjectId: string) {
    const original = this.entry(sourceProjectId, id)
    if (original.kind !== "knowledge" || sourceProjectId === targetProjectId) fail("INPUT_INVALID")
    if (this.list(targetProjectId).length >= 50) fail("LIMIT")
    const entry: ProjectLibraryEntry = {
      ...original,
      id: randomUUID(),
      projectId: targetProjectId,
      createdAt: Date.now(),
      source: { projectId: sourceProjectId, entryId: id }
    }
    const files = original.files.map((file) => ({
      path: file.path,
      bytes: this.bytes(original, file.path)
    }))
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.save(entry)
      for (const file of files)
        this.db.prepare("INSERT INTO files VALUES (?,?,?)").run(entry.id, file.path, file.bytes)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
    return entry
  }
  /** Explicitly saved/reused knowledge only. Small budget; never scan workspace or old chats. */
  knowledgeContext(projectId: string): string {
    let remaining = 8000
    const result: string[] = []
    for (const entry of this.list(projectId)
      .filter((item) => item.kind === "knowledge")
      .slice(0, 3)) {
      const heading = `参考资料：${entry.title}\n保存说明：${entry.note}\n`
      result.push(heading.slice(0, remaining))
      remaining -= Math.min(remaining, heading.length)
      for (const file of entry.files) {
        if (remaining <= 0) break
        // Decode only common text formats. Binary deliverables are kept for manual inspection.
        if (!/\.(?:md|txt|json|csv|sql|ya?ml)$/i.test(file.path)) continue
        const text = `${file.path}\n${this.bytes(entry, file.path)
          .subarray(0, 32 * 1024)
          .toString("utf8")}\n`
        result.push(text.slice(0, remaining))
        remaining -= Math.min(remaining, text.length)
      }
    }
    return result.join("\n")
  }
  remove(projectId: string, id: string) {
    this.entry(projectId, id)
    if (this.active.has(id)) fail("BUSY")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare("DELETE FROM files WHERE entry_id=?").run(id)
      this.db.prepare("DELETE FROM entries WHERE id=? AND project_id=?").run(id, projectId)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
  async send(
    projectId: string,
    id: string,
    input: { endpoint: string; remotePath: string },
    assertCurrent: () => void
  ) {
    const entry = this.entry(projectId, id)
    if (entry.kind !== "delivery") fail("DELIVERY_REQUIRED")
    if (this.active.size || entry.status === "sending") fail("BUSY")
    const destination = projectDeliveryDestination(input?.endpoint, input?.remotePath)
    if (
      entry.endpoint &&
      (entry.endpoint !== destination.endpoint || entry.remotePath !== destination.remotePath)
    )
      fail("DESTINATION_CHANGED")
    if (entry.status === "sent") return entry
    // All bytes are immutable host snapshots. Preview and upload always refer to the same bytes.
    const files = entry.files.map((file) => ({ ...file, bytes: this.bytes(entry, file.path) }))
    assertCurrent()
    Object.assign(entry, destination, { status: "sending", error: undefined })
    this.active.add(id)
    try {
      this.save(entry)
      for (const file of files) {
        if (file.status === "uploaded") continue
        assertCurrent()
        const record = entry.files.find((value) => value.path === file.path)!
        // Mark in doubt durably BEFORE dispatch. A dropped connection is not proof of failure.
        record.status = "unknown"
        this.save(entry)
        try {
          await this.post(destination.endpoint, destination.remotePath, file.path, file.bytes)
          record.status = "uploaded"
        } catch (error) {
          record.status =
            error instanceof Error && error.message === "PROJECT_LIBRARY_HTTP_FAILED"
              ? "failed"
              : "unknown"
          throw error
        } finally {
          this.save(entry)
        }
      }
      assertCurrent()
      const catalog = Buffer.from(
        JSON.stringify(
          {
            schemaVersion: 1,
            projectId,
            operationId: entry.operationId,
            stageId: entry.stageId,
            files: entry.files.map(({ path, sha256, size }) => ({ path, sha256, size }))
          },
          null,
          2
        )
      )
      entry.catalogStatus = "unknown"
      this.save(entry)
      try {
        await this.post(
          destination.endpoint,
          destination.remotePath,
          "DEVCLAW_ARTIFACT_CATALOG.json",
          catalog
        )
        entry.catalogStatus = "uploaded"
      } catch (error) {
        entry.catalogStatus =
          error instanceof Error && error.message === "PROJECT_LIBRARY_HTTP_FAILED"
            ? "failed"
            : "unknown"
        throw error
      }
      entry.status = "sent"
    } catch {
      entry.status =
        entry.catalogStatus === "unknown" || entry.files.some((file) => file.status === "unknown")
          ? "unknown"
          : "partial"
      entry.error =
        "发送未全部确认。请核对接收方；再次确认发送只重试未确认的文件和目录清单，不会推进项目阶段。"
    } finally {
      this.active.delete(id)
      this.save(entry)
    }
    return entry
  }
  private async post(endpoint: string, remotePath: string, path: string, bytes: Buffer) {
    const form = new FormData()
    form.append("path", posix.join(remotePath, posix.dirname(path)))
    form.append("file", new Blob([new Uint8Array(bytes)]), posix.basename(path))
    const response = await this.upload(endpoint, {
      method: "POST",
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(50_000)
    })
    await response.body?.cancel()
    if (response.status !== 200) fail("HTTP_FAILED")
  }
}
