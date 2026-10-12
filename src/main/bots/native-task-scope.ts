import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import type { BotStore } from "./store"
import { isBotComputerTaskInput } from "./computer-task-profile"
import * as v from "./validation"

/** The existing child/run/effect records are the sole desktop reservation.
 * No timer, process-local owner, second queue or restored HWND grants access. */
export function nativeTaskReservation(store: BotStore, botId: string): string | undefined {
  store.getBot(v.identifier(botId))
  const rows =
    store.db.exec(
      `SELECT r.id FROM bot_runs r JOIN bot_workflow_children c ON c.run_id=r.id
     WHERE r.bot_id=? AND json_extract(c.input,'$.desktopAccess')='shared-native'
     AND (r.status IN ('queued','running','waiting_input','cancelling','needs_review')
       OR EXISTS(SELECT 1 FROM bot_effects e WHERE e.run_id=r.id AND e.status IN ('started','unknown')))
     ORDER BY r.created_at,r.rowid LIMIT 2`,
      [botId]
    )[0]?.values ?? []
  if (rows.length > 1)
    throw new BotDomainError("workflow_desktop_review", "存在冲突的应用子任务，请核对后继续")
  return rows[0] ? v.identifier(rows[0][0]) : undefined
}

/** Call only within original reserve/claim transaction. Replaying the same
 * durable child is allowed; a second screen owner is rejected before allocation. */
export function assertNativeTaskAvailable(store: BotStore, botId: string, runId?: string): void {
  const owner = nativeTaskReservation(store, botId)
  if (owner && owner !== runId)
    throw new BotDomainError(
      "workflow_desktop_busy",
      "已有子任务使用此 Bot 的工作应用，请先完成或核对"
    )
}

export function assertBotNativeCaller(request: BotRuntimeRequest): void {
  const { store, run, lease, bot } = request
  store.assertDispatch(lease)
  const owner = nativeTaskReservation(store, bot.id)
  if (run.source === "workflow-child") {
    const child = store.workflowChildren.metadata(run.id)
    if (!child || !isBotComputerTaskInput(child.input) || owner !== run.id)
      throw new BotDomainError("workflow_desktop_scope", "此子任务没有当前工作应用的执行权")
  } else if (owner)
    throw new BotDomainError(
      "workflow_desktop_busy",
      "应用子任务正在使用此屏幕，当前任务可以继续其他工作"
    )
}

/** Observation fencing is cleanup, not new model input. It may collect during
 * cancellation, but only the same original lease/reservation can retire it. */
export function assertNativeTaskFence(request: BotRuntimeRequest): void {
  const { store, run, lease, bot } = request
  request.assertOwnership?.()
  store.assertLease(lease, true, true)
  const child = store.workflowChildren.metadata(run.id)
  if (
    !child ||
    !isBotComputerTaskInput(child.input) ||
    nativeTaskReservation(store, bot.id) !== run.id
  )
    throw new BotDomainError("workflow_desktop_scope", "应用子任务的原始屏幕执行权已变化")
  const parent = store.getRun(child.parentLease.runId)
  const row = store.db.exec("SELECT generation FROM bot_workflows WHERE id=? AND run_id=?", [
    child.workflowId,
    parent.id
  ])[0]?.values[0]
  if (
    parent.leaseOwner !== child.parentLease.owner ||
    parent.fence !== child.parentLease.fence ||
    row?.[0] !== child.generation
  )
    throw new BotDomainError("workflow_stale_writer", "应用子任务所属工作流已被接替")
}
