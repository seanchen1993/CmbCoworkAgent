import { createHash } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import type { HookResult } from "../hooks/types"
import type { BotRuntimeRequest } from "./host"
import { canonicalJson } from "./validation"

const rowSchema = z.tuple([z.string(), z.string(), z.number().nullable()])

/** Cmb Setup is per project, before SessionStart. The Host owns the marker:
 * a writable workspace file cannot attest that required initialization ran.
 * Every command still uses the ordinary Hook approval and effect receipts. */
export class BotWorkspaceSetup {
  private waiting = false
  private readonly workspaceKey: string
  constructor(
    private readonly request: BotRuntimeRequest,
    identity: { root: string; dev: string; ino: string },
    private readonly configuration: string,
    private readonly assertCurrent: () => Promise<void>
  ) {
    this.workspaceKey = createHash("sha256")
      .update(
        canonicalJson({
          ...identity,
          root: process.platform === "win32" ? identity.root.toLowerCase() : identity.root
        })
      )
      .digest("hex")
  }

  private waitingState(waiting: boolean): void {
    if (waiting === this.waiting) return
    const { store, lease } = this.request
    store.assertDispatch(lease, this.waiting)
    if (waiting) this.activity("等待其他 Bot 完成项目初始化检查")
    store.db.run("UPDATE bot_runs SET status=?,revision=revision+1,updated_at=? WHERE id=?", [
      waiting ? "waiting_input" : "running",
      store.now(),
      lease.runId
    ])
    this.waiting = waiting
  }

  /** The caller already owns the state transaction. */
  private activity(description: string): void {
    const { store, lease } = this.request
    store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('run.activity',?,?,?)",
      [lease.runId, JSON.stringify({ kind: "tool", description }), store.now()]
    )
  }

  private claim(): "done" | "owned" | "wait" {
    const { store, lease } = this.request
    return store.transaction(() => {
      store.assertDispatch(lease, this.waiting)
      const raw = store.db.exec(
        "SELECT configuration,run_id,completed_at FROM bot_workspace_setup WHERE workspace_key=?",
        [this.workspaceKey]
      )[0]?.values[0]
      if (raw) {
        const [configuration, ownerId, completedAt] = rowSchema.parse(raw)
        if (configuration === this.configuration && completedAt !== null) {
          this.waitingState(false)
          return "done"
        }
        if (completedAt === null && ownerId !== lease.runId) {
          const owner = store.getRun(ownerId)
          if (!["succeeded", "failed", "cancelled"].includes(owner.status)) {
            this.waitingState(true)
            return "wait"
          }
          if (
            store.effects(ownerId).some((effect) => ["started", "unknown"].includes(effect.status))
          )
            throw new BotDomainError(
              "workspace_setup_review",
              "项目初始化结果不明，请先核对原任务的操作"
            )
        }
        if (completedAt === null && ownerId === lease.runId && configuration !== this.configuration)
          throw new BotDomainError(
            "hook_configuration_changed",
            "项目初始化配置已变化，请重新发起任务"
          )
      }
      this.waitingState(false)
      store.db.run(
        "INSERT INTO bot_workspace_setup VALUES(?,?,?,NULL) ON CONFLICT(workspace_key) DO UPDATE SET configuration=excluded.configuration,run_id=excluded.run_id,completed_at=NULL",
        [this.workspaceKey, this.configuration, lease.runId]
      )
      return "owned"
    })
  }

  async run(execute: () => Promise<HookResult | null>): Promise<void> {
    const { store, lease, signal } = this.request
    await this.assertCurrent()
    try {
      let state: "done" | "owned" | "wait"
      while (true) {
        signal.throwIfAborted()
        store.steering.interruptIfPending(lease)
        state = this.claim()
        if (state !== "wait") break
        await delay(250, undefined, { signal })
      }
      await this.assertCurrent()
      if (state === "done") return
      const result = await execute()
      if (result && (result.exitCode !== 0 || result.blocked || result.continue === false))
        throw new BotDomainError(
          "workspace_setup_failed",
          result.reason ||
            result.stopReason ||
            result.stderr ||
            result.stdout ||
            "项目初始化检查未通过"
        )
      await this.assertCurrent()
      store.transaction(() => {
        store.assertDispatch(lease)
        store.steering.assertNoPending(lease.runId)
        const raw = store.db.exec(
          "SELECT configuration,run_id,completed_at FROM bot_workspace_setup WHERE workspace_key=?",
          [this.workspaceKey]
        )[0]?.values[0]
        const [configuration, owner] = rowSchema.parse(raw)
        if (owner !== lease.runId || configuration !== this.configuration)
          throw new BotDomainError("workspace_setup_owner", "项目初始化执行权已变化")
        store.db.run("UPDATE bot_workspace_setup SET completed_at=? WHERE workspace_key=?", [
          store.now(),
          this.workspaceKey
        ])
        this.activity("项目初始化检查已完成")
      })
    } finally {
      // Restore only the wait state this instance owns. Cancellation or a new
      // lease must retain its state; neither grants permission to finish Setup.
      if (this.waiting) {
        const current = store.getRun(lease.runId)
        if (
          current.leaseOwner === lease.owner &&
          current.fence === lease.fence &&
          current.status === "waiting_input" &&
          (current.leaseUntil ?? 0) > store.now()
        )
          store.transaction(() => this.waitingState(false))
      }
    }
  }
}
