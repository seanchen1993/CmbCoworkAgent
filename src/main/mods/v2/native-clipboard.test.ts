import { expect, it, vi } from "vitest"
import { writeFunctionClipboard } from "./native-clipboard"
it("silent native write failure cannot produce a success receipt", () => {
  const clipboard = {
    writeText: vi.fn(),
    readText: () => "unchanged",
    availableFormats: () => ["text/plain"]
  }
  expect(() => writeFunctionClipboard(clipboard, "protected text")).toThrow("UNCONFIRMED")
  expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith("protected text")
})
it("confirms the exact text written without exposing clipboard content", () => {
  let stored = ""
  expect(() =>
    writeFunctionClipboard(
      {
        writeText: (text) => {
          stored = text
        },
        readText: () => stored
      },
      "文😀"
    )
  ).not.toThrow()
})
it("inaccessible clipboard empty reads cannot prove an empty-text copy", () => {
  for (const formats of [[], ["text/plain"]]) {
    const clipboard = {
      writeText: vi.fn(),
      readText: () => "",
      availableFormats: () => formats
    }
    expect(() => writeFunctionClipboard(clipboard, "")).toThrow("UNCONFIRMED")
    expect(clipboard.writeText).not.toHaveBeenCalled()
  }
})
