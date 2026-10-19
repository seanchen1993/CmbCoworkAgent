import { afterEach, expect, it, vi } from "vitest"
import {
  capturePlatformFileEdits,
  registerPlatformFileEditSink
} from "./platform-native-file-edits"

let stop = () => {}
afterEach(() => {
  stop()
  stop = () => {}
})

it("captures native identity once, publishes each committed mutation once and rejects late incarnations", () => {
  let incarnation = "native-a"
  const publish = vi.fn()
  stop = registerPlatformFileEditSink({
    capture: (workspace, threadId) => {
      const captured = incarnation
      return {
        workspace,
        threadId,
        incarnation: captured,
        assertCurrent: () => {
          if (incarnation !== captured) throw Error("recreated")
        }
      }
    },
    publish
  })
  const observer = capturePlatformFileEdits("workspace", "thread")!
  const first = observer.prepare("write_file", "actual-file")
  first()
  first()
  expect(publish).toHaveBeenCalledOnce()
  expect(publish.mock.calls[0][0]).toMatchObject({
    workspace: "workspace",
    threadId: "thread",
    incarnation: "native-a",
    operation: "write_file",
    path: "actual-file"
  })
  const late = observer.prepare("edit_file", "actual-file")
  incarnation = "native-b"
  late()
  expect(publish).toHaveBeenCalledOnce()
})

it("does no work without a sink, and source replacement or observer failures preserve file results", () => {
  expect(capturePlatformFileEdits("workspace", "thread")).toBeUndefined()
  const publish = vi.fn(() => {
    throw Error("observer unavailable")
  })
  stop = registerPlatformFileEditSink({
    capture: (workspace, threadId) => ({
      workspace,
      threadId,
      incarnation: "a",
      assertCurrent: () => {}
    }),
    publish
  })
  const observer = capturePlatformFileEdits("workspace", "thread")!
  expect(() => observer.prepare("write_file", "file")()).not.toThrow()
  const late = observer.prepare("edit_file", "file")
  stop()
  stop = registerPlatformFileEditSink({ capture: () => undefined, publish: vi.fn() })
  late()
  expect(publish).toHaveBeenCalledOnce()
})
