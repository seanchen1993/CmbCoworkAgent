import { types } from "node:util"
import type {
  FunctionConversationCheckpointMember,
  FunctionConversationCheckpointMembershipSnapshot
} from "../checkpointer/function-conversation-checkpoint-membership"

const originalJson = JSON,
  originalParse = JSON.parse,
  originalStringify = JSON.stringify
const descriptor = Object.getOwnPropertyDescriptor
const ownKeys = Reflect.ownKeys
const isFrozen = Object.isFrozen
const freeze = Object.freeze
const NativeMap = Map,
  NativeWeakMap = WeakMap
const weakGet = WeakMap.prototype.get,
  weakSet = WeakMap.prototype.set
const mapGet = Map.prototype.get,
  mapSet = Map.prototype.set,
  mapHas = Map.prototype.has
const apply = Reflect.apply
const arrayPush = Array.prototype.push,
  arrayShift = Array.prototype.shift
const arrayFind = Array.prototype.find
const MAX_TEXT_CHARACTERS = 1024 * 1024
const MAX_CACHE_CHARACTERS = 2 * MAX_TEXT_CHARACTERS
const MAX_ENTRIES = 4

function originalJsonMethods(): boolean {
  const global = descriptor(globalThis, "JSON")
  const parse = descriptor(originalJson, "parse"),
    stringify = descriptor(originalJson, "stringify")
  return (
    !!global &&
    "value" in global &&
    global.value === originalJson &&
    !!parse &&
    "value" in parse &&
    parse.value === originalParse &&
    !!stringify &&
    "value" in stringify &&
    stringify.value === originalStringify &&
    !descriptor(Object.prototype, "toJSON") &&
    !descriptor(Array.prototype, "toJSON")
  )
}

/** Reuse exact text interpretation only. Fresh receipt/cut/source checks belong to the Store. */
export class CheckpointSnapshotInterpretations {
  private readonly entries: Array<{
    text: string
    snapshot: FunctionConversationCheckpointMembershipSnapshot
    digest: string
  }> = []
  private characters = 0
  private readonly indexes = new NativeWeakMap<
    object,
    {
      snapshot: FunctionConversationCheckpointMembershipSnapshot
      index: Map<string, FunctionConversationCheckpointMember>
    }
  >()

  constructor(private readonly digestContent: (content: unknown) => string) {}

  read(text: string): {
    snapshot: FunctionConversationCheckpointMembershipSnapshot
    digest: string
  } {
    const reusable = originalJsonMethods() && text.length <= MAX_TEXT_CHARACTERS
    if (reusable) {
      for (let index = 0; index < this.entries.length; index++) {
        const entry = this.entries[index]
        if (entry.text === text) return entry
      }
    }
    const snapshot = JSON.parse(text) as FunctionConversationCheckpointMembershipSnapshot
    const { snapshotDigest: _snapshotDigest, ...content } = snapshot
    void _snapshotDigest
    const digest = this.digestContent(content)
    if (reusable && originalJsonMethods()) {
      // Parsed JSON has no callbacks or cycles. Freeze all nested facts before retaining them.
      const pending: unknown[] = [snapshot]
      for (let index = 0; index < pending.length; index++) {
        const value = pending[index]
        if (!value || typeof value !== "object") continue
        const keys = ownKeys(value)
        for (let position = 0; position < keys.length; position++) {
          const field = descriptor(value, keys[position])
          if (field && "value" in field && field.value && typeof field.value === "object")
            apply(arrayPush, pending, [field.value])
        }
        freeze(value)
      }
      while (
        this.entries.length >= MAX_ENTRIES ||
        this.characters + text.length > MAX_CACHE_CHARACTERS
      ) {
        const removed = apply(arrayShift, this.entries, []) as
          | (typeof this.entries)[number]
          | undefined
        if (removed) this.characters -= removed.text.length
      }
      apply(arrayPush, this.entries, [freeze({ text, snapshot, digest })])
      this.characters += text.length
    }
    return { snapshot, digest }
  }

  /** Store calls this only after the original private proof's full current guard succeeds. */
  member(
    proof: object,
    snapshot: FunctionConversationCheckpointMembershipSnapshot,
    uuid: string
  ): FunctionConversationCheckpointMember | undefined {
    // Only immutable private facts can acquire an index; arbitrary mutable inputs retain find.
    if (types.isProxy(snapshot) || !isFrozen(snapshot))
      return snapshot.members.find((item) => item.uuid === uuid)
    const membersField = descriptor(snapshot, "members")
    const members = membersField && "value" in membersField ? membersField.value : undefined
    const find = descriptor(Array.prototype, "find")
    if (
      !Array.isArray(members) ||
      types.isProxy(members) ||
      !isFrozen(members) ||
      members.length > 4096 ||
      descriptor(members, "find") ||
      !find ||
      !("value" in find) ||
      find.value !== arrayFind
    )
      return snapshot.members.find((item) => item.uuid === uuid)
    const previous = apply(weakGet, this.indexes, [proof]) as
      | {
          snapshot: FunctionConversationCheckpointMembershipSnapshot
          index: Map<string, FunctionConversationCheckpointMember>
        }
      | undefined
    let index = previous?.snapshot === snapshot ? previous.index : undefined
    if (!index) {
      index = new NativeMap()
      let characters = 0
      for (let position = 0; position < members.length; position++) {
        const field = descriptor(members, String(position))
        const member = field && "value" in field ? field.value : undefined
        if (!member || typeof member !== "object" || types.isProxy(member) || !isFrozen(member))
          return snapshot.members.find((item) => item.uuid === uuid)
        const id = descriptor(member, "uuid")
        if (
          !id ||
          !("value" in id) ||
          typeof id.value !== "string" ||
          (characters += id.value.length) > MAX_TEXT_CHARACTERS
        )
          return snapshot.members.find((item) => item.uuid === uuid)
        if (!apply(mapHas, index, [id.value])) apply(mapSet, index, [id.value, member])
      }
      apply(weakSet, this.indexes, [proof, { snapshot, index }])
    }
    return apply(mapGet, index, [uuid]) as FunctionConversationCheckpointMember | undefined
  }
}
