import { createHash } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { FUNCTION_PRESENTATION_MAX_BYTES } from "../../../shared/mods/v2/presentation-events"

/** A runtime-owned complete prompt. Pagination happens only after this expansion settles. */
export class SkillPromptSnapshots {
  private readonly entries = new Map<string, { digest: string; prompt: Promise<string> }>()
  private bytes = 0
  private readonly rendering = new AsyncLocalStorage<Set<string>>()

  async expand(
    identity: string,
    source: string,
    render: (text: string) => Promise<string>,
    assertLive: () => void
  ): Promise<string> {
    assertLive()
    if (this.rendering.getStore()?.has(identity)) throw Error("MODS_SKILL_PROMPT_REENTRANT")
    const sourceBytes = Buffer.byteLength(source)
    if (sourceBytes > FUNCTION_PRESENTATION_MAX_BYTES) throw Error("MODS_SKILL_PROMPT_LIMIT")
    const digest = createHash("sha256").update(source).digest("hex")
    const existing = this.entries.get(identity)
    if (existing && existing.digest !== digest) throw Error("MODS_SKILL_SOURCE_CHANGED")
    if (!existing) {
      if (this.entries.size >= 32 || this.bytes + sourceBytes > 4 * 1024 * 1024)
        throw Error("MODS_SKILL_PROMPT_LIMIT")
      this.bytes += sourceBytes
      // Rejected expansions stay rejected: a later page may not silently fall back to raw text.
      const prompt = Promise.resolve().then(async () => {
        assertLive()
        const active = new Set(this.rendering.getStore())
        active.add(identity)
        const text = await this.rendering.run(active, () => render(source))
        assertLive()
        if (typeof text !== "string" || Buffer.byteLength(text) > FUNCTION_PRESENTATION_MAX_BYTES)
          throw Error("MODS_SKILL_PROMPT_LIMIT")
        this.bytes += Buffer.byteLength(text)
        if (this.bytes > 8 * 1024 * 1024) throw Error("MODS_SKILL_PROMPT_LIMIT")
        return text
      })
      this.entries.set(identity, { digest, prompt })
    }
    const text = await this.entries.get(identity)!.prompt
    assertLive()
    return text
  }
}
