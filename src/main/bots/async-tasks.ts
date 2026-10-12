import {
  botAsyncTasksRequest,
  type BotAsyncTasksPage,
  type BotAsyncTask
} from "../../shared/bot-async-tasks"
import { BotDomainError } from "../../shared/bot-types"
import type { BotStore } from "./store"
import { runStatus } from "./stored-types"

const live = "('queued','running','waiting_input','cancelling','needs_review')"

/** Project durable live work, including interrupted tasks. Never publish scripts,
 * role prompts, configuration snapshots, credentials or full model checkpoints. */
export function listBotAsyncTasks(store: BotStore, raw: unknown): BotAsyncTasksPage {
  const parsed = botAsyncTasksRequest.safeParse(raw)
  if (!parsed.success) throw new BotDomainError("invalid_input", "后台任务分页参数无效")
  const { botId, before, limit = 20 } = parsed.data
  store.getBot(botId)
  if (before && before.botId !== botId)
    throw new BotDomainError("task_cursor_scope", "任务分页位置不属于当前 Bot")
  const rows =
    store.db.exec(
      `
    WITH tasks AS (
      SELECT 'child:'||r.id AS task_key,'child' AS kind,r.id AS run_id,r.conversation_id,t.root_id,
        substr(json_extract(c.input,'$.label'),1,300) AS label,
        substr(json_extract(c.input,'$.phase'),1,300) AS phase,CASE WHEN parent.status='needs_review' THEN 'needs_review' ELSE r.status END AS status,r.created_at,r.updated_at
      FROM bot_runs r JOIN bot_workflow_children c ON c.run_id=r.id
      JOIN bot_runs parent ON parent.id=r.parent_run_id
      LEFT JOIN bot_message_threads t ON t.message_id=r.message_id
      WHERE r.bot_id=? AND r.status IN ${live}
      UNION ALL
      SELECT 'workflow:'||w.id,'workflow',r.id,r.conversation_id,t.root_id,
        substr(json_extract(w.state,'$.workflowName'),1,300),
        substr(json_extract(w.state,'$.currentPhase'),1,300),
        CASE WHEN r.status IN ('needs_review','cancelling') THEN r.status
          WHEN json_extract(w.state,'$.status')='completed' THEN 'succeeded'
          WHEN json_extract(w.state,'$.status')='error' THEN 'failed'
          WHEN json_extract(w.state,'$.status')='aborted' THEN 'cancelled' ELSE r.status END,
        COALESCE(CAST((julianday(json_extract(w.state,'$.startedAt'))-2440587.5)*86400000 AS INTEGER),r.created_at),w.updated_at
      FROM bot_background_workflows b JOIN bot_workflows w ON w.id=b.workflow_id
      JOIN bot_runs r ON r.id=w.run_id LEFT JOIN bot_message_threads t ON t.message_id=r.message_id
      WHERE r.bot_id=? AND b.receipt IS NULL AND r.status IN ${live}
        AND NOT EXISTS(SELECT 1 FROM bot_workflow_children c JOIN bot_runs child ON child.id=c.run_id
          WHERE c.workflow_id=w.id AND child.status IN ${live})
      UNION ALL
      SELECT 'shell:'||s.id,'shell',r.id,r.conversation_id,t.root_id,substr(s.command,1,160),NULL,
        CASE WHEN r.status='needs_review' THEN 'needs_review' ELSE s.status END,s.created_at,s.updated_at
      FROM bot_shell_jobs s JOIN bot_runs r ON r.id=s.run_id
      LEFT JOIN bot_message_threads t ON t.message_id=r.message_id
      WHERE r.bot_id=? AND s.status IN ('queued','running','cancelling','needs_review')
        AND (s.status<>'needs_review' OR EXISTS(SELECT 1 FROM bot_effects e WHERE e.id=s.effect_id AND e.status IN ('started','unknown')))
        AND (r.status IN ${live} OR EXISTS(SELECT 1 FROM bot_shell_services service WHERE service.job_id=s.id))
    ) SELECT task_key,kind,run_id,conversation_id,root_id,label,phase,status,created_at,updated_at
    FROM tasks WHERE EXISTS(SELECT 1 FROM bot_members m WHERE m.conversation_id=tasks.conversation_id AND m.bot_id=?)
      ${before ? "AND (created_at<? OR (created_at=? AND task_key<?))" : ""}
    ORDER BY created_at DESC,task_key DESC LIMIT ?`,
      [botId, botId, botId, botId, ...(before ? [before.at, before.at, before.key] : []), limit + 1]
    )[0]?.values ?? []
  const items: BotAsyncTask[] = rows.slice(0, limit).map((row) => ({
    key: String(row[0]),
    kind: row[1] === "child" ? "child" : row[1] === "shell" ? "shell" : "workflow",
    ...(row[1] === "shell" ? { jobId: String(row[0]).slice(6) } : {}),
    address: {
      runId: String(row[2]),
      conversationId: String(row[3]),
      ...(row[4] ? { threadRootId: String(row[4]) } : {})
    },
    label: String(row[5] || "后台任务"),
    phase: row[6] === null ? null : String(row[6]),
    status: runStatus.parse(row[7]),
    createdAt: Number(row[8]),
    updatedAt: Number(row[9])
  }))
  const last = items.at(-1)
  return {
    items,
    next: rows.length > limit && last ? { botId, at: last.createdAt, key: last.key } : null
  }
}
