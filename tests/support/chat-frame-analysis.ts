type Token = { length: number; hash: string }
type Site = { name: string | null; messageId: string | null; text: Token; statuses: number }
type Sample = {
  at: number
  phase: string
  source: string
  visibility: string
  documentIndex?: number
  rows: { id: string | null }[]
  sites: Site[]
  clippedSites?: { name: string | null; messageId: string | null; text: Token }[]
}

/** Painted, previously displayed content disappearing and returning, including removed slots. */
export function findRestoredSiteFlashes(samples: Sample[]) {
  const previous = new Map<string, Site>()
  const missing = new Map<string, { at: number; site: Site }>()
  const flashes: {
    phase: string
    name: string | null
    messageId: string | null
    start: number
    end: number
    sameContent: boolean
  }[] = []
  let scope = ""
  for (const sample of samples) {
    const nextScope = `${sample.documentIndex ?? 0}:${sample.phase}`
    if (nextScope !== scope) {
      previous.clear()
      missing.clear()
      scope = nextScope
    }
    if (sample.visibility !== "visible" || !["frame", "phase"].includes(sample.source)) continue
    const key = (site: { name: string | null; messageId: string | null }) =>
      `${site.name}:${site.messageId ?? "composer"}`
    const current = new Map(sample.sites.map((site) => [key(site), site]))
    for (const [id, before] of previous) {
      const site = current.get(id)
      if (
        sample.clippedSites?.some((clipped) => key(clipped) === id && clipped.text.length > 0) ||
        (!site && before.messageId && !sample.rows.some((row) => row.id === before.messageId))
      ) {
        previous.delete(id)
        missing.delete(id)
        continue
      }
      if ((!site || !site.text.length || site.statuses > 0) && !missing.has(id))
        missing.set(id, { at: sample.at, site: before })
    }
    for (const [id, site] of current) {
      if (!site.text.length || site.statuses > 0) continue
      const gap = missing.get(id)
      if (gap)
        flashes.push({
          phase: sample.phase,
          name: site.name,
          messageId: site.messageId,
          start: gap.at,
          end: sample.at,
          sameContent:
            gap.site.text.length === site.text.length && gap.site.text.hash === site.text.hash
        })
      missing.delete(id)
      previous.set(id, site)
    }
  }
  return flashes
}
