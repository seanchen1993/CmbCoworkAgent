import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createDehydratedThreadStatePatch } from "./thread-dehydration"

describe("thread context navigation isolation", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./thread-context.tsx", import.meta.url)),
    "utf8"
  )

  it("does not navigate when live or restored background approvals arrive", () => {
    expect(source).not.toContain("Auto-switching to thread")
    expect(source).not.toMatch(
      /onApprovalRequest[\s\S]{0,1800}useAppStore\.getState\(\)\.selectThread/
    )
    expect(source).not.toMatch(
      /getPendingApprovals[\s\S]{0,2400}useAppStore\.getState\(\)\.selectThread/
    )
  })

  it("routes persisted Bot reminders to resident threads without the conversation view or stream", () => {
    const conversation = readFileSync(
      fileURLToPath(new URL("../components/bots/BotConversation.tsx", import.meta.url)),
      "utf8"
    )
    const subscription = source.match(
      /return window\.api\.bots\?\.subscribe\(\(\{ hostId, reminder \}\) => \{([\s\S]*?)\n    \}\)/
    )?.[1]
    expect(conversation).not.toMatch(/subscribe\([^]*?\breminder\b/)
    expect(subscription).toContain("hostId !== LOCAL_BOT_HOST_ID || !reminder")
    expect(subscription).toContain("!threadStatesRef.current[threadId]")
    expect(subscription).toContain("isThreadDeletionPending(threadId)")
    expect(subscription).toContain("knownDurableMessageIdsRef.current[threadId]?.has(id)")
    expect(subscription).toContain('message: Message = { id, role: "assistant"')
    expect(subscription).toContain("getThreadActions(threadId).appendMessage(message)")
    expect(subscription).not.toMatch(/initializeThread|loadThreadHistory|\bdone\b/)
  })

  it("keeps evicted transcripts empty while resident and reopening threads receive durable reminders once", () => {
    const ast = ts.createSourceFile("thread-context.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    let subscription = ""
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "window.api.bots?.subscribe" &&
          node.arguments[0]?.getText(ast).includes("{ hostId, reminder }")) {
        subscription = node.arguments[0].getText(ast)
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    expect(subscription).not.toBe("")
    type Record = { id: string; content: string }
    const states = {
      cold: createDehydratedThreadStatePatch(),
      resident: { ...createDehydratedThreadStatePatch(), dehydrated: false },
      reopening: createDehydratedThreadStatePatch()
    }
    const ids: { [key: string]: Set<string> } = {}
    const appended: { [key: string]: Record[] } = {}
    const initialized = new Set(["resident", "reopening"])
    const handle = runInNewContext(ts.transpileModule(`(${subscription})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText, {
      LOCAL_BOT_HOST_ID: "local", threadStatesRef: { current: states },
      initializedThreadsRef: { current: initialized }, knownDurableMessageIdsRef: { current: ids },
      isThreadDeletionPending: () => false,
      rememberDurableMessageIds: (threadId: string, messages: Record[]) => {
        const known = ids[threadId] ??= new Set()
        messages.forEach(message => known.add(message.id))
      },
      getThreadActions: (threadId: string) => {
        const messages = appended[threadId] ??= []
        return { appendMessage: (message: Record) => messages.push(message) }
      }
    }) as (event: unknown) => void
    for (const threadId of Object.keys(states)) {
      for (const id of ["first", "second", "second"]) {
        handle({ hostId: "local", reminder: { threadId, id, content: id, createdAt: 1 } })
      }
    }
    expect(appended.cold).toBeUndefined()
    expect(ids.cold).toBeUndefined()
    expect(appended.resident.map(message => message.id)).toEqual(["first", "second"])
    expect(appended.reopening.map(message => message.id)).toEqual(["first", "second"])
    // Reopening registers the holder before history hydration clears dehydrated.
    initialized.add("cold")
    handle({ hostId: "local", reminder: { threadId: "cold", id: "new", content: "new", createdAt: 2 } })
    expect(appended.cold.map(message => message.id)).toEqual(["new"])
  })
})
