import { afterEach, describe, expect, it } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { isModObject } from "../../../shared/mods/v2/contracts"
import { functionEngineRefs } from "../../../shared/mods/v2/engine"
import type { UserInputRequest } from "../../types"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const sessions: FunctionSession[] = []
afterEach(async () => { for (const session of sessions.splice(0)) await session.close() })

const questions = [{
  id: "scope", header: "Scope", question: "Review this change?", options: [
    { label: "Yes", description: "Proceed" },
    { label: "No", description: "Wait" }
  ]
}] satisfies UserInputRequest["questions"]
const facts = { tool: "request_user_input", questions }
const publicationTails: ModObject[] = [
  { type: "fragment", children: [] },
  { type: "Text", props: {}, children: [] },
  { type: "Box", props: {}, children: [] }
]

async function fixture(
  tree: string,
  publish: (value: ModJson) => Promise<ModJson> = async value => value
) {
  const actual: Readonly<UserInputRequest> = Object.freeze({
    requestId: "actual-fragment-R1", threadId: "thread",
    createdAt: "2026-10-05T00:00:00.000Z", questions: structuredClone(questions)
  })
  const state = new Map<string, ModJson>()
  let writes = 0
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("ui.render",{component:"AskUserQuestion"},async($,e,next)=>(${tree}));
  }}`)
  const session = new FunctionSession([{
    name: "fragment", root: "/fragment", tier: "user", guest,
    capabilities: [...SESSION_CAPABILITIES]
  }], {
    workspace: "/project", threadId: "thread", assertLive() {}, publish,
    pendingQuestion: () => actual,
    state: () => ({
      get: async key => state.get(key), keys: async () => [...state.keys()],
      set: async (key, value) => { writes++; state.set(key, value) },
      delete: key => { writes++; state.delete(key) }
    })
  })
  sessions.push(session)
  await session.start()
  const owner = await session.sites.mount("AskUserQuestion", undefined, actual.requestId)
  return { session, owner, actual, writes: () => writes }
}

describe("actual Session Ask transparent Fragment publication", () => {
  it.each([
    "h(Fragment,null,await next(e))",
    "h(Fragment,null,h(Fragment,null,await next(e)))"
  ])("preserves the actual request and native delegate through %s", async tree => {
    const f = await fixture(tree)
    const snapshot = await f.session.sites.render(f.owner, facts)
    expect(snapshot.tree.type).toBe("fragment")
    expect(functionEngineRefs(snapshot.tree)).toHaveLength(1)
    expect(snapshot.nativeFallback).toBe(true)
    expect(snapshot.nativeContent?.requestId).toBe(f.actual.requestId)
    expect(snapshot.nativeContent?.component).toBe("AskUserQuestion")
    expect(snapshot.nativeContent?.nativeUnchanged).toBe(true)
    expect(snapshot.nativeQuestions).toEqual(f.actual.questions)
    expect(f.writes()).toBe(0)
  })

  it.each([
    "h(Fragment,null)",
    '{type:"Text",props:{},children:[]}',
    '{type:"Box",props:{},children:[]}'
  ])("rejects every empty structural or visible tail before native publication: %s", async tail => {
    for (const engine of ["await next(e)", "h(Fragment,null,await next(e))"]) {
      const f = await fixture(`h(Fragment,null,${engine},${tail})`)
      await expect(f.session.sites.render(f.owner, facts)).rejects.toThrow(
        "MODS_UI_ASK_TREE_INVALID"
      )
      expect(f.writes()).toBe(0)
    }
  })

  it.each(publicationTails)(
    "rejects a tail injected by publication without replacing the old healthy drawing: %j",
    async tail => {
      let inject = false
      const f = await fixture("h(Fragment,null,h(Fragment,null,await next(e)))", async value => {
        if (!inject || !Array.isArray(value)) return value
        return value.map(row => isModObject(row) && row.tree ? {
          ...row, tree: { type: "fragment", children: [row.tree, tail] }
        } : row)
      })
      const before = await f.session.sites.render(f.owner, facts)
      const beforeJson = JSON.stringify(before)
      inject = true
      await expect(f.session.sites.render(f.owner, facts)).rejects.toThrow(
        "MODS_UI_ASK_TREE_INVALID"
      )
      expect(JSON.stringify(before)).toBe(beforeJson)
      expect(f.writes()).toBe(0)
      inject = false
      const after = await f.session.sites.render(f.owner, facts)
      expect(after.generation).toBe(before.generation)
      expect(after.tree).toEqual(before.tree)
      expect(after.nativeContent?.requestId).toBe(f.actual.requestId)
      expect(after.nativeFallback).toBe(true)
    }
  )
})
