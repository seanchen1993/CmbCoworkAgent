import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { DEFAULT_IM_CHANNEL_ID } from "../../../shared/im-gateway-contract"
import { createThread, getThread } from "../../db"
import { getOpenworkDir } from "../../storage"
import {
  imConversationStateStore,
  type ImConversationStateStore,
  type ImTargetSnapshot
} from "./conversation-state"

export const IM_MANAGED_INBOX_DIRECTORY = "im-inboxes"

export interface ImInboxServiceDependencies {
  conversationState: ImConversationStateStore
  openworkDirectory: () => string
  createThread: typeof createThread
  getThread: typeof getThread
  createId: () => string
  ensureDirectory: (path: string) => Promise<void>
}

export interface EnsureImInboxInput {
  conversationKey: string
  principalId: string
}

function opaqueConversationDirectory(conversationKey: string): string {
  return createHash("sha256").update(conversationKey, "utf8").digest("hex").slice(0, 32)
}

function isInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child === "" || (!child.startsWith("..") && !isAbsolute(child))
}

async function assertDirectoryIsNotSymlink(path: string): Promise<void> {
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Managed IM inbox path is not a real directory")
  }
}

export async function ensureManagedImInboxDirectory(
  openworkDirectory: string,
  conversationKey: string
): Promise<string> {
  const managedRoot = resolve(openworkDirectory, IM_MANAGED_INBOX_DIRECTORY)
  await mkdir(managedRoot, { recursive: true, mode: 0o700 })
  await assertDirectoryIsNotSymlink(managedRoot)

  const workspacePath = join(managedRoot, opaqueConversationDirectory(conversationKey))
  await mkdir(workspacePath, { recursive: true, mode: 0o700 })
  await assertDirectoryIsNotSymlink(workspacePath)

  const [realRoot, realWorkspace] = await Promise.all([
    realpath(managedRoot),
    realpath(workspacePath)
  ])
  if (!isInside(realRoot, realWorkspace)) {
    throw new Error("Managed IM inbox path escaped its application root")
  }
  return realWorkspace
}

export class ImInboxService {
  constructor(
    private readonly dependencies: ImInboxServiceDependencies = {
      conversationState: imConversationStateStore,
      openworkDirectory: getOpenworkDir,
      createThread,
      getThread,
      createId: randomUUID,
      ensureDirectory: (path) => mkdir(path, { recursive: true, mode: 0o700 }).then(() => undefined)
    }
  ) {}

  hasThread(threadId: string): boolean {
    return this.dependencies.getThread(threadId) !== null
  }

  async ensureInbox(input: EnsureImInboxInput): Promise<ImTargetSnapshot & { kind: "inbox" }> {
    this.dependencies.conversationState.assertConversationOwner(
      input.conversationKey,
      input.principalId
    )

    const existingInboxes = this.dependencies.conversationState
      .listTargets(input.conversationKey)
      .filter(({ snapshot }) => snapshot.kind === "inbox")
    for (const existing of existingInboxes) {
      if (existing.snapshot.kind !== "inbox" || existing.state === "revoked") continue
      if (this.dependencies.getThread(existing.snapshot.threadId)) {
        if (existing.state !== "active") {
          await this.dependencies.conversationState.updateTargetState(
            existing.snapshot.targetId,
            "active"
          )
        }
        await this.dependencies.conversationState.setActiveTarget(
          input.conversationKey,
          existing.snapshot.targetId
        )
        return existing.snapshot
      }
      if (existing.state === "active") {
        console.warn("[IM] Managed inbox Thread is missing; recreating it", {
          conversationKey: input.conversationKey,
          targetId: existing.snapshot.targetId,
          threadId: existing.snapshot.threadId
        })
        await this.dependencies.conversationState.updateTargetState(
          existing.snapshot.targetId,
          "suspended",
          "INBOX_THREAD_MISSING"
        )
      }
    }

    const workspacePath = await ensureManagedImInboxDirectory(
      this.dependencies.openworkDirectory(),
      input.conversationKey
    )
    await this.dependencies.ensureDirectory(workspacePath)

    const threadId = this.dependencies.createId()
    const targetId = this.dependencies.createId()
    const snapshot: ImTargetSnapshot & { kind: "inbox" } = {
      kind: "inbox",
      targetId,
      threadId,
      workspacePath
    }

    this.dependencies.createThread(threadId, {
      title: "远程收件箱",
      workspacePath,
      agentMode: "normal",
      targetKind: "inbox",
      remoteThread: true,
      remoteReadOnly: true,
      memoryEnabled: false,
      imDeliveryContext: {
        provider: DEFAULT_IM_CHANNEL_ID,
        principalId: input.principalId,
        conversationKey: input.conversationKey,
        targetId
      }
    })
    await this.dependencies.conversationState.registerTarget(input.conversationKey, snapshot, {
      activate: true
    })
    return snapshot
  }
}

export const imInboxService = new ImInboxService()
