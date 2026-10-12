import { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import { botPeerDelivery, botPeerMessageImages } from "../../shared/bot-peer-images"
import {
  botPeerExchange,
  botPeerExchangeRequest,
  type BotPeerExchange,
  type BotPeerExchangeLink
} from "../../shared/bot-peer-exchange"
import type { BotRunAddress } from "../../shared/bot-run-history"
import type { NativeSqliteBindings } from "../db/native-sqlite-adapter"
import type { BotStore } from "./store"
import { attachmentsForMessages } from "./message-attachments"

const text = z.string()
const runSchema = z.object({
  id: text,
  bot_id: text,
  conversation_id: text,
  message_id: text,
  parent_run_id: text.nullable(),
  root_run_id: text,
  source: text,
  status: botPeerExchange.shape.status,
  revision: z.number().int().positive(),
  depth: z.number().int().min(0).max(8),
  thread_root: text.nullable(),
  peer_automatic: z
    .union([z.literal(0), z.literal(1)])
    .nullable()
    .optional(),
  peer_reply_run: text.nullable().optional(),
  peer_scope_run: text.nullable().optional()
})
type Run = z.infer<typeof runSchema>
const messageSchema = z.object({
  id: text,
  conversation_id: text,
  bot_id: text.nullable(),
  sender: z.enum(["user", "bot", "system"]),
  text: z.string().max(128_000),
  run_id: text.nullable(),
  reply_to: text.nullable(),
  created_at: z.number(),
  thread_root: text.nullable().optional()
})
type Message = z.infer<typeof messageSchema>
const handoffSchema = z.object({
  recipient: text,
  runId: text,
  messageId: text,
  outgoingMessageId: text.optional()
})
const runColumns =
  "r.id,r.bot_id,r.conversation_id,r.message_id,r.parent_run_id,r.root_run_id,r.source,r.status,r.revision,r.depth,t.root_id AS thread_root,(SELECT automatic FROM bot_peer_dispatch WHERE run_id=r.id) AS peer_automatic,(SELECT reply_to_run_id FROM bot_peer_dispatch WHERE run_id=r.id) AS peer_reply_run,(SELECT activation_scope_run_id FROM bot_peer_dispatch WHERE run_id=r.id) AS peer_scope_run"
const messageColumns =
  "m.id,m.conversation_id,m.bot_id,m.sender,m.text,m.run_id,m.reply_to,m.created_at,t.root_id AS thread_root"

/** Read-only lineage, separate from current execution/approval authority. */
function assertRelation(
  parent: Run,
  child: Run,
  request: Message,
  handoff: z.infer<typeof handoffSchema>,
  replyTo = parent.message_id
): void {
  if (
    child.source !== "peer" ||
    child.parent_run_id !== parent.id ||
    child.root_run_id !== parent.root_run_id ||
    child.bot_id === parent.bot_id ||
    request.id !== child.message_id ||
    request.conversation_id !== child.conversation_id ||
    request.bot_id !== parent.bot_id ||
    request.sender !== "bot" ||
    request.run_id !== parent.id ||
    request.reply_to !== replyTo ||
    (request.thread_root ?? null) !== child.thread_root ||
    handoff.recipient !== child.bot_id ||
    handoff.runId !== child.id ||
    handoff.messageId !== request.id
  )
    throw new BotDomainError("peer_scope", "交流记录不属于这次协作")
}
const address = (run: Run): BotRunAddress => ({
  conversationId: run.conversation_id,
  runId: run.id,
  ...(run.thread_root ? { threadRootId: run.thread_root } : {})
})

/** Point reads contain neither checkpoints nor inherited/private conversation history.
 * Message links are derived from records; model text is never an address. */
export class BotPeerExchanges {
  constructor(private readonly store: BotStore) {}
  private rows(sql: string, params: NativeSqliteBindings = []): Record<string, unknown>[] {
    const statement = this.store.db.prepare(sql, params),
      values: Record<string, unknown>[] = []
    try {
      while (statement.step()) values.push(statement.getAsObject())
      return values
    } finally {
      statement.free()
    }
  }
  private run(id: string): Run {
    const row = this.rows(
      `SELECT ${runColumns} FROM bot_runs r LEFT JOIN bot_message_threads t ON t.message_id=r.message_id WHERE r.id=?`,
      [id]
    )[0]
    if (!row) throw new BotDomainError("peer_unavailable", "交流任务不存在")
    return runSchema.parse(row)
  }
  private message(id: string): Message {
    const row = this.rows(
      `SELECT ${messageColumns} FROM bot_messages m LEFT JOIN bot_message_threads t ON t.message_id=m.id WHERE m.id=?`,
      [id]
    )[0]
    if (!row) throw new BotDomainError("peer_unavailable", "交流消息不存在")
    return messageSchema.parse(row)
  }
  private expectedReplyTo(
    parent: Run,
    child: Run,
    request: Message,
    lookup = (id: string) => this.run(id)
  ): string {
    if (child.peer_automatic !== 1) {
      if (request.reply_to === parent.message_id) return parent.message_id
      const inbox = this.rows(
        "SELECT s.run_id,m.message_id FROM bot_steering s JOIN bot_runs m ON m.id=s.run_id WHERE s.followup_run_id=? AND s.message_id=?",
        [child.id, child.message_id]
      )[0]
      // A late merged message keeps its original recipient correlation; its
      // trusted follow-up reuses the sender/root instead of a fabricated user.
      return inbox ? String(inbox.message_id) : parent.message_id
    }
    if (!child.peer_reply_run || child.peer_scope_run !== child.peer_reply_run)
      throw new BotDomainError("peer_scope", "自动返回缺少原请求关联")
    const original = lookup(child.peer_reply_run)
    if (
      parent.parent_run_id !== original.id ||
      original.root_run_id !== child.root_run_id ||
      original.bot_id !== child.bot_id ||
      original.conversation_id !== child.conversation_id ||
      original.thread_root !== child.thread_root
    )
      throw new BotDomainError("peer_scope", "自动返回与原请求身份不一致")
    return original.message_id
  }
  private relation(id: string) {
    const child = this.run(id)
    if (child.source !== "peer" || !child.parent_run_id)
      throw new BotDomainError("peer_scope", "目标不是 Bot 之间的协作任务")
    const parent = this.run(child.parent_run_id),
      request = this.message(child.message_id)
    // The bound is the original root collaboration budget (64), not all history.
    const events = this.rows(
      "SELECT payload FROM bot_events WHERE entity_id=? AND kind='run.handoff' ORDER BY cursor DESC LIMIT 64",
      [parent.id]
    )
    const handoff = events.flatMap((event) => {
      try {
        const parsed = handoffSchema.safeParse(JSON.parse(String(event.payload)))
        return parsed.success && parsed.data.runId === child.id ? [parsed.data] : []
      } catch {
        return []
      }
    })[0]
    if (!handoff) throw new BotDomainError("peer_unavailable", "缺少可核对的交流记录")
    assertRelation(parent, child, request, handoff, this.expectedReplyTo(parent, child, request))
    const recipient = this.store.getConversation(child.conversation_id)
    if (
      recipient.kind !== "direct" ||
      recipient.members.length !== 1 ||
      recipient.members[0] !== child.bot_id
    )
      throw new BotDomainError("peer_scope", "接收会话与协作身份不一致")
    this.validateDelivery(request, parent, child, handoff)
    return { parent, child, request, handoff }
  }
  private metadata(messageId: string) {
    const row = this.rows(
      "SELECT images,delivery FROM bot_message_peer_images WHERE message_id=?",
      [messageId]
    )[0]
    if (!row) return null
    return {
      images: botPeerMessageImages.parse(JSON.parse(String(row.images))),
      delivery: botPeerDelivery.parse(JSON.parse(String(row.delivery)))
    }
  }
  private validateDelivery(
    request: Message,
    parent: Run,
    child: Run,
    handoff: z.infer<typeof handoffSchema>,
    metadata: (id: string) => ReturnType<BotPeerExchanges["metadata"]> = (id) => this.metadata(id),
    message: (id: string) => Message = (id) => this.message(id)
  ) {
    const incoming = metadata(request.id)
    if (!incoming && !handoff.outgoingMessageId) return
    if (!incoming || !handoff.outgoingMessageId)
      throw new BotDomainError("peer_scope", "图片交流记录不完整")
    const outbound = message(handoff.outgoingMessageId),
      outgoing = metadata(outbound.id)
    if (
      !outgoing ||
      outbound.conversation_id !== parent.conversation_id ||
      outbound.run_id !== parent.id ||
      outbound.bot_id !== parent.bot_id ||
      outbound.sender !== "system" ||
      outbound.reply_to !== parent.message_id ||
      (outbound.thread_root ?? null) !== parent.thread_root ||
      outbound.text !== request.text ||
      incoming.delivery.direction !== "incoming" ||
      outgoing.delivery.direction !== "outgoing" ||
      incoming.delivery.senderRunId !== parent.id ||
      outgoing.delivery.senderRunId !== parent.id ||
      incoming.delivery.recipientRunId !== child.id ||
      outgoing.delivery.recipientRunId !== child.id ||
      incoming.delivery.peer.botId !== parent.bot_id ||
      outgoing.delivery.peer.botId !== child.bot_id ||
      incoming.delivery.counterpart.conversationId !== parent.conversation_id ||
      incoming.delivery.counterpart.messageId !== outbound.id ||
      outgoing.delivery.counterpart.conversationId !== child.conversation_id ||
      outgoing.delivery.counterpart.messageId !== request.id ||
      incoming.images.length !== outgoing.images.length ||
      incoming.images.some((image, index) => {
        const other = outgoing.images[index]
        return (
          image.sourceId !== other.sourceId ||
          image.sourceConversationId !== parent.conversation_id ||
          image.sha256 !== other.sha256 ||
          image.name !== other.name ||
          image.mime !== other.mime ||
          image.size !== other.size ||
          image.alt !== other.alt ||
          other.id !== other.sourceId
        )
      })
    )
      throw new BotDomainError("peer_scope", "图片交流身份不一致")
  }
  private images(message: Message) {
    const meta = this.metadata(message.id)
    if (!meta) return []
    return meta.images.filter((image) => {
      const row = this.rows(
        `SELECT a.id FROM bot_message_files f JOIN bot_artifacts a ON a.id=f.artifact_id
        LEFT JOIN bot_artifact_lifecycle l ON l.artifact_id=a.id
        WHERE f.message_id=? AND a.id=? AND a.conversation_id=? AND a.sha256=? AND a.name=? AND a.mime=? AND a.size=?
        AND l.deleted_at IS NULL AND l.purged_at IS NULL AND (? IS NULL OR a.run_id=?)`,
        [
          message.id,
          image.id,
          message.conversation_id,
          image.sha256,
          image.name,
          image.mime,
          image.size,
          meta.delivery.direction === "incoming" ? meta.delivery.recipientRunId : null,
          meta.delivery.direction === "incoming" ? meta.delivery.recipientRunId : null
        ]
      )[0]
      return Boolean(row)
    })
  }
  private attachments(message: Message) {
    const projection = attachmentsForMessages(this.store, [message]).get(message.id)
    const metadata = this.metadata(message.id)
    const selected = metadata?.images
    const files = (projection?.files ?? []).filter((file) => {
      if (!metadata || !selected) return file.runId === message.run_id
      if (
        metadata.delivery.direction === "incoming" &&
        file.id.startsWith(`peer-file:${message.id}:`)
      )
        return file.runId === metadata.delivery.recipientRunId && file.origin === "peer"
      return selected.some(
        (source) =>
          source.id === file.id &&
          source.sha256 === file.sha256 &&
          source.name === file.name &&
          source.mime === file.mime &&
          source.size === file.size &&
          (metadata!.delivery.direction !== "incoming" ||
            file.runId === metadata!.delivery.recipientRunId)
      )
    })
    return { attachments: files.map((file) => file.id), attachmentFiles: files }
  }
  /** Generic files reuse the old outbound/inbound attachment links. The delivery
   * JSON and legacy responses stay unchanged, including on an older client. */
  private validateFiles(message: Message): void {
    const incoming = this.metadata(message.id)
    if (!incoming || incoming.delivery.direction !== "incoming") return
    const outboundId = incoming.delivery.counterpart.messageId
    const outgoing = this.metadata(outboundId)
    if (!outgoing) throw new BotDomainError("peer_scope", "文件交流记录不完整")
    // Keep deleted source metadata for provenance: its recipient alias can
    // remain live after the authorized original was deleted.
    const rows = this.rows(
      `SELECT f.message_id,a.id,a.conversation_id,a.run_id,a.name,a.mime,a.size,a.sha256,l.origin
       FROM bot_message_files f JOIN bot_artifacts a ON a.id=f.artifact_id
       LEFT JOIN bot_artifact_lifecycle l ON l.artifact_id=a.id
       WHERE f.message_id IN (?,?) ORDER BY f.message_id,f.rowid LIMIT 13`,
      [message.id, outboundId]
    )
    if (rows.length > 12) throw new BotDomainError("peer_scope", "文件交流附件关联超限")
    const received = rows.filter(
      (row) =>
        row.message_id === message.id && !incoming.images.some((image) => image.id === row.id)
    )
    const sent = rows.filter(
      (row) =>
        row.message_id === outboundId && !outgoing.images.some((image) => image.id === row.id)
    )
    if (
      received.length !== sent.length ||
      received.some((file, index) => {
        const source = sent[index]
        return (
          file.id !== `peer-file:${message.id}:${index}` ||
          file.origin !== "peer" ||
          file.conversation_id !== message.conversation_id ||
          file.run_id !== incoming.delivery.recipientRunId ||
          source.conversation_id !== incoming.delivery.counterpart.conversationId ||
          file.name !== source.name ||
          file.mime !== source.mime ||
          file.size !== source.size ||
          file.sha256 !== source.sha256
        )
      })
    )
      throw new BotDomainError("peer_scope", "文件交流身份不一致")
  }
  /** Only an original durable peer-inbox association supplies this address.
   * Reads are batched by the visible page; no other messages enter the view. */
  private mergedRecords(ids: Iterable<string>) {
    type Item = {
      parent: Run
      child: Run
      request: Message
      handoff: z.infer<typeof handoffSchema>
      senderName: string
      recipientName: string
      followupId: string | null
    }
    const result = new Map<string, Item>(),
      unique = [...new Set(ids)]
    if (!unique.length) return result
    if (unique.length > 200) throw new BotDomainError("invalid_input", "回信投影超出消息分页范围")
    const chunks = (values: string[], read: (batch: string[]) => void) => {
      for (let i = 0; i < values.length; i += 200) read(values.slice(i, i + 200))
    }
    const placeholders = (batch: string[]) => batch.map(() => "?").join(",")
    const requests = new Map<
      string,
      { message: Message; target: string; followup: string | null }
    >()
    chunks(unique, (batch) => {
      for (const row of this.rows(
        `SELECT ${messageColumns},s.run_id AS target_run,s.followup_run_id
        FROM bot_messages m JOIN bot_steering s ON s.message_id=m.id
        LEFT JOIN bot_message_threads t ON t.message_id=m.id WHERE m.id IN (${placeholders(batch)})`,
        batch
      )) {
        const parsed = messageSchema.safeParse(row)
        if (
          parsed.success &&
          parsed.data.sender === "bot" &&
          typeof row.target_run === "string" &&
          (row.followup_run_id === null || typeof row.followup_run_id === "string")
        )
          requests.set(parsed.data.id, {
            message: parsed.data,
            target: row.target_run,
            followup: row.followup_run_id as string | null
          })
      }
    })
    if (!requests.size) return result
    const events = new Map<
      string,
      { senderRunId: string; recipientRunId: string; mergedIntoRunId: string }
    >()
    const event = z.object({
      senderRunId: text,
      recipientRunId: text,
      mergedIntoRunId: text
    })
    chunks([...requests.keys()], (batch) => {
      for (const row of this.rows(
        `SELECT entity_id,payload FROM bot_events INDEXED BY bot_event_entity_kind
        WHERE entity_id IN (${placeholders(batch)}) AND kind='peer.message'`,
        batch
      )) {
        try {
          const parsed = event.safeParse(JSON.parse(String(row.payload)))
          if (parsed.success) events.set(String(row.entity_id), parsed.data)
        } catch {
          /* no guessed link */
        }
      }
    })
    const runs = new Map<string, Run>()
    chunks([...requests.keys()], (batch) => {
      // Nine bounded ancestor observations include the sender and depth 0..8.
      // Cycles are rejected below; a corrupt chain cannot recurse indefinitely.
      for (const row of this.rows(
        `WITH RECURSIVE selected(id,hops) AS (
        SELECT m.run_id,0 FROM bot_messages m WHERE m.id IN (${placeholders(batch)})
        UNION ALL SELECT r.parent_run_id,s.hops+1 FROM selected s JOIN bot_runs r ON r.id=s.id
        WHERE r.parent_run_id IS NOT NULL AND s.hops<8
      ) SELECT DISTINCT ${runColumns} FROM selected s JOIN bot_runs r ON r.id=s.id
        LEFT JOIN bot_message_threads t ON t.message_id=r.message_id`,
        batch
      )) {
        const parsed = runSchema.safeParse(row)
        if (parsed.success) runs.set(parsed.data.id, parsed.data)
      }
    })
    const meta = new Map<string, ReturnType<BotPeerExchanges["metadata"]>>()
    const loadMeta = (values: string[]) =>
      chunks(values, (batch) => {
        for (const id of batch) meta.set(id, null)
        for (const row of this.rows(
          `SELECT message_id,images,delivery FROM bot_message_peer_images WHERE message_id IN (${placeholders(batch)})`,
          batch
        )) {
          try {
            meta.set(String(row.message_id), {
              images: botPeerMessageImages.parse(JSON.parse(String(row.images))),
              delivery: botPeerDelivery.parse(JSON.parse(String(row.delivery)))
            })
          } catch {
            /* invalid metadata never supplies an address */
          }
        }
      })
    loadMeta([...requests.keys()])
    const outgoingIds = [
      ...new Set(
        [...meta.values()].flatMap((value) =>
          value?.delivery.mergedIntoRunId ? [value.delivery.counterpart.messageId] : []
        )
      )
    ]
    const outbound = new Map<string, Message>()
    if (outgoingIds.length) {
      loadMeta(outgoingIds)
      chunks(outgoingIds, (batch) => {
        for (const row of this.rows(
          `SELECT ${messageColumns} FROM bot_messages m LEFT JOIN bot_message_threads t ON t.message_id=m.id WHERE m.id IN (${placeholders(batch)})`,
          batch
        )) {
          const parsed = messageSchema.safeParse(row)
          if (parsed.success) outbound.set(parsed.data.id, parsed.data)
        }
      })
    }
    const names = new Map<string, string>()
    const bots = [...new Set([...runs.values()].map((run) => run.bot_id))]
    chunks(bots, (batch) => {
      for (const row of this.rows(
        `SELECT id,name FROM bots WHERE id IN (${placeholders(batch)})`,
        batch
      ))
        if (typeof row.id === "string" && typeof row.name === "string") names.set(row.id, row.name)
    })
    const conversations = new Map<string, { kind: string; members: string[] }>()
    chunks([...new Set([...runs.values()].map((run) => run.conversation_id))], (batch) => {
      for (const row of this.rows(
        `SELECT c.id,c.kind,m.bot_id FROM bot_conversations c
        LEFT JOIN bot_members m ON m.conversation_id=c.id WHERE c.id IN (${placeholders(batch)})`,
        batch
      )) {
        const id = String(row.id),
          value = conversations.get(id) ?? {
            kind: String(row.kind),
            members: []
          }
        if (typeof row.bot_id === "string") value.members.push(row.bot_id)
        conversations.set(id, value)
      }
    })
    for (const [id, { message: request, target, followup }] of requests) {
      const proof = events.get(id),
        parent = request.run_id ? runs.get(request.run_id) : undefined,
        child = runs.get(target)
      if (
        !proof ||
        !parent ||
        !child ||
        parent.id === child.id ||
        parent.bot_id === child.bot_id ||
        proof.senderRunId !== parent.id ||
        proof.recipientRunId !== child.id ||
        proof.mergedIntoRunId !== child.id ||
        request.bot_id !== parent.bot_id ||
        request.conversation_id !== child.conversation_id ||
        request.reply_to !== child.message_id ||
        (request.thread_root ?? null) !== child.thread_root
      )
        continue
      let cursor: Run | undefined = parent,
        valid = false
      const seen = new Set<string>()
      for (let depth = 0; depth <= 8 && cursor; depth++) {
        if (seen.has(cursor.id) || cursor.root_run_id !== child.root_run_id) break
        seen.add(cursor.id)
        if (cursor.id === child.id) {
          valid = true
          break
        }
        const next = cursor.parent_run_id ? runs.get(cursor.parent_run_id) : undefined
        if (next && next.depth + 1 !== cursor.depth) break
        cursor = next
      }
      const recipient = conversations.get(child.conversation_id)
      if (
        !valid ||
        recipient?.kind !== "direct" ||
        recipient.members.length !== 1 ||
        recipient.members[0] !== child.bot_id
      )
        continue
      const senderName = names.get(parent.bot_id),
        recipientName = names.get(child.bot_id)
      if (!senderName || !recipientName) continue
      const incoming = meta.get(id),
        handoff = {
          recipient: child.bot_id,
          runId: child.id,
          messageId: id,
          ...(incoming ? { outgoingMessageId: incoming.delivery.counterpart.messageId } : {})
        }
      try {
        if (
          incoming &&
          (incoming.delivery.mergedIntoRunId !== child.id ||
            meta.get(incoming.delivery.counterpart.messageId)?.delivery.mergedIntoRunId !==
              child.id)
        )
          continue
        this.validateDelivery(
          request,
          parent,
          child,
          handoff,
          (key) => meta.get(key) ?? null,
          (key) => {
            const value = outbound.get(key)
            if (!value) throw new BotDomainError("peer_scope", "回信对照消息丢失")
            return value
          }
        )
        result.set(id, {
          parent,
          child,
          request,
          handoff,
          senderName,
          recipientName,
          followupId: followup
        })
      } catch {
        /* corrupt or incomplete records remain unlinked */
      }
    }
    return result
  }
  private mergedLink(
    item: ReturnType<BotPeerExchanges["mergedRecords"]> extends Map<string, infer Item>
      ? Item
      : never,
    outgoing: boolean
  ): BotPeerExchangeLink {
    return {
      anchor: address(outgoing ? item.parent : item.child),
      peerRunId: item.parent.id,
      mergedMessageId: item.request.id,
      direction: outgoing ? "outgoing" : "incoming",
      peer: {
        botId: outgoing ? item.child.bot_id : item.parent.bot_id,
        name: outgoing ? item.recipientName : item.senderName
      }
    }
  }
  private readMerged(input: z.infer<typeof botPeerExchangeRequest>): BotPeerExchange {
    const item = this.mergedRecords([input.mergedMessageId!]).get(input.mergedMessageId!)
    if (!item || input.peerRunId !== item.parent.id)
      throw new BotDomainError("peer_scope", "回信不属于当前协作")
    const owner = input.anchor.runId === item.parent.id ? item.parent : item.child
    if (
      input.anchor.runId !== owner.id ||
      input.anchor.conversationId !== owner.conversation_id ||
      (input.anchor.threadRootId ?? null) !== owner.thread_root
    )
      throw new BotDomainError("peer_scope", "只能查看本任务发出或收到的回信")
    let target = item.child
    if (item.followupId) {
      const follow = this.run(item.followupId)
      if (
        follow.bot_id !== item.child.bot_id ||
        follow.conversation_id !== item.child.conversation_id ||
        follow.root_run_id !== item.parent.root_run_id ||
        follow.message_id !== item.request.id ||
        follow.parent_run_id !== item.parent.id ||
        follow.thread_root !== item.child.thread_root
      )
        throw new BotDomainError("peer_scope", "回信后续任务身份不一致")
      target = follow
    }
    if (input.includeFiles) this.validateFiles(item.request)
    const value = botPeerExchange.parse({
      anchor: input.anchor,
      peerRunId: item.parent.id,
      mergedMessageId: item.request.id,
      dataEpoch: input.expectedDataEpoch,
      sender: { botId: item.parent.bot_id, name: item.senderName },
      recipient: { botId: item.child.bot_id, name: item.recipientName },
      status: target.status,
      revision: target.revision,
      request: {
        id: item.request.id,
        conversationId: item.request.conversation_id,
        text: item.request.text,
        createdAt: item.request.created_at,
        images: this.images(item.request),
        ...(input.includeFiles ? this.attachments(item.request) : {})
      },
      reply: null
    })
    // The recipient's user task may contain private facts, so its ordinary final
    // answer is never inferred to be a response to this explicit Bot message.
    this.store.assertMutationEpoch(input.expectedDataEpoch)
    return value
  }

  read(raw: unknown): BotPeerExchange {
    const input = botPeerExchangeRequest.parse(raw)
    this.store.assertMutationEpoch(input.expectedDataEpoch)
    // Preserve the shared exact address validator. Related child reads stay narrow.
    this.store.assertRunAddress(input.anchor)
    if (input.mergedMessageId) return this.readMerged(input)
    const { parent, child, request } = this.relation(input.peerRunId)
    const owner = input.anchor.runId === parent.id ? parent : child
    if (
      (input.anchor.runId !== parent.id && input.anchor.runId !== child.id) ||
      owner.conversation_id !== input.anchor.conversationId ||
      (owner.thread_root ?? undefined) !== input.anchor.threadRootId
    )
      throw new BotDomainError("peer_scope", "只能查看本任务发出或收到的交流")
    if (input.includeFiles) this.validateFiles(request)
    const replyRow = ["succeeded", "failed", "cancelled", "needs_review"].includes(child.status)
      ? this.rows(
          `SELECT ${messageColumns} FROM bot_messages m LEFT JOIN bot_message_threads t ON t.message_id=m.id
        WHERE m.conversation_id=? AND m.run_id=? AND m.reply_to=? AND m.bot_id=?
        AND m.sender IN ('bot','system') AND NOT EXISTS (SELECT 1 FROM bot_message_peer_images p WHERE p.message_id=m.id)
        ORDER BY m.sequence DESC LIMIT 1`,
          [child.conversation_id, child.id, child.message_id, child.bot_id]
        )[0]
      : undefined
    const reply =
      replyRow && (replyRow.thread_root ?? null) === child.thread_root
        ? messageSchema.parse(replyRow)
        : null
    const view = (message: Message) => ({
      id: message.id,
      conversationId: message.conversation_id,
      text: message.text,
      createdAt: message.created_at,
      images: this.images(message),
      ...(input.includeFiles ? this.attachments(message) : {})
    })
    const result = botPeerExchange.parse({
      anchor: input.anchor,
      peerRunId: child.id,
      dataEpoch: input.expectedDataEpoch,
      sender: { botId: parent.bot_id, name: this.store.getBot(parent.bot_id, true).name },
      recipient: { botId: child.bot_id, name: this.store.getBot(child.bot_id, true).name },
      status: child.status,
      revision: child.revision,
      request: view(request),
      reply: reply ? view(reply) : null
    })
    this.store.assertMutationEpoch(input.expectedDataEpoch)
    return result
  }
  eventLink(anchor: BotRunAddress, childId: string): BotPeerExchangeLink | undefined {
    try {
      const { parent, child } = this.relation(childId)
      const selected = anchor.runId === parent.id ? parent : child
      if (
        (anchor.runId !== parent.id && anchor.runId !== child.id) ||
        anchor.conversationId !== selected.conversation_id ||
        anchor.threadRootId !== (selected.thread_root ?? undefined)
      )
        return undefined
      const incoming = anchor.runId === child.id
      const peerId = incoming ? parent.bot_id : child.bot_id
      return {
        anchor: address(selected),
        peerRunId: child.id,
        direction: incoming ? "incoming" : "outgoing",
        peer: { botId: peerId, name: this.store.getBot(peerId, true).name }
      }
    } catch {
      return undefined
    }
  }
  /** Page-local records use existing PK/owned-child/event indexes. Nothing is
   * cached across pages or restored workspaces; root budgets cap related history. */
  private pageRecords(
    runIds: Iterable<string>,
    metadataIds: Iterable<string>,
    includeOwnedChildren = false
  ) {
    const batches = (ids: Iterable<string>, query: (ids: string[]) => void) => {
      const unique = [...new Set(ids)]
      for (let i = 0; i < unique.length; i += 200) query(unique.slice(i, i + 200))
    }
    const placeholders = (ids: string[]) => ids.map(() => "?").join(",")
    const runs = new Map<string, Run>()
    const loadRuns = (ids: Iterable<string>) =>
      batches(
        [...ids].filter((id) => !runs.has(id)),
        (ids) => {
          for (const row of this.rows(
            `SELECT ${runColumns} FROM bot_runs r LEFT JOIN bot_message_threads t
        ON t.message_id=r.message_id WHERE r.id IN (${placeholders(ids)})`,
            ids
          )) {
            const run = runSchema.safeParse(row)
            if (run.success) runs.set(run.data.id, run.data)
          }
        }
      )
    const metadata = new Map<string, ReturnType<BotPeerExchanges["metadata"]>>()
    const loadMetadata = (ids: Iterable<string>) =>
      batches(
        [...ids].filter((id) => !metadata.has(id)),
        (ids) => {
          for (const id of ids) metadata.set(id, null)
          for (const row of this.rows(
            `SELECT message_id,images,delivery FROM bot_message_peer_images
        WHERE message_id IN (${placeholders(ids)})`,
            ids
          )) {
            try {
              metadata.set(String(row.message_id), {
                images: botPeerMessageImages.parse(JSON.parse(String(row.images))),
                delivery: botPeerDelivery.parse(JSON.parse(String(row.delivery)))
              })
            } catch {
              /* invalid metadata never supplies an address */
            }
          }
        }
      )
    loadRuns(runIds)
    loadMetadata(metadataIds)
    const children = new Map<string, Run[]>()
    const anchors = [...runs.values()]
    if (includeOwnedChildren && anchors.length) {
      const values = anchors.map(() => "(?,?)").join(",")
      const items = this.rows(
        `WITH anchors(id,root_id) AS (VALUES ${values}), selected AS (
        SELECT ${runColumns},ROW_NUMBER() OVER (PARTITION BY r.parent_run_id ORDER BY r.created_at,r.id) AS child_number
        FROM anchors a CROSS JOIN bot_runs r INDEXED BY bot_run_owned_children
        LEFT JOIN bot_message_threads t ON t.message_id=r.message_id
        WHERE r.root_run_id=a.root_id AND r.parent_run_id=a.id AND r.source='peer')
        SELECT * FROM selected WHERE child_number<=64 ORDER BY parent_run_id,child_number LIMIT ?`,
        [...anchors.flatMap((run) => [run.id, run.root_run_id]), anchors.length * 64]
      )
      for (const row of items) {
        const parsed = runSchema.safeParse(row)
        if (!parsed.success) continue
        const child = parsed.data
        runs.set(child.id, child)
        const group = children.get(child.parent_run_id!) ?? []
        group.push(child)
        children.set(child.parent_run_id!, group)
      }
    }
    loadRuns([...metadata.values()].flatMap((meta) => (meta ? [meta.delivery.recipientRunId] : [])))
    loadRuns([...runs.values()].flatMap((run) => (run.parent_run_id ? [run.parent_run_id] : [])))
    loadRuns(
      [...runs.values()].flatMap((run) =>
        run.peer_automatic === 1 && run.peer_reply_run ? [run.peer_reply_run] : []
      )
    )
    return {
      runs,
      metadata,
      children,
      batches,
      placeholders,
      loadMetadata,
      loadRuns
    }
  }
  /** Shared exact-lineage validation for message and execution-history pages. */
  private pageLinks(records: ReturnType<BotPeerExchanges["pageRecords"]>, tasks: Run[]) {
    const { runs, metadata, batches, placeholders, loadMetadata } = records
    const handoffs = new Map<string, z.infer<typeof handoffSchema>>()
    batches(
      tasks.map((run) => run.parent_run_id!),
      (ids) => {
        const events = this.rows(
          `WITH selected AS (SELECT entity_id,payload,
        ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY cursor DESC) AS event_number
        FROM bot_events INDEXED BY bot_event_entity_kind WHERE entity_id IN (${placeholders(ids)}) AND kind='run.handoff')
        SELECT entity_id,payload FROM selected WHERE event_number<=64 ORDER BY entity_id,event_number LIMIT ?`,
          [...ids, ids.length * 64]
        )
        for (const event of events) {
          try {
            const parsed = handoffSchema.safeParse(JSON.parse(String(event.payload)))
            if (
              parsed.success &&
              runs.get(parsed.data.runId)?.parent_run_id === event.entity_id &&
              !handoffs.has(parsed.data.runId)
            )
              handoffs.set(parsed.data.runId, parsed.data)
          } catch {
            /* preserve the original history without inventing a link */
          }
        }
      }
    )
    const messages = new Map<string, Message>()
    batches(
      [
        ...tasks.map((run) => run.message_id),
        ...[...handoffs.values()].flatMap((handoff) =>
          handoff.outgoingMessageId ? [handoff.outgoingMessageId] : []
        )
      ],
      (ids) => {
        for (const row of this.rows(
          `SELECT ${messageColumns} FROM bot_messages m LEFT JOIN bot_message_threads t
        ON t.message_id=m.id WHERE m.id IN (${placeholders(ids)})`,
          ids
        )) {
          const parsed = messageSchema.safeParse(row)
          if (parsed.success) messages.set(parsed.data.id, parsed.data)
        }
      }
    )
    loadMetadata(messages.keys())
    const conversations = new Map<string, { kind: string; members: string[] }>()
    batches(
      tasks.map((run) => run.conversation_id),
      (ids) => {
        for (const row of this.rows(
          `SELECT c.id,c.kind,m.bot_id FROM bot_conversations c LEFT JOIN bot_members m
        ON m.conversation_id=c.id WHERE c.id IN (${placeholders(ids)})`,
          ids
        )) {
          const id = String(row.id),
            item = conversations.get(id) ?? { kind: String(row.kind), members: [] }
          if (typeof row.bot_id === "string") item.members.push(row.bot_id)
          conversations.set(id, item)
        }
      }
    )
    const names = new Map<string, string>()
    batches(
      tasks.flatMap((run) => [run.bot_id, runs.get(run.parent_run_id!)?.bot_id ?? ""]),
      (ids) => {
        for (const row of this.rows(
          `SELECT id,name FROM bots WHERE id IN (${placeholders(ids)})`,
          ids
        ))
          names.set(String(row.id), String(row.name))
      }
    )
    const valid = new Set<string>()
    const readMessage = (id: string) => {
      const message = messages.get(id)
      if (!message) throw new BotDomainError("peer_unavailable", "交流消息不存在")
      return message
    }
    for (const child of tasks) {
      const parent = runs.get(child.parent_run_id!),
        request = messages.get(child.message_id),
        handoff = handoffs.get(child.id),
        recipient = conversations.get(child.conversation_id)
      if (
        !parent ||
        !request ||
        !handoff ||
        recipient?.kind !== "direct" ||
        recipient.members.length !== 1 ||
        recipient.members[0] !== child.bot_id
      )
        continue
      try {
        assertRelation(
          parent,
          child,
          request,
          handoff,
          this.expectedReplyTo(parent, child, request, (id) => {
            const run = runs.get(id)
            if (!run) throw new BotDomainError("peer_scope", "原请求不在本页关联中")
            return run
          })
        )
        this.validateDelivery(
          request,
          parent,
          child,
          handoff,
          (id) => metadata.get(id) ?? null,
          readMessage
        )
        valid.add(child.id)
      } catch {
        /* exact lineage is required */
      }
    }
    return { valid, names }
  }
  forEvents(
    anchor: BotRunAddress,
    rows: Record<string, unknown>[]
  ): Map<number, BotPeerExchangeLink> {
    const links = new Map<number, BotPeerExchangeLink>()
    if (rows.length > 50) throw new BotDomainError("invalid_input", "交流投影超出任务历史分页范围")
    const events = new Map<number, string>()
    for (const row of rows) {
      if (!["run.handoff", "run.waiting_peer", "run.peer_returned"].includes(String(row.kind)))
        continue
      try {
        const payload = JSON.parse(String(row.payload))
        const childId = row.kind === "run.handoff" ? payload.runId : payload.childId
        if (typeof childId === "string" && typeof row.cursor === "number")
          events.set(row.cursor, childId)
      } catch {
        /* Unknown legacy events keep their original summary, without a guessed link. */
      }
    }
    const updates = rows.flatMap((row) => {
      if (row.kind !== "run.peer_updated") return []
      try {
        const data = JSON.parse(String(row.payload))
        return typeof data.messageId === "string" && typeof row.cursor === "number"
          ? [{ cursor: row.cursor, id: data.messageId }]
          : []
      } catch {
        return []
      }
    })
    const merged = this.mergedRecords(updates.map((update) => update.id))
    for (const update of updates) {
      const item = merged.get(update.id)
      if (!item) continue
      const outgoing = anchor.runId === item.parent.id
      const owner = outgoing ? item.parent : item.child
      if (
        anchor.runId !== owner.id ||
        anchor.conversationId !== owner.conversation_id ||
        (anchor.threadRootId ?? null) !== owner.thread_root
      )
        continue
      links.set(update.cursor, this.mergedLink(item, outgoing))
    }
    if (!events.size) return links
    const records = this.pageRecords([anchor.runId, ...new Set(events.values())], [])
    const tasks = [...new Set(events.values())].flatMap((id) => {
      const child = records.runs.get(id)
      return child?.source === "peer" && child.parent_run_id ? [child] : []
    })
    if (!tasks.length) return links
    const { valid, names } = this.pageLinks(records, tasks)
    for (const [cursor, childId] of events) {
      if (!valid.has(childId)) continue
      const child = records.runs.get(childId)!,
        parent = records.runs.get(child.parent_run_id!)!
      const incoming = anchor.runId === child.id
      const owner = incoming ? child : parent
      if (
        (!incoming && anchor.runId !== parent.id) ||
        anchor.conversationId !== owner.conversation_id ||
        anchor.threadRootId !== (owner.thread_root ?? undefined)
      )
        continue
      const peerId = incoming ? parent.bot_id : child.bot_id,
        name = names.get(peerId)
      if (name)
        links.set(cursor, {
          anchor: address(owner),
          peerRunId: child.id,
          direction: incoming ? "incoming" : "outgoing",
          peer: { botId: peerId, name }
        })
    }
    return links
  }
  forMessages(rows: Record<string, unknown>[]): Map<string, BotPeerExchangeLink[]> {
    const links = new Map<string, BotPeerExchangeLink[]>()
    const eligible = rows.filter((row) => typeof row.run_id === "string")
    if (!eligible.length) return links
    if (rows.length > 200) throw new BotDomainError("invalid_input", "交流投影超出消息分页范围")
    const mergedIds = eligible.flatMap((row) =>
      typeof row.steering_run_id === "string" && row.sender === "bot" ? [String(row.id)] : []
    )
    const records = this.pageRecords(
      eligible.map((row) => String(row.run_id)),
      eligible.map((row) => String(row.id)),
      true
    )
    const { runs, children, metadata } = records
    const incomingMerged = [
      ...new Set([
        ...mergedIds,
        ...[...metadata.entries()].flatMap(([id, meta]) =>
          meta?.delivery.mergedIntoRunId
            ? [meta.delivery.direction === "incoming" ? id : meta.delivery.counterpart.messageId]
            : []
        )
      ])
    ]
    const merged = this.mergedRecords(incomingMerged)
    for (const row of eligible) {
      const direct = merged.get(String(row.id)),
        meta = metadata.get(String(row.id))
      const item =
        direct ??
        (meta?.delivery.mergedIntoRunId
          ? merged.get(meta.delivery.counterpart.messageId)
          : undefined)
      if (!item) continue
      const outgoing = String(row.id) === item.handoff.outgoingMessageId
      const owner = outgoing ? item.parent : item.child
      if (
        row.conversation_id !== owner.conversation_id ||
        (row.thread_root ?? null) !== owner.thread_root
      )
        continue
      links.set(String(row.id), [this.mergedLink(item, outgoing)])
    }
    const selected = new Map<string, Run[]>()
    for (const row of eligible) {
      if (links.has(String(row.id))) continue
      const run = runs.get(String(row.run_id))
      if (!run) continue
      const meta = metadata.get(String(row.id))
      let tasks: Run[]
      if (meta) {
        const child = runs.get(meta.delivery.recipientRunId)
        tasks = child ? [child] : []
      } else if (run.conversation_id === row.conversation_id) {
        tasks = children.get(run.id) ?? []
        if (run.source === "peer" && row.reply_to === run.message_id && row.bot_id === run.bot_id)
          tasks = [run, ...tasks]
      } else {
        tasks = (children.get(run.id) ?? []).filter(
          (child) => child.message_id === row.id && child.conversation_id === row.conversation_id
        )
        const parent = run.parent_run_id ? runs.get(run.parent_run_id) : undefined
        if (
          run.source === "peer" &&
          parent &&
          parent.conversation_id === row.conversation_id &&
          row.reply_to === parent.message_id &&
          row.bot_id === run.bot_id
        )
          tasks = [run]
      }
      selected.set(String(row.id), tasks)
    }
    const tasks = [
      ...new Map(
        [...selected.values()]
          .flat()
          .filter((run) => run.source === "peer" && run.parent_run_id)
          .map((run) => [run.id, run])
      ).values()
    ]
    if (!tasks.length) return links
    const { valid, names } = this.pageLinks(records, tasks)
    for (const row of eligible) {
      if (links.has(String(row.id))) continue
      const result = (selected.get(String(row.id)) ?? []).flatMap((child) => {
        if (!valid.has(child.id)) return []
        const incoming =
          child.conversation_id === row.conversation_id &&
          (child.message_id === row.id ||
            (row.run_id === child.id &&
              row.reply_to === child.message_id &&
              row.bot_id === child.bot_id))
        const owner = incoming ? child : runs.get(child.parent_run_id!)
        if (
          !owner ||
          owner.conversation_id !== row.conversation_id ||
          (owner.thread_root ?? undefined) !== (row.thread_root ?? undefined)
        )
          return []
        const peerId = incoming ? runs.get(child.parent_run_id!)!.bot_id : child.bot_id,
          name = names.get(peerId)
        return name
          ? [
              {
                anchor: address(owner),
                peerRunId: child.id,
                direction: incoming ? ("incoming" as const) : ("outgoing" as const),
                peer: { botId: peerId, name }
              }
            ]
          : []
      })
      if (result.length) links.set(String(row.id), result)
    }
    return links
  }
}
