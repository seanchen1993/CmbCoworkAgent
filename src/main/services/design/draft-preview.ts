import { promises as fs } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { inspectDesignDocument, type DesignDraftPreview } from "../../../shared/design-progressive"
import { readTweakDeclaration, reconcileTweaks } from "../../../shared/design-tweaks"

interface Options {
  runId: string
  workspacePath: string
  draftPath: string
  signal: AbortSignal
  publish: (preview: DesignDraftPreview) => void
  throttleMs?: number
  read?: (filePath: string) => Promise<string | null>
}

/** Each published revision is a durable file mutation, never an incomplete tool argument. */
export class DesignDraftPublisher {
  private candidate: string
  private epoch = 0
  private mutation = 0
  private revision = 0
  private lastHash = ""
  private timer?: ReturnType<typeof setTimeout>
  private pending: Promise<void> = Promise.resolve()
  private dirty = false
  private closed = false
  private sections = new Set<string>()
  private createdAt = Date.now()
  latest: DesignDraftPreview | null = null

  constructor(private readonly options: Options) {
    this.candidate = path.resolve(options.workspacePath, options.draftPath)
    options.signal.addEventListener("abort", () => this.dispose(), { once: true })
  }

  get expectedSections(): string[] {
    return [...this.sections]
  }

  validating(): void {
    if (!this.latest || this.closed) return
    this.latest = {
      ...this.latest,
      revision: ++this.revision,
      phase: "validating",
      updatedAt: Date.now()
    }
    this.options.publish(this.latest)
  }

  setCandidate(filePath: string): void {
    const next = path.resolve(this.options.workspacePath, filePath)
    if (next === this.candidate) return
    this.epoch++
    this.mutation++
    this.candidate = next
    this.dirty = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  notify(filePath: string): void {
    if (
      this.closed ||
      this.options.signal.aborted ||
      path.resolve(this.options.workspacePath, filePath) !== this.candidate
    )
      return
    this.mutation++
    this.dirty = true
    if (!this.timer)
      this.timer = setTimeout(
        () => {
          this.timer = undefined
          void this.flush()
        },
        this.latest ? (this.options.throttleMs ?? 150) : 0
      )
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending = this.pending
      .catch(() => undefined)
      .then(async () => {
        if (!this.dirty || this.closed || this.options.signal.aborted) return
        this.dirty = false
        const candidate = this.candidate,
          epoch = this.epoch,
          mutation = this.mutation
        let html: string | null
        try {
          html = await (this.options.read
            ? this.options.read(candidate)
            : this.readStable(candidate))
        } catch {
          return
        }
        if (
          !html ||
          this.closed ||
          this.options.signal.aborted ||
          epoch !== this.epoch ||
          mutation !== this.mutation
        )
          return
        const hash = createHash("sha256").update(html).digest("hex")
        if (hash === this.lastHash) return
        const inspection = inspectDesignDocument(html, this.expectedSections)
        if (!inspection.valid) return
        for (const id of inspection.sections) this.sections.add(id)
        this.lastHash = hash
        this.latest = {
          runId: this.options.runId,
          revision: ++this.revision,
          html,
          draftPath: candidate,
          phase: inspection.completedSections.length ? "sections" : "scaffold",
          status: "building",
          sections: inspection.sections,
          completedSections: inspection.completedSections,
          totalSections: inspection.totalSections,
          tweaks: reconcileTweaks(readTweakDeclaration(html)),
          createdAt: this.createdAt,
          updatedAt: Date.now()
        }
        this.options.publish(this.latest)
      })
    await this.pending
    if (this.dirty && !this.closed) await this.flush()
  }

  private async readStable(filePath: string): Promise<string | null> {
    const relative = path.relative(this.options.workspacePath, filePath)
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null
    const root = await fs.realpath(this.options.workspacePath)
    const realFile = await fs.realpath(filePath)
    const realRelative = path.relative(root, realFile)
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) return null
    const handle = await fs.open(realFile, "r")
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size > 8 * 1024 * 1024) return null
      const content = await handle.readFile("utf8")
      const after = await handle.stat()
      const current = await fs.stat(filePath)
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        current.ino !== after.ino ||
        current.mtimeMs !== after.mtimeMs
      )
        return null
      return content
    } finally {
      await handle.close()
    }
  }

  dispose(): void {
    this.closed = true
    this.epoch++
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}
