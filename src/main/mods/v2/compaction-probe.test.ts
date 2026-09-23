import { expect, it } from "vitest"
import { resolve } from "node:path"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { ModJson } from "../../../shared/mods/types"

it.each(["block", "allow"])(
  "compaction probe records real guest reentrancy for %s",
  async (mode) => {
    const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/compaction-probe"))
    const guest = await FunctionGuestRuntime.create(compiled.code)
    const values = new Map<string, ModJson>()
    let summaries = 0
    let messages: ModJson = [{ role: "user", text: "COMPACTION_PROBE original", toolUses: [] }]
    const session = new FunctionSession(
      [
        {
          name: compiled.name,
          root: compiled.root,
          tier: "user",
          guest,
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace: "/workspace",
        threadId: "thread",
        assertLive: () => {},
        publish: async (value) => value,
        state: () => ({
          get: async (key) => values.get(key),
          set: async (key, value) => {
            values.set(key, value)
          },
          delete: (key) => {
            values.delete(key)
          },
          keys: async () => [...values.keys()]
        }),
        readSession: async () => messages,
        compactSession: async (instructions, signal) => {
          const base = {
            session_id: "thread",
            cwd: "/workspace",
            transcript_path: "",
            trigger: "manual"
          }
          const pre = await session.classicEvent(
            "classic.PreCompact",
            { ...base, hook_event_name: "PreCompact", custom_instructions: instructions },
            signal
          )
          if (pre.block) throw Error(String(pre.block))
          summaries++
          messages = [{ role: "user", text: "COMPACTION_SUMMARY_SENTINEL", toolUses: [] }]
          await session.classicEvent(
            "classic.PostCompact",
            {
              ...base,
              hook_event_name: "PostCompact",
              compact_summary: "COMPACTION_SUMMARY_SENTINEL"
            },
            signal
          )
          return { messages, tokensBefore: 100, tokensAfter: 20 }
        }
      }
    )
    try {
      await session.start()
      await session.run("compact-probe-mode", mode)
      const result = JSON.parse(String((await session.run("compact-probe-run", "")).text))
      expect(result.ok).toBe(mode === "allow")
      expect(summaries).toBe(mode === "allow" ? 1 : 0)
      const records = JSON.parse(
        String((await session.run("compact-probe-status", "")).text)
      ).events
      expect(records.map((item: { kind: string }) => item.kind)).toEqual(
        mode === "allow" ? ["pre", "post", "returned"] : ["pre", "failed"]
      )
      if (mode === "allow") expect(records[1].summaryVisible).toBe(true)
    } finally {
      await session.close()
    }
  }
)
