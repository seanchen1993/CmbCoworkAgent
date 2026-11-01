import { expect, it, vi } from "vitest"
import { OwnedMcpRemoteFetch } from "./owned-remote-fetch"

it("pins every request to the selected host and refuses redirects and credential-bearing URLs", async () => {
  const send = vi.fn(async () => new Response("ok"))
  const network = new OwnedMcpRemoteFetch("https://selected.test", send)
  for (const address of [
    "https://other.test/mcp",
    "file:///tmp/mcp",
    "https://user:secret@selected.test/mcp",
    "https://selected.test/mcp#fragment"
  ])
    await expect(network.fetch(address)).rejects.toThrow("TRANSPORT_POLICY")
  expect(send).not.toHaveBeenCalled()
  const response = await network.fetch("https://selected.test/messages?session=host", {
    headers: { Authorization: "host-secret" }
  })
  expect(await response.text()).toBe("ok")
  expect(send).toHaveBeenCalledWith(
    new URL("https://selected.test/messages?session=host"),
    expect.objectContaining({ redirect: "error", headers: { Authorization: "host-secret" } })
  )
  await network.close()
  await expect(network.fetch("https://selected.test/mcp")).rejects.toThrow()
})

it("waits for the actual response reader cancellation acknowledgement", async () => {
  let acknowledge!: () => void
  const cancelled = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve
      })
  )
  const network = new OwnedMcpRemoteFetch(
    "https://selected.test",
    async () => new Response(new ReadableStream({ cancel: cancelled }))
  )
  await network.fetch("https://selected.test/mcp")
  let closed = false
  const closing = network.close().then(() => {
    closed = true
  })
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1))
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(closed).toBe(false)
  acknowledge()
  await closing
  expect(closed).toBe(true)
})

it("does not confirm reclamation while an underlying fetch ignores abort", async () => {
  let respond!: (response: Response) => void
  const network = new OwnedMcpRemoteFetch(
    "https://selected.test",
    () =>
      new Promise((resolve) => {
        respond = resolve
      })
  )
  const pending = network.fetch("https://selected.test/mcp")
  const rejected = expect(pending).rejects.toThrow("CANCELLED")
  let closed = false
  const closing = network.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  respond(new Response("late"))
  await rejected
  await closing
  expect(closed).toBe(true)
})

it("bounds native response bytes and removes sensitive upstream error text", async () => {
  const network = new OwnedMcpRemoteFetch(
    "https://selected.test",
    async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1))
  )
  const response = await network.fetch("https://selected.test/mcp")
  await expect(response.arrayBuffer()).rejects.toThrow("REMOTE_BODY_LIMIT")
  await network.close()
  const failing = new OwnedMcpRemoteFetch("https://selected.test", async () => {
    throw Error("https://selected.test?token=secret Authorization: secret")
  })
  await expect(failing.fetch("https://selected.test/mcp")).rejects.toThrow("MODS_MCP_REMOTE_IO")
  await failing.close()
})
