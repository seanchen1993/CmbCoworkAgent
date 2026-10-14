import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import { captureNativeMessage, captureNativeMessageForOccurrence } from "./native-message-capture"

describe.each(["iterator", "includes"] as const)(
  "original complete native capture after a late Array %s change", method => {
  it.each(["getter", "replacement"] as const)(
    "keeps every typed field and original digest without calling the %s", kind => {
      const metadata = { "2": "two", "1": "one", "\ud800": "\udfff",
        nested: [true, null, undefined, { complete: "original" }] }
      Object.defineProperty(metadata, "nonEnumerable", { value: "original hidden field" })
      const aiCalls = [{ id: "actual-call", name: "actual-tool", type: "tool_call" as const,
        args: metadata }]
      const messages = [
        new HumanMessage({ id: "actual-human", content: "full \ud800 human \udfff body",
          additional_kwargs: metadata, response_metadata: { bytes: new Uint16Array([1, 65535]) } }),
        new AIMessage({ id: "actual-ai", content: "actual AI body", tool_calls: aiCalls,
          response_metadata: { original: ["one", { complete: "two" }] } }),
        new ToolMessage({ id: "actual-tool-result", tool_call_id: "actual-call", name: "actual-tool",
          status: "success", content: "actual complete result", artifact: {
            truncated: true, exitCode: 1, output: "full untruncated source proof",
            binary: new Uint8Array([0, 128, 255]), nested: metadata
          } }),
        new SystemMessage({ id: "actual-system", content: [{ type: "image_url",
          image_url: { url: "actual-media-data", detail: "high" } },
        { type: "text", text: "actual system text" }], additional_kwargs: metadata })
      ]
      const baselines = messages.map(message => ({
        full: captureNativeMessage(message),
        occurrence: captureNativeMessageForOccurrence(message, "actual-occurrence")
      }))
      const key = method === "iterator" ? Symbol.iterator : "includes"
      const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, key)
      if (!descriptor) throw Error("ACTUAL_ARRAY_METHOD_REQUIRED")
      const copies: typeof baselines = []
      let calls = 0, failed = false, reason: unknown
      const callback = () => { calls++; throw Error("LATE_NATIVE_ARRAY_ITERATOR_EXECUTED") }
      Object.defineProperty(Array.prototype, key, kind === "getter"
        ? { configurable: true, get: callback }
        : { ...descriptor, value: callback })
      try {
        for (let index = 0; index < messages.length; index++) copies[index] = {
          full: captureNativeMessage(messages[index]),
          occurrence: captureNativeMessageForOccurrence(messages[index], "actual-occurrence")
        }
      } catch (error) { failed = true; reason = error }
      finally { Object.defineProperty(Array.prototype, key, descriptor) }
      expect(calls).toBe(0)
      if (failed) throw reason
      expect(copies).toEqual(baselines)
      expect(copies[1].full.data.tool_calls).toEqual(aiCalls)
      expect(copies[2].full.data.artifact).toMatchObject({ truncated: true,
        exitCode: 1, output: "[Incomplete output suppressed by project policy]" })
      messages[0].content = "changed actual original human"
      expect(captureNativeMessage(messages[0]).digest).not.toBe(baselines[0].full.digest)
      metadata.nested[3] = { complete: "changed original" }
      expect(captureNativeMessageForOccurrence(messages[1], "actual-occurrence").originalDigest)
        .not.toBe(baselines[1].occurrence.originalDigest)
    })
})
