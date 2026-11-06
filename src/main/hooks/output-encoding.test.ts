import { afterEach, describe, expect, it, vi } from "vitest"
import * as chardet from "jschardet"
import * as iconv from "iconv-lite"
import { decodeHookOutput } from "./output-encoding"

vi.mock("jschardet", { spy: true })

afterEach(() => {
  vi.mocked(chardet.detect).mockRestore()
})

describe("hook output decoding on Windows", () => {
  it("preserves the UTF-8 log whose old combined sample was detected as ISO-8859-2", () => {
    // The old 4 KB stdout slice ends inside 中. With stderr appended, jschardet
    // guesses ISO-8859-2 at ~97% confidence even though both full streams are UTF-8.
    const stdout = "hook log completed ".repeat(500).slice(0, 4094) + "中文日志"
    const stderr = "hook completed"
    expect(decodeHookOutput(Buffer.from(stdout), Buffer.from(stderr), "win32")).toEqual({
      stdout,
      stderr
    })
  })

  it("prefers valid UTF-8 over a confident ISO-8859-2 guess", () => {
    vi.mocked(chardet.detect).mockReturnValue({ encoding: "ISO-8859-2", confidence: 0.99 })
    const stdout = "Hook 检查通过：代码实现 ✅"
    const stderr = "诊断日志：正在检查"

    expect(decodeHookOutput(Buffer.from(stdout), Buffer.from(stderr), "win32")).toEqual({
      stdout,
      stderr
    })
    expect(chardet.detect).not.toHaveBeenCalled()
  })

  it.each([4094, 4095, 8190, 8191])(
    "preserves UTF-8 when a sample boundary splits a character after %i bytes",
    (prefixLength) => {
      const stdout = "a".repeat(prefixLength) + "中文日志"
      const stderr = "b".repeat(prefixLength) + "错误信息"
      expect(decodeHookOutput(Buffer.from(stdout), Buffer.from(stderr), "win32")).toEqual({
        stdout,
        stderr
      })
    }
  )

  it.each([false, true])("decodes mixed UTF-8 and GBK streams independently (swap=%s)", (swap) => {
    const utf8 = "检查通过：中文 UTF-8 日志 ✅"
    const gbk = "这是中文诊断日志，检查工作流节点失败，请检查配置后重试。".repeat(4)
    const buffers = [Buffer.from(utf8), iconv.encode(gbk, "gbk")]
    const expected = [utf8, gbk]
    if (swap) {
      buffers.reverse()
      expected.reverse()
    }
    expect(decodeHookOutput(buffers[0], buffers[1], "win32")).toEqual({
      stdout: expected[0],
      stderr: expected[1]
    })
  })

  it("keeps ASCII JSON alongside stderr-only GB18030 diagnostics", () => {
    const stdout = '{"decision":"block"}'
    const stderr = "这是中文诊断日志，检查工作流节点失败，请检查配置后重试。".repeat(4)
    expect(decodeHookOutput(Buffer.from(stdout), iconv.encode(stderr, "gb18030"), "win32")).toEqual(
      { stdout, stderr }
    )
  })

  it("retains low-confidence legacy decoding for bytes that are not UTF-8", () => {
    vi.mocked(chardet.detect).mockReturnValue({ encoding: "GB2312", confidence: 0.5 })
    expect(decodeHookOutput(iconv.encode("中文", "gbk"), Buffer.alloc(0), "win32")).toEqual({
      stdout: "中文",
      stderr: ""
    })
  })

  it("preserves BOM-marked UTF-16 output", () => {
    expect(decodeHookOutput(iconv.encode("中文日志", "utf16"), Buffer.alloc(0), "win32")).toEqual({
      stdout: "中文日志",
      stderr: ""
    })
  })

  it("strips a UTF-8 BOM without changing the log text", () => {
    expect(decodeHookOutput(Buffer.from("\uFEFF中文日志"), Buffer.alloc(0), "win32")).toEqual({
      stdout: "中文日志",
      stderr: ""
    })
  })

  it("falls back safely when the detected encoding is unsupported", () => {
    vi.mocked(chardet.detect).mockReturnValue({ encoding: "unsupported-encoding", confidence: 1 })
    const bytes = Buffer.from([0xff, 0x61])
    expect(decodeHookOutput(bytes, Buffer.from("正常日志"), "win32")).toEqual({
      stdout: bytes.toString("utf8"),
      stderr: "正常日志"
    })
  })

  it("isolates a detector failure to the affected stream", () => {
    vi.mocked(chardet.detect).mockImplementationOnce(() => {
      throw new Error("detector failed")
    })
    const stdout = Buffer.from([0xff, 0x61])
    const stderr = "这是中文诊断日志，检查工作流节点失败，请检查配置后重试。".repeat(4)
    expect(decodeHookOutput(stdout, iconv.encode(stderr, "gbk"), "win32")).toEqual({
      stdout: stdout.toString("utf8"),
      stderr
    })
  })

  it("handles empty output and ASCII", () => {
    expect(decodeHookOutput(Buffer.alloc(0), Buffer.from("done\n"), "win32")).toEqual({
      stdout: "",
      stderr: "done\n"
    })
  })

  it("keeps UTF-8 decoding on non-Windows platforms", () => {
    const stdout = "中文日志 ✅"
    expect(decodeHookOutput(Buffer.from(stdout), Buffer.alloc(0), "linux")).toEqual({
      stdout,
      stderr: ""
    })
    expect(chardet.detect).not.toHaveBeenCalled()
  })
})
