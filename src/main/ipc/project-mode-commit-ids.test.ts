import { expect, it, vi } from "vitest"
import { fetchProjectModeCommitIds } from "./project-mode-commit-ids"

it("keeps all 1500 associations with bounded sequential pages and no commit source payloads", async () => {
  const filters = [
    { term: { "properties.harnessProjectId": "p" } },
    { term: { upperOrgLv1: "本室" } }
  ]
  const query = vi.fn(async (body: Record<string, unknown>) => {
    expect(body.size).toBe(0)
    expect(body._source).toBeUndefined()
    expect(body.query).toEqual({ bool: { filter: filters } })
    const start = (query.mock.calls.length - 1) * 1000
    return {
      aggregations: {
        commits: {
          buckets: Array.from({ length: start === 0 ? 1000 : 500 }, (_, i) => ({
            key: { sha: `sha-${start + i}` }
          })),
          ...(start === 0 ? { after_key: { sha: "cursor" } } : {})
        }
      }
    }
  })
  expect(await fetchProjectModeCommitIds(filters, query)).toHaveLength(1500)
  expect(query).toHaveBeenCalledTimes(2)
})

it("rejects failed shards and duplicate associations instead of silently returning partial commits", async () => {
  await expect(
    fetchProjectModeCommitIds([], vi.fn().mockResolvedValue({ _shards: { failed: 1 } }))
  ).rejects.toThrow()
  await expect(
    fetchProjectModeCommitIds(
      [],
      vi.fn().mockResolvedValue({
        aggregations: {
          commits: {
            buckets: [{ key: { sha: "same" } }, { key: { sha: "same" } }]
          }
        }
      })
    )
  ).rejects.toThrow("重复")
})
