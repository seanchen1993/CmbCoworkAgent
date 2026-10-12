import { BOT_DELETION_OUTBOX_SCHEMA } from "./deletion-ledger"
import { BOT_SKILL_MAINTENANCE_SCHEMA } from "./skill-maintenance-schema"
import { BOT_INTRODUCTION_QUESTION_SCHEMA } from "./introduction-question-schema"
import { BOT_EVENT_STATE_SCHEMA } from "./event-state-schema"

/** Bot state and its event log share one transaction boundary. */
export const BOT_SCHEMA_VERSION = 75

/** Logical version payload: UTF-8 text fields plus two signed 64-bit integers.
 * SQLite page/index overhead is additionally bounded by the version-count cap.
 */
export function botUserSkillVersionBytesSql(prefix = ""): string {
  return (
    ["skill_id", "name", "instructions"]
      .map((column) => `length(CAST(${prefix}${column} AS BLOB))`)
      .join("+") + "+16"
  )
}
export const BOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_schema(version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bot_primary(
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0),
 bot_id TEXT REFERENCES bots(id), default_bot_id TEXT REFERENCES bots(id)
);
CREATE TABLE IF NOT EXISTS bot_primary_checkin(
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>0),
 routine_id TEXT REFERENCES bot_routines(id) ON DELETE SET NULL,
 configuration TEXT NOT NULL, fingerprint TEXT, activation_fingerprint TEXT
);
CREATE TABLE IF NOT EXISTS bot_primary_routines(
 routine_id TEXT PRIMARY KEY REFERENCES bot_routines(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bot_primary_runs(
 root_run_id TEXT PRIMARY KEY REFERENCES bot_runs(id) ON DELETE CASCADE,
 primary_revision INTEGER NOT NULL, checkin_revision INTEGER NOT NULL,
 observed_fingerprint TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_introduction_cues(
 message_id TEXT PRIMARY KEY REFERENCES bot_messages(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bot_introductions(
 run_id TEXT PRIMARY KEY REFERENCES bot_runs(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL UNIQUE REFERENCES bots(id) ON DELETE CASCADE,
 cue_message_id TEXT NOT NULL UNIQUE REFERENCES bot_messages(id) ON DELETE CASCADE,
 intent TEXT NOT NULL
);
${BOT_INTRODUCTION_QUESTION_SCHEMA}

CREATE TABLE IF NOT EXISTS bot_profile_labels(
 bot_id TEXT PRIMARY KEY REFERENCES bots(id), title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_external_skill_visibility(
 skill_id TEXT PRIMARY KEY REFERENCES bot_external_skills(id) ON DELETE CASCADE,
 plugin_id TEXT, plugin_name TEXT, is_project_mode INTEGER NOT NULL CHECK(is_project_mode IN (0,1))
);
CREATE TABLE IF NOT EXISTS bot_harness_bindings(
 bot_id TEXT PRIMARY KEY REFERENCES bots(id), binding TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_harness_run_contexts(
 run_id TEXT PRIMARY KEY REFERENCES bot_runs(id), context TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_harness_skill_scopes(
 bot_id TEXT PRIMARY KEY REFERENCES bots(id), scope TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_browser_downloads(
 guid TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL REFERENCES bot_conversations(id) ON DELETE CASCADE,
 run_id TEXT REFERENCES bot_runs(id) ON DELETE CASCADE,
 thread_root_id TEXT REFERENCES bot_messages(id) ON DELETE CASCADE
);
${BOT_DELETION_OUTBOX_SCHEMA}
CREATE TABLE IF NOT EXISTS bot_plugin_pane_actions(
 run_id TEXT PRIMARY KEY REFERENCES bot_runs(id), request TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_workspace_setup(
 workspace_key TEXT PRIMARY KEY, configuration TEXT NOT NULL,
 run_id TEXT NOT NULL REFERENCES bot_runs(id), completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS bot_notification_settings(
 bot_id TEXT PRIMARY KEY REFERENCES bots(id), revision INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
CREATE TABLE IF NOT EXISTS bot_peer_dispatch(
 run_id TEXT PRIMARY KEY REFERENCES bot_runs(id),
 intent TEXT NOT NULL CHECK(intent IN ('request','reply','question','status','result','fyi')),
 priority INTEGER NOT NULL CHECK(priority IN (0,1)),
 reply_to_run_id TEXT REFERENCES bot_runs(id),
 activation_scope_run_id TEXT REFERENCES bot_runs(id),
 manual_response_sent INTEGER NOT NULL CHECK(manual_response_sent IN (0,1)),
 automatic INTEGER NOT NULL CHECK(automatic IN (0,1))
);
CREATE TABLE IF NOT EXISTS bot_peer_authority(
 run_id TEXT PRIMARY KEY REFERENCES bot_runs(id), record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_routine_authority(
 routine_id TEXT PRIMARY KEY REFERENCES bot_routines(id) ON DELETE CASCADE, record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_routine_run_authority(
 run_id TEXT PRIMARY KEY REFERENCES bot_runs(id), record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_auto_review_settings(
 bot_id TEXT PRIMARY KEY REFERENCES bots(id), revision INTEGER NOT NULL, policy TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_auto_review_decisions(
 interaction_id TEXT PRIMARY KEY REFERENCES bot_interactions(id), record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_local_tool_policy(
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_local_tool_requests(
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES bot_runs(id), invocation TEXT NOT NULL,
 interaction_id TEXT UNIQUE REFERENCES bot_interactions(id), record TEXT NOT NULL, attempt INTEGER NOT NULL,
 UNIQUE(run_id,invocation,attempt)
);
CREATE INDEX IF NOT EXISTS bot_local_tool_active_requests ON bot_local_tool_requests(run_id,id,interaction_id)
 WHERE json_extract(record,'$.status') IN ('pending','allowed');
CREATE TABLE IF NOT EXISTS bot_local_tool_effect_permits(
 approval_id TEXT PRIMARY KEY REFERENCES bot_interactions(id),
 read_id TEXT NOT NULL REFERENCES bot_local_tool_requests(id),
 mutation_id TEXT NOT NULL REFERENCES bot_local_tool_requests(id)
);
CREATE TABLE IF NOT EXISTS bot_approval_policy(
 bot_id TEXT PRIMARY KEY REFERENCES bots(id), revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_approval_rules(
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), scope TEXT NOT NULL,
 action_hash TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL,
 behavior TEXT NOT NULL CHECK(behavior IN ('allow','ask','deny')), created_at INTEGER NOT NULL,
 UNIQUE(bot_id,scope,action_hash)
);
CREATE TABLE IF NOT EXISTS bot_approval_reviews(
 interaction_id TEXT PRIMARY KEY REFERENCES bot_interactions(id), record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_shell_jobs(
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES bot_runs(id), invocation TEXT NOT NULL,
 effect_id TEXT NOT NULL UNIQUE REFERENCES bot_effects(id), command TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','cancelling','succeeded','failed','cancelled','needs_review')),
 fence INTEGER NOT NULL, revision INTEGER NOT NULL, output TEXT NOT NULL, truncated INTEGER NOT NULL,
 exit_code INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(run_id,invocation)
);
CREATE INDEX IF NOT EXISTS bot_shell_jobs_live ON bot_shell_jobs(status,run_id);
CREATE TABLE IF NOT EXISTS bot_shell_services(
 job_id TEXT PRIMARY KEY REFERENCES bot_shell_jobs(id), owner TEXT NOT NULL,
 token TEXT NOT NULL, lease_until INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_backup_schedule(
 id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_worktree_sources(
 workflow_id TEXT PRIMARY KEY REFERENCES bot_workflows(id), source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_worktrees(
 run_id TEXT PRIMARY KEY REFERENCES bot_runs(id), workflow_id TEXT NOT NULL REFERENCES bot_workflows(id),
 record TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_worktree_actions(
 nonce TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES bot_runs(id), input TEXT NOT NULL,
 result TEXT, created_at INTEGER NOT NULL
);
INSERT INTO bot_schema(version) SELECT ${BOT_SCHEMA_VERSION} WHERE NOT EXISTS(SELECT 1 FROM bot_schema);
CREATE TABLE IF NOT EXISTS bots(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL,
 model_ref TEXT, workspace_path TEXT, revision INTEGER NOT NULL DEFAULT 1,
 hidden INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS bot_conversations(
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('direct','group')),
 name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_connector_grants(
 bot_id TEXT PRIMARY KEY REFERENCES bots(id), provider_keys TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_read_states(
 conversation_id TEXT PRIMARY KEY REFERENCES bot_conversations(id),
 last_read_sequence INTEGER NOT NULL DEFAULT 0,
 manually_unread INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bot_personas(
 bot_id TEXT PRIMARY KEY REFERENCES bots(id), shape TEXT, color TEXT
);
CREATE TABLE IF NOT EXISTS bot_avatar_images(
 bot_id TEXT PRIMARY KEY REFERENCES bots(id), hash TEXT NOT NULL, png TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_pinned_order(
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, ids TEXT NOT NULL
);
INSERT OR IGNORE INTO bot_pinned_order VALUES(1,0,'[]');
CREATE TABLE IF NOT EXISTS bot_group_profiles(
 conversation_id TEXT PRIMARY KEY REFERENCES bot_conversations(id), description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_group_cycles(
 id TEXT PRIMARY KEY REFERENCES bot_messages(id), conversation_id TEXT NOT NULL REFERENCES bot_conversations(id),
 member_ids TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0, speakers TEXT NOT NULL, speaker_index INTEGER NOT NULL DEFAULT 0,
 round_messages INTEGER NOT NULL DEFAULT 0, total_messages INTEGER NOT NULL DEFAULT 0,
 current_run_id TEXT REFERENCES bot_runs(id), status TEXT NOT NULL CHECK(status IN ('active','completed','cancelled')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 thread_root TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS bot_group_active ON bot_group_cycles(conversation_id,thread_root) WHERE status='active';
CREATE TABLE IF NOT EXISTS bot_group_runs(
 run_id TEXT PRIMARY KEY REFERENCES bot_runs(id), cycle_id TEXT NOT NULL REFERENCES bot_group_cycles(id),
 sent_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bot_group_run_cycle ON bot_group_runs(cycle_id);
CREATE TABLE IF NOT EXISTS bot_members(
 conversation_id TEXT NOT NULL REFERENCES bot_conversations(id),
 bot_id TEXT NOT NULL REFERENCES bots(id),
 position INTEGER NOT NULL DEFAULT 0 CHECK(position>=0), PRIMARY KEY(conversation_id,bot_id)
);
CREATE TABLE IF NOT EXISTS bot_messages(
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 conversation_id TEXT NOT NULL REFERENCES bot_conversations(id), bot_id TEXT REFERENCES bots(id),
 sender TEXT NOT NULL CHECK(sender IN ('user','bot','system')), text TEXT NOT NULL,
 run_id TEXT, reply_to TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_messages_page ON bot_messages(conversation_id,sequence);
CREATE TABLE IF NOT EXISTS bot_message_publications(
 message_id TEXT PRIMARY KEY REFERENCES bot_messages(id) ON DELETE CASCADE,
 images TEXT NOT NULL, explicit_reply INTEGER NOT NULL CHECK(explicit_reply IN (0,1))
);
CREATE TABLE IF NOT EXISTS bot_message_reactions(
 message_id TEXT PRIMARY KEY REFERENCES bot_messages(id),
 revision INTEGER NOT NULL DEFAULT 0, reactions TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_group_cycle_history ON bot_group_cycles(conversation_id,thread_root);
CREATE TABLE IF NOT EXISTS bot_group_publications(
 message_id TEXT PRIMARY KEY REFERENCES bot_messages(id),
 source_run_id TEXT NOT NULL REFERENCES bot_runs(id),
 conversation_revision INTEGER NOT NULL, cycle_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_group_publication_run ON bot_group_publications(source_run_id);
CREATE INDEX IF NOT EXISTS bot_group_publication_cycle ON bot_group_publications(cycle_id);
CREATE INDEX IF NOT EXISTS bot_member_bot ON bot_members(bot_id,conversation_id);
CREATE TABLE IF NOT EXISTS bot_message_skills(
 message_id TEXT PRIMARY KEY REFERENCES bot_messages(id), refs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_skill_library(
 id TEXT PRIMARY KEY, source_bot_id TEXT NOT NULL, source_skill_id TEXT NOT NULL UNIQUE,
 source_version INTEGER NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL,
 revision INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_user_skills(
 skill_id TEXT PRIMARY KEY REFERENCES bot_skill_library(id), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_user_skill_versions(
 skill_id TEXT NOT NULL REFERENCES bot_user_skills(skill_id), version INTEGER NOT NULL,
 name TEXT NOT NULL, instructions TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(skill_id,version)
);
CREATE TABLE IF NOT EXISTS bot_user_skill_history_usage(
 id INTEGER PRIMARY KEY CHECK(id=1), versions INTEGER NOT NULL CHECK(versions>=0),
 payload_bytes INTEGER NOT NULL CHECK(payload_bytes>=0)
);
INSERT OR IGNORE INTO bot_user_skill_history_usage VALUES(1,0,0);
CREATE TRIGGER IF NOT EXISTS bot_user_skill_history_insert AFTER INSERT ON bot_user_skill_versions BEGIN
 UPDATE bot_user_skill_history_usage SET versions=versions+1,
 payload_bytes=payload_bytes+${botUserSkillVersionBytesSql("NEW.")} WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS bot_user_skill_history_delete AFTER DELETE ON bot_user_skill_versions BEGIN
 UPDATE bot_user_skill_history_usage SET versions=versions-1,
 payload_bytes=payload_bytes-(${botUserSkillVersionBytesSql("OLD.")}) WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS bot_user_skill_history_update AFTER UPDATE ON bot_user_skill_versions BEGIN
 UPDATE bot_user_skill_history_usage SET
 payload_bytes=payload_bytes-(${botUserSkillVersionBytesSql("OLD.")})+(${botUserSkillVersionBytesSql("NEW.")}) WHERE id=1;
END;
CREATE TABLE IF NOT EXISTS bot_skill_enablement(
 bot_id TEXT NOT NULL REFERENCES bots(id), skill_id TEXT NOT NULL REFERENCES bot_skill_library(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL CHECK(revision>0),
 PRIMARY KEY(bot_id,skill_id)
);
CREATE TABLE IF NOT EXISTS bot_external_skills(
 id TEXT PRIMARY KEY, digest TEXT NOT NULL, version INTEGER NOT NULL,
 payload TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 name TEXT NOT NULL, source_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_message_entities(
 message_id TEXT PRIMARY KEY REFERENCES bot_messages(id) ON DELETE CASCADE, refs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_message_selection_quotes(
 message_id TEXT PRIMARY KEY REFERENCES bot_messages(id) ON DELETE CASCADE, spans TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_message_inline_references(
 message_id TEXT PRIMARY KEY REFERENCES bot_messages(id) ON DELETE CASCADE, spans TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_message_recipients(
 message_id TEXT PRIMARY KEY REFERENCES bot_messages(id), refs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_threads(
 root_id TEXT PRIMARY KEY REFERENCES bot_messages(id),
 conversation_id TEXT NOT NULL REFERENCES bot_conversations(id), created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_threads_conversation ON bot_threads(conversation_id);
CREATE TABLE IF NOT EXISTS bot_message_threads(
 message_id TEXT PRIMARY KEY REFERENCES bot_messages(id), root_id TEXT NOT NULL REFERENCES bot_threads(root_id)
);
CREATE INDEX IF NOT EXISTS bot_thread_messages ON bot_message_threads(root_id,message_id);
CREATE TABLE IF NOT EXISTS bot_thread_read_states(
 root_id TEXT PRIMARY KEY REFERENCES bot_threads(root_id), last_read_sequence INTEGER NOT NULL DEFAULT 0,
 manually_unread INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bot_runs(
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id),
 conversation_id TEXT NOT NULL REFERENCES bot_conversations(id), message_id TEXT NOT NULL,
 parent_run_id TEXT REFERENCES bot_runs(id), root_run_id TEXT NOT NULL, depth INTEGER NOT NULL,
 lane TEXT NOT NULL CHECK(lane IN ('user','agent','background')), source TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_input','cancelling','succeeded','failed','cancelled','needs_review')),
 revision INTEGER NOT NULL DEFAULT 1, fence INTEGER NOT NULL DEFAULT 0,
 lease_owner TEXT, lease_until INTEGER, checkpoint TEXT, result TEXT, error TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_run_queue ON bot_runs(status,created_at);
CREATE INDEX IF NOT EXISTS bot_run_owned_children ON bot_runs(root_run_id,parent_run_id);
CREATE INDEX IF NOT EXISTS bot_primary_active_signal ON bot_runs(bot_id,created_at,id)
 WHERE status IN ('queued','running','waiting_input','cancelling','needs_review');
CREATE INDEX IF NOT EXISTS bot_primary_settled_signal ON bot_runs(bot_id,created_at DESC,id DESC)
 WHERE status IN ('succeeded','failed','cancelled');
CREATE INDEX IF NOT EXISTS bot_run_open_projection ON bot_runs(created_at,id)
 WHERE status NOT IN ('succeeded','failed','cancelled');
CREATE INDEX IF NOT EXISTS bot_work_conversation_open ON bot_runs(conversation_id,created_at,id)
 WHERE status NOT IN ('succeeded','failed','cancelled');
CREATE TABLE IF NOT EXISTS bot_run_skill_revocations(
 run_id TEXT NOT NULL REFERENCES bot_runs(id), skill_id TEXT NOT NULL,
 created_at INTEGER NOT NULL, PRIMARY KEY(run_id,skill_id)
);
CREATE TABLE IF NOT EXISTS bot_run_skills(
 run_id TEXT NOT NULL REFERENCES bot_runs(id), skill_id TEXT NOT NULL,
 version INTEGER NOT NULL, PRIMARY KEY(run_id,skill_id)
);
CREATE INDEX IF NOT EXISTS bot_routine_history ON bot_runs(bot_id,source,created_at,id);
CREATE INDEX IF NOT EXISTS bot_trial_trigger_message ON bot_runs(message_id) WHERE source='skill-trial';
CREATE INDEX IF NOT EXISTS bot_run_messages ON bot_messages(run_id,sequence);
CREATE TABLE IF NOT EXISTS bot_run_drains(
 run_id TEXT PRIMARY KEY REFERENCES bot_runs(id), reason TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_steering(
 message_id TEXT PRIMARY KEY REFERENCES bot_messages(id), run_id TEXT NOT NULL REFERENCES bot_runs(id),
 accepted_at INTEGER, followup_run_id TEXT REFERENCES bot_runs(id)
);
CREATE INDEX IF NOT EXISTS bot_steering_run ON bot_steering(run_id,message_id);
CREATE TABLE IF NOT EXISTS bot_run_outputs(
 run_id TEXT PRIMARY KEY REFERENCES bot_runs(id), text TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bot_one_active_run ON bot_runs(bot_id)
 WHERE source<>'workflow-child' AND status IN ('running','waiting_input','cancelling','needs_review');
CREATE TABLE IF NOT EXISTS bot_workflows(
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES bot_runs(id), invocation TEXT NOT NULL,
 fingerprint TEXT NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL,
 state TEXT NOT NULL, result TEXT, updated_at INTEGER NOT NULL,
 UNIQUE(run_id,invocation)
);
CREATE TABLE IF NOT EXISTS bot_background_workflows(
 workflow_id TEXT PRIMARY KEY REFERENCES bot_workflows(id), definition TEXT NOT NULL,
 receipt TEXT
);
CREATE TABLE IF NOT EXISTS bot_workflow_journal(
 workflow_id TEXT NOT NULL REFERENCES bot_workflows(id), call_index INTEGER NOT NULL,
 hash TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(workflow_id,call_index,hash)
);
CREATE TABLE IF NOT EXISTS bot_workflow_io(
 workflow_id TEXT NOT NULL REFERENCES bot_workflows(id), invocation TEXT NOT NULL,
 fingerprint TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(workflow_id,invocation)
);
CREATE TABLE IF NOT EXISTS bot_workflow_children(
 run_id TEXT PRIMARY KEY REFERENCES bot_runs(id), workflow_id TEXT NOT NULL REFERENCES bot_workflows(id),
 call_key TEXT NOT NULL, fingerprint TEXT NOT NULL, input TEXT NOT NULL,
 parent_owner TEXT NOT NULL, parent_fence INTEGER NOT NULL, workflow_generation INTEGER NOT NULL,
 result TEXT, UNIQUE(workflow_id,call_key)
);
CREATE TABLE IF NOT EXISTS bot_workflow_child_state(
 run_id TEXT PRIMARY KEY REFERENCES bot_workflow_children(run_id), structured TEXT,
 usage TEXT NOT NULL DEFAULT '{}', repairs TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS bot_workflow_limits(
 workflow_id TEXT PRIMARY KEY REFERENCES bot_workflows(id), output_limit INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_workflow_model_calls(
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES bot_runs(id),
 workflow_id TEXT REFERENCES bot_workflows(id), root_run_id TEXT NOT NULL REFERENCES bot_runs(id),
 reserved INTEGER NOT NULL, consumed INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_workflow_model_root ON bot_workflow_model_calls(root_run_id);
CREATE TABLE IF NOT EXISTS bot_model_usage(
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), run_id TEXT REFERENCES bot_runs(id),
 model_ref TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL,
 reserved INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
 cache_read_tokens INTEGER, reasoning_tokens INTEGER, created_at INTEGER NOT NULL, settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS bot_model_usage_memory ON bot_model_usage(bot_id,created_at) WHERE run_id IS NULL;
CREATE INDEX IF NOT EXISTS bot_model_usage_run ON bot_model_usage(run_id);
CREATE INDEX IF NOT EXISTS bot_model_usage_window ON bot_model_usage(created_at);
CREATE TABLE IF NOT EXISTS bot_usage_budgets(
 scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, output_limit INTEGER
);
CREATE TABLE IF NOT EXISTS bot_receipts(
 nonce TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_events(
 cursor INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
 entity_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_event_entity_kind ON bot_events(entity_id,kind,cursor);
CREATE INDEX IF NOT EXISTS bot_event_restore_cursor ON bot_events(cursor DESC)
 WHERE kind IN ('workspace.restored','computer.restored');
CREATE TABLE IF NOT EXISTS bot_interactions(
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES bot_runs(id),
 kind TEXT NOT NULL CHECK(kind IN ('question','approval')), prompt TEXT NOT NULL,
 action_hash TEXT, status TEXT NOT NULL CHECK(status IN ('pending','answered','expired','cancelled')),
 answer TEXT, revision INTEGER NOT NULL DEFAULT 1, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
 notification_stage TEXT REFERENCES bot_hook_notifications(id)
);
CREATE TABLE IF NOT EXISTS bot_hook_notifications(
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES bot_runs(id), invocation TEXT NOT NULL,
 action_hash TEXT NOT NULL, interaction_id TEXT NOT NULL REFERENCES bot_interactions(id),
 status TEXT NOT NULL CHECK(status IN ('running','waiting_input','completed','failed','interrupted')),
 fence INTEGER NOT NULL, owner TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bot_one_active_hook_notification ON bot_hook_notifications(run_id) WHERE status IN ('running','waiting_input');
CREATE UNIQUE INDEX IF NOT EXISTS bot_one_pending_interaction ON bot_interactions(run_id) WHERE status='pending' AND notification_stage IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bot_one_pending_notification_approval ON bot_interactions(notification_stage) WHERE status='pending' AND notification_stage IS NOT NULL;
CREATE INDEX IF NOT EXISTS bot_interaction_pending_projection ON bot_interactions(created_at,id)
 WHERE status='pending';
CREATE TABLE IF NOT EXISTS bot_effects(
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES bot_runs(id), fence INTEGER NOT NULL,
 action_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('started','succeeded','failed','unknown')),
 result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_effect_run ON bot_effects(run_id,created_at,id);
CREATE TABLE IF NOT EXISTS bot_effect_approvals(
 effect_id TEXT PRIMARY KEY REFERENCES bot_effects(id),
 approval_id TEXT NOT NULL REFERENCES bot_interactions(id)
);
CREATE INDEX IF NOT EXISTS bot_effect_approval ON bot_effect_approvals(approval_id);
CREATE INDEX IF NOT EXISTS bot_interaction_run ON bot_interactions(run_id,id);
CREATE TABLE IF NOT EXISTS bot_shared_memories(
 id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('user','project')),
 project_path TEXT NOT NULL, text TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL, deleted_at INTEGER,
 CHECK(scope='project' OR project_path='')
);
CREATE INDEX IF NOT EXISTS bot_shared_memory_scope ON bot_shared_memories(scope,project_path,deleted_at);
CREATE TABLE IF NOT EXISTS bot_memories(
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), text TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, source_message_id TEXT,
 deleted_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_memory_metadata(
 memory_id TEXT PRIMARY KEY REFERENCES bot_memories(id),
 origin TEXT NOT NULL CHECK(origin IN ('explicit','synthesized')),
 kind TEXT NOT NULL CHECK(kind IN ('profile','log')), evidence TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_memory_state(
 bot_id TEXT PRIMARY KEY REFERENCES bots(id), enabled INTEGER NOT NULL DEFAULT 1,
 revision INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0,
 barrier_sequence INTEGER NOT NULL DEFAULT 0, temporal_at INTEGER NOT NULL DEFAULT 0,
 last_outcome TEXT, last_attempt_at INTEGER
);
CREATE TABLE IF NOT EXISTS bot_memory_evidence(
 run_id TEXT PRIMARY KEY REFERENCES bot_runs(id), bot_id TEXT NOT NULL REFERENCES bots(id),
 user_id TEXT NOT NULL REFERENCES bot_messages(id), assistant_id TEXT NOT NULL REFERENCES bot_messages(id),
 occurred_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
 CHECK(state IN ('pending','done','skipped','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_memory_pending ON bot_memory_evidence(state,next_at,bot_id);
CREATE INDEX IF NOT EXISTS bot_memory_evidence_by_bot ON bot_memory_evidence(bot_id,state,next_at);
CREATE INDEX IF NOT EXISTS bot_memory_active_by_bot ON bot_memories(bot_id,id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS bot_memory_tombstones(
 bot_id TEXT NOT NULL REFERENCES bots(id), content_hash TEXT NOT NULL,
 PRIMARY KEY(bot_id,content_hash)
);
CREATE TABLE IF NOT EXISTS bot_skills(
 id TEXT NOT NULL, bot_id TEXT NOT NULL REFERENCES bots(id), name TEXT NOT NULL,
 instructions TEXT NOT NULL, version INTEGER NOT NULL, enabled INTEGER NOT NULL,
 verified INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(id,version)
);
CREATE TABLE IF NOT EXISTS bot_skill_tombstones(
 skill_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id),
 version INTEGER NOT NULL CHECK(version>0), deleted_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_routines(
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), name TEXT NOT NULL,
 prompt TEXT NOT NULL, schedule TEXT NOT NULL, timezone TEXT NOT NULL,
 enabled INTEGER NOT NULL, next_at INTEGER, revision INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,
 desired_enabled INTEGER NOT NULL DEFAULT 0 CHECK(desired_enabled IN (0,1)),
 activation_required INTEGER NOT NULL DEFAULT 0 CHECK(activation_required IN (0,1))
);
CREATE INDEX IF NOT EXISTS bot_routine_due ON bot_routines(enabled,next_at);
CREATE TABLE IF NOT EXISTS bot_webhooks(
 routine_id TEXT PRIMARY KEY REFERENCES bot_routines(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, enabled INTEGER NOT NULL, key_hash TEXT,
 updated_at INTEGER NOT NULL, last_accepted_at INTEGER, last_run_id TEXT REFERENCES bot_runs(id)
);
CREATE TABLE IF NOT EXISTS bot_webhook_deliveries(
 nonce TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES bot_routines(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL, run_id TEXT NOT NULL REFERENCES bot_runs(id)
);
CREATE INDEX IF NOT EXISTS bot_webhook_rate ON bot_webhook_deliveries(routine_id,created_at);
CREATE INDEX IF NOT EXISTS bot_webhook_global_rate ON bot_webhook_deliveries(created_at);
CREATE TABLE IF NOT EXISTS bot_webhook_listener(
 id INTEGER PRIMARY KEY CHECK(id=1), port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535)
);
${BOT_EVENT_STATE_SCHEMA}
CREATE TABLE IF NOT EXISTS bot_routine_skills(
 routine_id TEXT PRIMARY KEY REFERENCES bot_routines(id) ON DELETE CASCADE, refs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_context_imports(
 message_id TEXT PRIMARY KEY REFERENCES bot_messages(id), origin TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_graph_checkpoints(
 thread_id TEXT NOT NULL, ns TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT,
 type TEXT NOT NULL, data BLOB NOT NULL, metadata_type TEXT NOT NULL, metadata BLOB NOT NULL,
 PRIMARY KEY(thread_id,ns,id)
);
CREATE TABLE IF NOT EXISTS bot_graph_message_snapshots(
 thread_id TEXT NOT NULL, ns TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT,
 prefix_length INTEGER NOT NULL, message_count INTEGER NOT NULL, depth INTEGER NOT NULL,
 total_bytes INTEGER NOT NULL, delta_bytes INTEGER NOT NULL, type TEXT NOT NULL, data BLOB NOT NULL,
 PRIMARY KEY(thread_id,ns,id)
);
CREATE TABLE IF NOT EXISTS bot_graph_message_heads(
 thread_id TEXT NOT NULL, ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
 PRIMARY KEY(thread_id,ns,checkpoint_id)
);
CREATE TABLE IF NOT EXISTS bot_graph_writes(
 thread_id TEXT NOT NULL, ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL, task_id TEXT NOT NULL,
 idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT NOT NULL, data BLOB NOT NULL,
 PRIMARY KEY(thread_id,ns,checkpoint_id,task_id,idx)
);
CREATE TABLE IF NOT EXISTS bot_artifacts(
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES bot_conversations(id), run_id TEXT,
 name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_artifact_lifecycle(
 artifact_id TEXT PRIMARY KEY REFERENCES bot_artifacts(id), origin TEXT,
 deleted_at INTEGER, purged_at INTEGER
);
CREATE TABLE IF NOT EXISTS bot_message_files(
 message_id TEXT NOT NULL REFERENCES bot_messages(id), artifact_id TEXT NOT NULL REFERENCES bot_artifacts(id),
 PRIMARY KEY(message_id,artifact_id)
);
CREATE TABLE IF NOT EXISTS bot_message_peer_images(
 message_id TEXT PRIMARY KEY REFERENCES bot_messages(id) ON DELETE CASCADE, images TEXT NOT NULL, delivery TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_peer_waits(
 run_id TEXT PRIMARY KEY REFERENCES bot_runs(id), child_run_id TEXT NOT NULL REFERENCES bot_runs(id)
);
CREATE TABLE IF NOT EXISTS bot_task_browser_sessions (
  run_id TEXT PRIMARY KEY REFERENCES bot_runs(id) ON DELETE CASCADE,
  manifest TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS bot_task_browser_expiry ON bot_task_browser_sessions(expires_at,run_id)
 WHERE expires_at IS NOT NULL AND manifest<>'{"urls":[],"active":0}';
CREATE TABLE IF NOT EXISTS bot_browser_sessions(
 bot_id TEXT PRIMARY KEY REFERENCES bots(id), manifest TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_native_desktop_controls(
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 target_key TEXT NOT NULL, run_id TEXT REFERENCES bot_runs(id) ON DELETE CASCADE,
 human_held INTEGER NOT NULL CHECK(human_held=1), updated_at INTEGER NOT NULL,
 PRIMARY KEY(bot_id,target_key)
);
CREATE TABLE IF NOT EXISTS bot_teach_sessions(
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), conversation_id TEXT NOT NULL REFERENCES bot_conversations(id),
 nonce TEXT NOT NULL UNIQUE, phase TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 started_at INTEGER NOT NULL, ended_at INTEGER, frame_count INTEGER NOT NULL DEFAULT 0, event_count INTEGER NOT NULL DEFAULT 0,
 bytes INTEGER NOT NULL DEFAULT 0, error TEXT, learning_run_id TEXT, skill_id TEXT, video TEXT, attempt INTEGER NOT NULL DEFAULT 0,
 thread_root TEXT, start_request TEXT, learning_epoch TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS bot_teach_active ON bot_teach_sessions((1)) WHERE phase IN ('recording','paused','finalizing');
CREATE INDEX IF NOT EXISTS bot_teach_learning_run ON bot_teach_sessions(learning_run_id);
CREATE TABLE IF NOT EXISTS bot_teach_frames(
 session_id TEXT NOT NULL REFERENCES bot_teach_sessions(id), idx INTEGER NOT NULL, at INTEGER NOT NULL,
 sha256 TEXT NOT NULL, size INTEGER NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, PRIMARY KEY(session_id,idx)
);
CREATE TABLE IF NOT EXISTS bot_teach_events(
 session_id TEXT NOT NULL REFERENCES bot_teach_sessions(id), idx INTEGER NOT NULL, at INTEGER NOT NULL,
 kind TEXT NOT NULL, details TEXT NOT NULL, PRIMARY KEY(session_id,idx)
);
CREATE TABLE IF NOT EXISTS bot_teach_reads(
 session_id TEXT NOT NULL REFERENCES bot_teach_sessions(id), run_id TEXT NOT NULL REFERENCES bot_runs(id),
 frame_idx INTEGER NOT NULL, PRIMARY KEY(session_id,run_id,frame_idx)
);
CREATE TABLE IF NOT EXISTS bot_skill_trials(
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), skill_id TEXT NOT NULL, version INTEGER NOT NULL,
 inputs TEXT NOT NULL, criteria TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES bot_runs(id),
 verdict TEXT NOT NULL DEFAULT 'pending', note TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_teach_retry_receipts(nonce TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES bot_teach_sessions(id));
CREATE UNIQUE INDEX IF NOT EXISTS bot_trial_run ON bot_skill_trials(run_id);
CREATE INDEX IF NOT EXISTS bot_trial_verified ON bot_skill_trials(bot_id,skill_id,version) WHERE verdict='passed';
CREATE INDEX IF NOT EXISTS bot_deleted_event_identity ON bot_events(kind,entity_id) WHERE kind IN ('routine.deleted','skill.withdrawn');
INSERT OR IGNORE INTO bot_primary VALUES(1,0,NULL,NULL);

CREATE TABLE IF NOT EXISTS bot_output_messages(
 message_id TEXT PRIMARY KEY REFERENCES bot_messages(id), source_hash TEXT NOT NULL, contract TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_output_contracts(
 run_id TEXT PRIMARY KEY REFERENCES bot_runs(id), revision INTEGER NOT NULL,
 source_key TEXT NOT NULL, contract TEXT NOT NULL, stop_reason TEXT
);
CREATE TABLE IF NOT EXISTS bot_output_attempts(
 run_id TEXT NOT NULL REFERENCES bot_runs(id), revision INTEGER NOT NULL,
 call_id TEXT NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL, artifact_id TEXT NOT NULL, errors TEXT,
 PRIMARY KEY(run_id,call_id)
);
CREATE INDEX IF NOT EXISTS bot_output_attempt_revision ON bot_output_attempts(run_id,revision);
CREATE INDEX IF NOT EXISTS bot_output_attempt_artifact ON bot_output_attempts(run_id,artifact_id,revision);
CREATE TABLE IF NOT EXISTS bot_output_deliveries(
 run_id TEXT NOT NULL REFERENCES bot_runs(id), revision INTEGER NOT NULL,
 name TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES bot_artifacts(id), sha256 TEXT NOT NULL,
 PRIMARY KEY(run_id,revision,name)
);
${BOT_SKILL_MAINTENANCE_SCHEMA}
`
