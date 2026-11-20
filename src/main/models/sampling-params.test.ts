import { afterEach, describe, expect, it } from "vitest"
import { samplingFields, shouldStripSamplingParams, topKModelKwargs } from "./sampling-params"

const ENV_KEY = "CMB_STRIP_SAMPLING_PARAMS"

afterEach(() => {
  delete process.env[ENV_KEY]
})

describe("sampling param stripping", () => {
  it("matches the deepseek and minimax series by model name, case-insensitively", () => {
    for (const model of [
      "deepseek-v4-flash",
      "deepseek-v4-flash-284b-a13b-w8a8",
      "DeepSeek-Chat",
      "minimax-m2p5-229b-w8a8",
      "MiniMax-M2.7"
    ]) {
      expect(shouldStripSamplingParams(model), model).toBe(true)
    }
  })

  it("leaves every other model alone", () => {
    for (const model of ["qwen3.5-35b-a3b", "glm-4.7", "gpt-4o", ""]) {
      expect(shouldStripSamplingParams(model), model).toBe(false)
    }
    expect(shouldStripSamplingParams(undefined)).toBe(false)
  })

  it("drops all three params for a matched model", () => {
    expect(samplingFields("deepseek-v4-flash", { temperature: 0.1, topP: 0.95 })).toEqual({})
    expect(topKModelKwargs("deepseek-v4-flash", 40)).toEqual({})
  })

  it("passes the params through untouched for an unmatched model", () => {
    expect(samplingFields("qwen3.5-35b-a3b", { temperature: 0.1, topP: 0.95 })).toEqual({
      temperature: 0.1,
      topP: 0.95
    })
    expect(topKModelKwargs("qwen3.5-35b-a3b", 40)).toEqual({ top_k: 40 })
  })

  it("keeps the existing top_k gating for unmatched models", () => {
    // top_k was already omitted when unset or non-positive; the filter only adds
    // a second reason to omit it, it must not start emitting it.
    expect(topKModelKwargs("qwen3.5-35b-a3b", 0)).toEqual({})
    expect(topKModelKwargs("qwen3.5-35b-a3b", undefined)).toEqual({})
  })

  it("omits a param that was undefined to begin with, without inventing a default", () => {
    expect(samplingFields("qwen3.5-35b-a3b", { temperature: undefined, topP: 0.95 })).toEqual({
      topP: 0.95
    })
  })

  it("can be switched off entirely by env var, restoring the old behaviour", () => {
    for (const off of ["0", "false", "off", "no", "OFF"]) {
      process.env[ENV_KEY] = off
      expect(shouldStripSamplingParams("deepseek-v4-flash"), off).toBe(false)
      expect(samplingFields("MiniMax-M2.7", { temperature: 1, topP: 0.95 }), off).toEqual({
        temperature: 1,
        topP: 0.95
      })
      expect(topKModelKwargs("MiniMax-M2.7", 40), off).toEqual({ top_k: 40 })
    }
  })

  it("stays on for any other env value, including an empty one", () => {
    for (const on of ["", "1", "true", "on", "yes"]) {
      process.env[ENV_KEY] = on
      expect(shouldStripSamplingParams("deepseek-v4-flash"), JSON.stringify(on)).toBe(true)
    }
  })
})
