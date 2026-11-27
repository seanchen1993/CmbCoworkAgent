import { expect, it, vi } from "vitest"
import { fetchUserGenerationSplit } from "./user-generation-split"
const range = { from: "2026-10-01", to: "2026-10-31" }
const bucket = (id: string | null, count: number, project = 0, visible = count - project) => ({
  key: { id },
  lines: { value: count },
  harness: { doc_count: project ? 1 : 0, lines: { value: project } },
  visible: { lines: { value: visible } }
})
const page = (buckets: ReturnType<typeof bucket>[], after?: string) => ({
  aggregations: { sessions: { buckets, ...(after ? { after_key: { id: after } } : {}) } }
})
const binding = (id: string, code?: string, lean = false, mode = "chat") => ({
  key: id,
  latest: {
    hits: {
      hits: [
        {
          _source: {
            properties: { generationMode: mode, projectCode: code, projectFromLean: lean }
          }
        }
      ]
    }
  }
})
const lookup = (...buckets: ReturnType<typeof binding>[]) => ({
  aggregations: { sessions: { buckets } }
})

it("applies the latest session binding to old generation periods without counting it twice", async () => {
  const query = vi.fn()
  for (const [code, lean] of [
    ["临时", "custom"],
    ["P001", "lean"],
    ["P002", "lean"],
    ["", "none"]
  ] as const) {
    query
      .mockResolvedValueOnce(
        page([bucket("a", 350), bucket("b", 100), bucket("free", 250), bucket("h", 500, 500)])
      )
      .mockResolvedValueOnce(
        lookup(binding("a", code, lean === "lean"), binding("b", "临时B"), binding("free"))
      )
    const result = await fetchUserGenerationSplit(query, "user", range, null)
    expect(result.project).toBe(500)
    expect(result.unknown).toBe(0)
    expect(result.unbound).toBe(code ? 250 : 600)
    expect(result.projects).toEqual([
      ...(code ? [{ code, fromLean: lean === "lean", lines: 350 }] : []),
      { code: "临时B", fromLean: false, lines: 100 }
    ])
    expect(JSON.stringify(query.mock.lastCall)).not.toContain("2026-10")
  }
})

it("falls back to old thread IDs, distinguishes missing evidence, and hides out-of-scope project codes", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce(
      page([
        bucket(null, 9),
        bucket("known", 30, 0, 0),
        bucket("unmapped", 12),
        bucket("project-session", 8)
      ])
    )
    .mockResolvedValueOnce(
      lookup(
        binding("known", "secret", true),
        binding("project-session", undefined, false, "project")
      )
    )
    .mockResolvedValueOnce(page([bucket("old", 4), bucket(null, 5, 2)]))
    .mockResolvedValueOnce(lookup(binding("old", "P007", true)))
  const result = await fetchUserGenerationSplit(query, "user", range, {
    term: { upperOrgLv1: "室" }
  })
  expect(result).toEqual({
    project: 10,
    unknown: 15,
    unbound: 0,
    projects: [
      { code: "", fromLean: true, lines: 30 },
      { code: "P007", fromLean: true, lines: 4 }
    ]
  })
  expect(JSON.stringify(query.mock.calls[2])).toContain("must_not")
})

it("uses a single scoped mapping lookup per page and reads past the first page", async () => {
  const entries = Array.from({ length: 256 }, (_, i) => bucket("t" + i, 1))
  const query = vi
    .fn()
    .mockResolvedValueOnce(page(entries, "t255"))
    .mockResolvedValueOnce(lookup())
    .mockResolvedValueOnce(page([bucket("a", 5, 5)]))
  const result = await fetchUserGenerationSplit(query, "user", range, null)
  expect(query).toHaveBeenCalledTimes(3)
  expect(query.mock.calls[1][0].query.bool.filter).toContainEqual({ term: { sapId: "user" } })
  expect(result).toMatchObject({ project: 5, unknown: 256 })
  expect(query.mock.calls[2][0].aggs.sessions.composite.after).toEqual({ id: "t255" })
})

it("rejects incomplete data instead of presenting it as unbound or zero", async () => {
  await expect(
    fetchUserGenerationSplit(vi.fn().mockResolvedValue({ timed_out: true }), "user", range, null)
  ).rejects.toThrow()
})
