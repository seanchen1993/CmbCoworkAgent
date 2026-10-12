import { afterEach, describe, expect, it, vi } from "vitest"
import { BotStore } from "./store"

const stores: BotStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const owner = store.createBot({ nonce: "owner", name: "文件验收" })
  return { store, ...owner }
}
function file(
  store: BotStore,
  conversationId: string,
  id: string,
  name: string,
  mime = "text/plain"
) {
  return store.publishArtifact({
    id,
    conversationId,
    runId: null,
    name,
    mime,
    size: 279,
    sha256: "a".repeat(64),
    origin: "upload"
  })
}

describe("message-scoped immutable attachment presentation", () => {
  it("projects exact names and identities with one page query, without listing unrelated artifacts", () => {
    const { store, conversationId } = fixture()
    const ids: string[] = []
    for (let index = 0; index < 12; index++) {
      const artifact = file(store, conversationId, `file-${index}`, `项目-${index}.csv`, "text/csv")
      ids.push(
        store.send({
          nonce: `send-${index}`,
          conversationId,
          text: `第${index}项`,
          attachments: [artifact.id]
        }).messageId
      )
    }
    file(store, conversationId, "not-attached", "未交给此消息.txt")
    const prepare = vi.spyOn(store.db, "prepare")
    const messages = store.messages(conversationId)
    expect(messages).toHaveLength(12)
    for (const [index, message] of messages.entries()) {
      expect(message.id).toBe(ids[index])
      expect(message.attachments).toEqual([`file-${index}`])
      expect(message.attachmentFiles).toEqual([
        expect.objectContaining({
          id: `file-${index}`,
          conversationId,
          name: `项目-${index}.csv`,
          mime: "text/csv",
          size: 279,
          sha256: "a".repeat(64),
          origin: "upload"
        })
      ])
    }
    const queries = prepare.mock.calls.map(([query]) => query)
    expect(queries.filter((query) => query.includes("FROM bot_message_files"))).toHaveLength(1)
    expect(queries.some((query) => query.includes("LIMIT 500"))).toBe(false)
    const first = store.messages(conversationId, messages[1].sequence, 1)[0]
    expect(first.id).toBe(ids[0])
    expect(first.attachmentFiles?.[0].name).toBe("项目-0.csv")
  })

  it("projects no deleted or cross-conversation metadata and never invents a replacement", () => {
    const { store, conversationId } = fixture()
    const local = file(store, conversationId, "local", "已上传.txt")
    const receipt = store.send({
      nonce: "send",
      conversationId,
      text: "读取文件",
      attachments: [local.id]
    })
    for (const id of receipt.runIds) store.cancel(id)
    store.deleteArtifact({ nonce: "delete", id: local.id, conversationId, sha256: local.sha256 })
    const foreign = store.createBot({ nonce: "foreign", name: "另一账号范围" })
    const other = file(store, foreign.conversationId, "foreign-file", "不得泄露的名称.txt")
    // A corrupt old link is not authority to disclose another conversation's descriptor.
    store.db.run("INSERT INTO bot_message_files VALUES(?,?)", [receipt.messageId, other.id])
    const message = store.message({ conversationId, id: receipt.messageId })
    expect(message.attachments).toEqual([local.id, other.id])
    expect(message.attachmentFiles).toEqual([])
    expect(JSON.stringify(message)).not.toContain(other.name)
    expect(() => store.getArtifact(local.id)).toThrow("已删除")
    expect(() =>
      store.message({ conversationId: foreign.conversationId, id: receipt.messageId })
    ).toThrow("不属于")
  })

  it("keeps attachment metadata on its actual main or branch message", () => {
    const { store, conversationId } = fixture()
    const main = file(store, conversationId, "main-file", "主线.txt")
    const branch = file(store, conversationId, "branch-file", "分支.txt")
    const root = store.send({ nonce: "main", conversationId, text: "主线", attachments: [main.id] })
    const child = store.send({
      nonce: "branch",
      conversationId,
      threadRootId: root.messageId,
      text: "分支",
      attachments: [branch.id]
    })
    const mainPage = store.messages(conversationId)
    const branchPage = store.messages(conversationId, undefined, 100, undefined, root.messageId)
    expect(mainPage.map((message) => message.id)).toEqual([root.messageId])
    expect(branchPage.map((message) => message.id)).toEqual([child.messageId])
    expect(mainPage[0].attachmentFiles?.map((value) => value.id)).toEqual([main.id])
    expect(branchPage[0].attachmentFiles?.map((value) => value.id)).toEqual([branch.id])
  })
})
