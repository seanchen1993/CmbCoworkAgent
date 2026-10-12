import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { BotDomainError } from "../../shared/bot-types"
import { BOT_SCHEMA, BOT_SCHEMA_VERSION, botUserSkillVersionBytesSql } from "./schema"

/** Read the version before changing persistent pragmas. The Host lifetime lock
 * excludes other writers while backing up and upgrading the domain database.
 */
export function initializeBotDatabase(db: DatabaseSync, path: string): void {
  db.exec("PRAGMA busy_timeout=5000")
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bot_schema'")
    .get()
  const versions = exists ? db.prepare("SELECT version FROM bot_schema").all() : []
  const version = versions[0]?.version
  if (
    exists &&
    (versions.length !== 1 ||
      ![
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11,
        12,
        13,
        14,
        15,
        16,
        17,
        18,
        19,
        20,
        21,
        22,
        23,
        24,
        25,
        26,
        27,
        28,
        29,
        30,
        31,
        32,
        33,
        34,
        35,
        36,
        37,
        38,
        39,
        40,
        41,
        42,
        43,
        44,
        45,
        46,
        47,
        48,
        49,
        50,
        51,
        52,
        53,
        54,
        55,
        56,
        57,
        58,
        59,
        60,
        61,
        62,
        63,
        64,
        65,
        66,
        67,
        68,
        69,
        70,
        71,
        72,
        73,
        74,
        BOT_SCHEMA_VERSION
      ].includes(Number(version)))
  )
    throw new BotDomainError("schema_version", `不支持 Bot 数据版本 ${String(version)}`)
  if (exists && Number(version) < BOT_SCHEMA_VERSION && path !== ":memory:")
    backupBeforeUpgrade(db, path, Number(version))
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE"
  )
  try {
    if (exists && Number(version) < 71) {
      const columns = db.prepare("PRAGMA table_info(bot_members)").all()
      if (columns.length && !columns.some((column) => column.name === "position")) {
        db.exec(
          "ALTER TABLE bot_members ADD COLUMN position INTEGER NOT NULL DEFAULT 0 CHECK(position>=0)"
        )
        // Preserve the legacy visible order. Old rows do not record the user's
        // original selection; rowid must not be treated as that missing intent.
        // In-flight cycles already own an immutable member_ids/speakers order.
        db.exec(`WITH ranked AS (
          SELECT conversation_id,bot_id,
            ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY bot_id)-1 AS position
          FROM bot_members
        ) UPDATE bot_members SET position=ranked.position FROM ranked
          WHERE bot_members.conversation_id=ranked.conversation_id
            AND bot_members.bot_id=ranked.bot_id`)
      }
    }
    if (exists && Number(version) < 10) {
      const columns = db.prepare("PRAGMA table_info(bot_group_cycles)").all()
      if (columns.length && !columns.some((column) => column.name === "thread_root"))
        db.exec("ALTER TABLE bot_group_cycles ADD COLUMN thread_root TEXT NOT NULL DEFAULT ''")
      db.exec("DROP INDEX IF EXISTS bot_group_active")
    }
    if (exists && Number(version) < 56) {
      const columns = db.prepare("PRAGMA table_info(bot_teach_sessions)").all()
      if (columns.length && !columns.some((column) => column.name === "thread_root"))
        db.exec("ALTER TABLE bot_teach_sessions ADD COLUMN thread_root TEXT")
      if (columns.length && !columns.some((column) => column.name === "start_request"))
        db.exec("ALTER TABLE bot_teach_sessions ADD COLUMN start_request TEXT")
      if (columns.length && !columns.some((column) => column.name === "learning_epoch"))
        db.exec("ALTER TABLE bot_teach_sessions ADD COLUMN learning_epoch TEXT")
    }
    if (exists && Number(version) < 58) {
      const columns = db.prepare("PRAGMA table_info(bot_routines)").all()
      if (columns.length && !columns.some((column) => column.name === "desired_enabled")) {
        db.exec(
          "ALTER TABLE bot_routines ADD COLUMN desired_enabled INTEGER NOT NULL DEFAULT 0 CHECK(desired_enabled IN (0,1))"
        )
        // Preserve known legacy configuration once; never infer intent already lost by a copy.
        db.exec("UPDATE bot_routines SET desired_enabled=enabled")
      }
      if (columns.length && !columns.some((column) => column.name === "activation_required"))
        db.exec(
          "ALTER TABLE bot_routines ADD COLUMN activation_required INTEGER NOT NULL DEFAULT 0 CHECK(activation_required IN (0,1))"
        )
    }
    if (exists && Number(version) < 65) {
      const columns = db.prepare("PRAGMA table_info(bot_primary_checkin)").all()
      if (columns.length && !columns.some((column) => column.name === "activation_fingerprint"))
        db.exec("ALTER TABLE bot_primary_checkin ADD COLUMN activation_fingerprint TEXT")
    }
    // v66 records standing local permission provenance; old explicit grants stay conservative.
    // The version barrier prevents older strict-record readers from opening new grants.
    // v65 distinguishes a primary check-in activation baseline from successful acknowledgement.
    // v63 stores explicit first introductions and cue visibility independently of run retention.
    // v62 stores the unique primary Bot and explicitly authorized, bounded check-in occurrences.
    // v61 stores explicit same-turn messages, image alt text and chosen reply intent.
    // v60 persists native computer handoff separately from browser sessions.
    // v58 separates configured routine intent from effective dispatch and fresh activation.
    // v57 adds Bot-scoped memory indexes without changing evidence, memory policy or scheduling.
    // v56 binds the original Teach Start request and fresh learning authorization, preserving v55 peer facts.
    // Additive versions preserve prior data: v2 persona/output, v3 Teach, v4 connectors, v5 groups, v6 read watermarks, v7 reactions, v8 skills, v9 explicit recipients, v10 message branches and scoped group cycles.
    // v11 persists pinned ordering. Existing messages, work, skills, and execution fences remain unchanged.
    // v12 records the exact approval consumed by an effect. Older effects have no invented link.
    // v13 adds a durable inbox for current-task instructions; graph markers survive compaction.
    // v14 records artifact provenance and deletion tombstones without removing historical references.
    // v15 adds evidenced memory synthesis, correction barriers and explicit origin metadata.
    // v16 stores explicitly shared memories separately from private synthesis evidence.
    // v17 adds explicit user-library skill snapshots without exposing private recordings.
    // v18 caches installed skills read-only; their source grants are rebuilt after startup.
    // v19 stores leased workflow state and append-only replay entries in the same database.
    // v20 gives internal workflow children independent leases without allowing ordinary queue dispatch.
    // v21 binds isolated child worktrees and explicit review actions without moving project files.
    // v22 extends the same root usage ledger to parent, peer and helper model calls.
    // v23 persists background workflow definitions and graph-delivered completion receipts.
    // v24 binds routine skill versions without changing earlier routine schedules or messages.
    // v25 records explicitly selected historical context without migrating source execution state.
    // v27 adds routine-scoped hashed webhook keys, delivery rates and the stable loopback port.
    // v28 stores bounded avatar images separately from the frequently read Bot projection.
    // v29 retains the backup schedule and pending snapshot identity across Host restarts.
    // v30 retains approved background command identities and bounded output; never replays processes.
    // v31 separates explicitly approved cross-turn services from a model turn's lease.
    // v32 records exact-action approval rules and the decision consumed by each interaction.
    // v33 retains independently reviewed decisions and versioned user review settings.
    // v34 records standing routine authority and the exact assignment of each occurrence.
    // Existing schedules receive no fabricated approval or human instruction.
    // v35 records forward-only peer handoff authority; historical peers remain manual.
    // v36 records completed project Setup checks and their owning task; no imported workspace file grants completion.
    // v37 stores human notification preferences independently of execution revisions.
    // v41 retains host-resolved object references beside their initiating message.
    // v42 keeps validated reference positions in immutable message text.
    // v43 records provider-reported task and automatic-memory usage; older calls have no invented usage.
    // v44 adds optional rolling user/Bot output limits over that existing usage ledger.
    // v46 stores immutable message deltas separately; existing inline checkpoints remain readable.
    // v48 retains explicit Harness bindings, per-run prepared context and compact skill visibility. No credentials are stored.
    // v50 adds one-line Bot profile labels; legacy profiles retain their existing responsibilities.
    // v51 preserves exact-action rules while adding explicit permanent refusals.
    // v49 revokes private skill identities while retaining immutable versions and trial evidence.
    // v47 indexes only live workspace rows and restore events for frequent snapshot reads.
    // v45 retains in-flight browser download identities for interruption notices after restart.
    // v40 commits deletion metadata beside domain mutations for restore-safe retention.
    // v39 binds human plugin pane intents to durable Bot runs. Guest closures stay process-local.
    // v55 associates peer replies and priority with existing runs, without replaying historical results.
    // v54 retains bounded peer image identities beside the original delivery message.
    // v38 gives Notification Hooks a separate, scoped approval gate and durable stage.
    if (exists && Number(version) < 38) {
      const columns = db.prepare("PRAGMA table_info(bot_interactions)").all()
      if (!columns.some((column) => column.name === "notification_stage"))
        db.exec(
          "ALTER TABLE bot_interactions ADD COLUMN notification_stage TEXT REFERENCES bot_hook_notifications(id)"
        )
      db.exec("DROP INDEX IF EXISTS bot_one_pending_interaction")
    }
    if (exists && Number(version) < 20) db.exec("DROP INDEX IF EXISTS bot_one_active_run")
    const oldModelLedger =
      exists &&
      Number(version) < 22 &&
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='bot_workflow_model_calls'"
        )
        .get()
    if (oldModelLedger)
      db.exec(`DROP INDEX IF EXISTS bot_workflow_model_root;
      ALTER TABLE bot_workflow_model_calls RENAME TO bot_workflow_model_calls_v21;`)
    // v26 extends trial evidence to installed/shared identities. Only the private-skill
    // foreign key is removed; Bot/run ownership and all prior evidence remain intact.
    const oldTrials =
      exists &&
      Number(version) < 26 &&
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bot_skill_trials'")
        .get()
    if (oldTrials)
      db.exec(`DROP INDEX IF EXISTS bot_trial_run;
      DROP INDEX IF EXISTS bot_trial_verified;
      ALTER TABLE bot_skill_trials RENAME TO bot_skill_trials_v25;`)
    const oldDeletionOutbox =
      exists &&
      Number(version) < 49 &&
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_deletion_outbox'")
        .get()
    if (oldDeletionOutbox)
      db.exec("ALTER TABLE bot_deletion_outbox RENAME TO bot_deletion_outbox_v48")
    const oldApprovalRules =
      exists &&
      Number(version) < 51 &&
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_approval_rules'")
        .get()
    if (oldApprovalRules) db.exec("ALTER TABLE bot_approval_rules RENAME TO bot_approval_rules_v50")
    if (exists && Number(version) < 59) db.exec("DROP INDEX IF EXISTS bot_event_restore_cursor")
    db.exec(BOT_SCHEMA)
    if (exists && Number(version) < 75)
      db.exec(`UPDATE bot_user_skill_history_usage SET
        versions=(SELECT COUNT(*) FROM bot_user_skill_versions),
        payload_bytes=(SELECT COALESCE(SUM(${botUserSkillVersionBytesSql()}),0) FROM bot_user_skill_versions)
        WHERE id=1`)
    if (oldApprovalRules)
      db.exec(`INSERT INTO bot_approval_rules
        (id,bot_id,scope,action_hash,title,prompt,behavior,created_at)
        SELECT id,bot_id,scope,action_hash,title,prompt,behavior,created_at FROM bot_approval_rules_v50;
        DROP TABLE bot_approval_rules_v50;`)
    if (oldDeletionOutbox)
      db.exec(
        "INSERT INTO bot_deletion_outbox SELECT * FROM bot_deletion_outbox_v48; DROP TABLE bot_deletion_outbox_v48;"
      )
    if (oldTrials)
      db.exec(`INSERT INTO bot_skill_trials SELECT * FROM bot_skill_trials_v25;
      DROP TABLE bot_skill_trials_v25;`)
    if (oldModelLedger)
      db.exec(`INSERT INTO bot_workflow_model_calls
      (id,run_id,workflow_id,root_run_id,reserved,consumed,created_at)
      SELECT id,run_id,workflow_id,root_run_id,reserved,consumed,created_at FROM bot_workflow_model_calls_v21;
      DROP TABLE bot_workflow_model_calls_v21;`)
    db.prepare("UPDATE bot_schema SET version=?").run(BOT_SCHEMA_VERSION)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

export function backupBeforeUpgrade(db: DatabaseSync, path: string, version: number): void {
  const directory = join(dirname(path), "backups")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  flushBackupDirectory(dirname(directory))
  const destination = join(directory, `bots-v${version}-${Date.now()}-${randomUUID()}.sqlite`)
  const temporary = `${destination}.pending`
  closeSync(openSync(temporary, "wx", 0o600))
  let cleanupError: unknown
  try {
    // VACUUM INTO includes committed WAL state; copying just the .sqlite file does not.
    db.prepare("VACUUM INTO ?").run(temporary)
    const file = openSync(temporary, "r")
    try {
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(temporary, destination)
    flushBackupDirectory(directory)
  } finally {
    try {
      unlinkSync(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = error
    }
  }
  if (cleanupError) throw cleanupError
}

function flushBackupDirectory(path: string): void {
  // Match the existing maintenance directory-flush boundary. Windows cannot
  // open directories through this Node API; its original guarantee is unchanged.
  if (process.platform === "win32") return
  const descriptor = openSync(path, "r")
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}
