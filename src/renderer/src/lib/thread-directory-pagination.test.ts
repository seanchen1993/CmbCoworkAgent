import { describe, expect, it } from "vitest"
import type { Thread } from "@/types"
import {
  appendThreadDirectoryPages,
  indexThreadDirectory,
  mergeThreadDirectoryFirstPage
} from "./thread-directory-pagination"

function thread(id: string, updatedAt: number): Thread {
  return {
    thread_id: id,
    title: id,
    status: "idle",
    created_at: new Date(1),
    updated_at: new Date(updatedAt),
    metadata: {}
  }
}

describe("thread directory pagination", () => {
  it("keeps a 100k no-op first-page refresh O(page) and reference-stable", () => {
    const previous = Array.from({ length: 100_000 }, (_, index) =>
      thread(`thread-${index}`, 100_000 - index)
    )
    const firstPage = previous
      .slice(0, 128)
      .map((item) => thread(item.thread_id, new Date(item.updated_at).getTime()))

    const next = mergeThreadDirectoryFirstPage(previous, firstPage, {
      requestMutationEpoch: 0,
      mutationEpochById: new Map(),
      knownIndexById: new Proxy(indexThreadDirectory(previous), {
        get(target, property, receiver) {
          if (property === "get") return target.get.bind(target)
          return Reflect.get(target, property, receiver)
        }
      })
    })

    expect(next).toBe(previous)
  })

  it("does not lose a create or resurrect a delete that races the first page", () => {
    const previous = [thread("created", 20), thread("old", 10)]
    const mutationEpochById = new Map([
      ["created", 2],
      ["deleted", 3]
    ])
    const next = mergeThreadDirectoryFirstPage(
      previous,
      [thread("deleted", 30), thread("old", 10)],
      {
        requestMutationEpoch: 1,
        mutationEpochById,
        knownIndexById: indexThreadDirectory(previous)
      }
    )

    expect(next.map((item) => item.thread_id)).toEqual(["created", "old"])
  })

  it("appends bounded older pages without duplicating overlapping rows", () => {
    const previous = [thread("a", 3), thread("b", 2)]
    const next = appendThreadDirectoryPages(previous, [thread("b", 2), thread("c", 1)], {
      requestMutationEpoch: 0,
      mutationEpochById: new Map(),
      knownIndexById: indexThreadDirectory(previous)
    })

    expect(next.map((item) => item.thread_id)).toEqual(["a", "b", "c"])
    expect(next[1]).toBe(previous[1])
  })

  it("removes deleted rows only inside the authoritative first-page range", () => {
    const previous = [thread("deleted", 5), thread("a", 4), thread("b", 3), thread("older", 1)]
    const incoming = [thread("a", 4), thread("b", 3)]

    const next = mergeThreadDirectoryFirstPage(previous, incoming, {
      requestMutationEpoch: 0,
      mutationEpochById: new Map(),
      knownIndexById: indexThreadDirectory(previous),
      authoritativePageBoundary: incoming.at(-1)
    })

    expect(next.map((item) => item.thread_id)).toEqual(["a", "b", "older"])
  })

  it("clears a directory when an authoritative complete page becomes empty", () => {
    const previous = [thread("deleted", 1)]
    const next = mergeThreadDirectoryFirstPage(previous, [], {
      requestMutationEpoch: 0,
      mutationEpochById: new Map(),
      knownIndexById: indexThreadDirectory(previous),
      completeSnapshot: true
    })

    expect(next).toEqual([])
  })
})
