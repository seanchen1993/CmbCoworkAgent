package com.devclaw.botcontrol.persistence;

import com.devclaw.botcontrol.contracts.BotContracts;
import com.devclaw.botcontrol.validation.ContractBoundary;
import com.zaxxer.hikari.HikariDataSource;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;

/** Actual-JDBC test main, not a production API or business implementation. */
public final class DatabaseIntegrationProbe {
    private static final Calendar UTC = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
    private static final String BOT = "Bot.A:-", GROUP = "Group.A:-";
    private static final String[] NAMES = {"中文🚀", "x\u0000y", "\ud800", "\udc00", String.join("", Collections.nCopies(256, "🚀"))};
    private static final String CONFIG = "{ \"description\":\"\\ud800\",\"instructions\":\"x\\u0000y\",\"knowledgeRefs\":[],\"repositoryRefs\":[],\"skillAllowlist\":[],\"capabilityCeiling\":[],\"memoryPolicy\":\"explicit_only\",\"persona\":\"\\udc00\" }";
    private static String phase = "configuration";
    private static int historyVerified;
    private static long queryTimeoutMillis;
    private static void check(boolean value) { if (!value) throw new IllegalStateException(); }
    private static int execute(Connection c, String sql, Object... values) throws SQLException {
        try (PreparedStatement s = c.prepareStatement(sql)) {
            s.setQueryTimeout(3);
            for (int i = 0; i < values.length; i++) {
                Object v = values[i];
                if (v instanceof byte[]) s.setBytes(i + 1, (byte[])v);
                else if (v instanceof Timestamp) s.setTimestamp(i + 1, (Timestamp)v, UTC);
                else s.setObject(i + 1, v);
            }
            return s.executeUpdate();
        }
    }
    private static long scalar(Connection c, String sql) throws SQLException {
        try (Statement s = c.createStatement()) { s.setQueryTimeout(3); try (ResultSet r = s.executeQuery(sql)) { check(r.next()); return r.getLong(1); } }
    }
    private static void catalog(Connection c) throws SQLException {
        String[][] expected = {
            {"bots","space_id,id,version,name_json,status,current_bot_version_id,created_at,updated_at"},
            {"bot_versions","space_id,id,bot_id,number,config_bytes,created_at"},
            {"bot_maintainers","space_id,bot_id,principal_id,ordinal"},
            {"groups","space_id,id,version,name_json,limits_bytes,created_at,updated_at"},
            {"group_members","space_id,group_id,principal_id,role,ordinal"},
            {"group_bots","space_id,group_id,bot_id,bot_version_id,role,ordinal"},
            {"command_scope","space_id,principal_id"},
            {"command_receipts","space_id,principal_id,command_id,operation,target_type,target_id,fingerprint,http_status,body_bytes,created_at,expires_at"},
            {"mutation_outbox","space_id,id,principal_id,command_id,operation,target_type,target_id,target_version,created_at,task_seq,task_group_id,event_bytes"},
            {"task_space_head","space_id,event_seq,task_number"},
            {"tasks","space_id,id,group_id,version,task_number,body_bytes"},
            {"task_messages","space_id,id,task_id,author_principal_id,task_version,target_bot_id,body_bytes"},
            {"task_event_cursors","space_id,id,high_water,created_at,expires_at"},
            {"desktop_runtime_nodes","space_id,id,owner_principal_id,version,supports_requirement,capabilities_bytes,last_seen_at,created_at,updated_at"},
            {"group_runtime_grants","space_id,group_id,id,node_id,owner_principal_id,version,workspace_ref,enabled,expires_at,created_at,updated_at"},
            {"requirement_run_queue","space_id,id,requester_principal_id,command_id,fingerprint,group_id,task_id,stage_id,bot_id,bot_version_id,node_id,owner_principal_id,grant_id,workspace_ref,task_version,group_version,node_version,grant_version,version,initial_status,status,deadline,created_at,updated_at,attempt_id,lease_id,fence,lease_expires_at,memory_scope"},
            {"requirement_run_results","space_id,run_id,attempt_id,outcome,result_text,settled_at"},
            {"group_memory_revisions","space_id,group_id,revision"},
            {"group_memories","space_id,group_id,id,version,memory_text,status,source_json,created_by,updated_by,created_at,updated_at"},
            {"group_memory_commands","space_id,principal_id,command_id,group_id,fingerprint,receipt_json"},
            {"requirement_run_memory_snapshots","space_id,run_id,attempt_id,snapshot_json"},
            {"bot_memory_revisions","space_id,bot_id,revision"},
            {"bot_memories","space_id,bot_id,id,version,memory_text,status,source_json,created_by,updated_by,created_at,updated_at"},
            {"bot_memory_commands","space_id,principal_id,command_id,bot_id,fingerprint,receipt_json"},
            {"group_expert_memory_modes","space_id,group_id,bot_id"},
            {"bot_schema_history","installed_rank,version,description,type,script,checksum,installed_by,installed_on,execution_time,success"}
        };
        for (String[] table : expected) {
            List<String> columns = new ArrayList<String>();
            try (PreparedStatement s = c.prepareStatement("SELECT column_name,data_type,is_nullable,character_set_name,collation_name,character_maximum_length,datetime_precision FROM information_schema.columns WHERE table_schema='devclaw' AND table_name=? ORDER BY ordinal_position")) {
                s.setQueryTimeout(3); s.setString(1, table[0]);
                try (ResultSet r = s.executeQuery()) {
                    while (r.next()) {
                        String name = r.getString(1), type = r.getString(2); columns.add(name);
                        if (table[0].equals("bot_schema_history")) continue;
                        boolean nullable = table[0].equals("mutation_outbox") && Arrays.asList("task_seq", "task_group_id", "event_bytes").contains(name) || table[0].equals("task_messages") && name.equals("target_bot_id") || table[0].equals("requirement_run_queue") && Arrays.asList("attempt_id", "lease_id", "fence", "lease_expires_at").contains(name);
                        check((nullable ? "YES" : "NO").equals(r.getString(3)));
                        if (name.endsWith("_id") || name.equals("id")) { check("varchar".equals(type) && "ascii".equals(r.getString(4)) && "ascii_bin".equals(r.getString(5)) && r.getLong(6) == 128); }
                        else if (name.endsWith("_at") || name.equals("deadline")) check("datetime".equals(type) && r.getInt(7) == 3);
                        else if (name.endsWith("_bytes")) check("mediumblob".equals(type) && r.getLong(6) >= 1048576);
                        else if (name.equals("name_json")) check("varchar".equals(type) && r.getLong(6) == 3074 && "ascii_bin".equals(r.getString(5)));
                        else if (name.equals("version") || name.equals("revision") || name.equals("number") || name.endsWith("_version") || name.equals("event_seq") || name.equals("task_seq") || name.equals("high_water") || table[0].equals("task_space_head") && name.equals("task_number")) check("bigint".equals(type));
                        else if (name.equals("ordinal")) check("int".equals(type));
                        else if (name.equals("fence")) check("bigint".equals(type));
                        else if (name.equals("fingerprint")) check("binary".equals(type) && r.getLong(6) == 32);
                        else if (name.equals("http_status")) check("smallint".equals(type));
                        else if (name.equals("supports_requirement") || name.equals("enabled")) check("tinyint".equals(type));
                        else if (name.equals("result_text")) check("mediumtext".equals(type) && "utf8mb4".equals(r.getString(4)) && "utf8mb4_unicode_ci".equals(r.getString(5)));
                        else if (name.equals("memory_text") || name.equals("source_json")) check("text".equals(type) && "utf8mb4".equals(r.getString(4)) && "utf8mb4_unicode_ci".equals(r.getString(5)));
                        else if (name.equals("receipt_json") || name.equals("snapshot_json")) check("mediumtext".equals(type) && "utf8mb4".equals(r.getString(4)) && "utf8mb4_unicode_ci".equals(r.getString(5)));
                        else if (name.equals("created_by") || name.equals("updated_by")) check("varchar".equals(type) && "ascii".equals(r.getString(4)) && "ascii_bin".equals(r.getString(5)) && r.getLong(6)==128);
                        else check("varchar".equals(type) && "ascii_bin".equals(r.getString(5)));
                    }
                }
            }
            check(String.join(",", columns).equals(table[1]));
        }
        Map<String,String> indexes = new TreeMap<String,String>();
        try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT table_name,index_name,non_unique,column_name FROM information_schema.statistics WHERE table_schema='devclaw' AND table_name<>'bot_schema_history' ORDER BY table_name,index_name,seq_in_index")) {
            while (r.next()) {
                String key = r.getString(1) + "." + r.getString(2), value = indexes.get(key);
                indexes.put(key, value == null ? r.getInt(3) + ":" + r.getString(4) : value + "," + r.getString(4));
            }
        }
        String[] declarations = {
            "bots.PRIMARY=0:space_id,id", "bots.ix_bot_current_version=1:space_id,id,current_bot_version_id",
            "bot_versions.PRIMARY=0:space_id,id", "bot_versions.uq_bot_version_number=0:space_id,bot_id,number", "bot_versions.ix_bot_version_owner=1:space_id,bot_id,id",
            "bot_maintainers.PRIMARY=0:space_id,bot_id,principal_id", "bot_maintainers.uq_maintainer_ordinal=0:space_id,bot_id,ordinal", "bot_maintainers.ix_maintainer_principal=1:space_id,principal_id,bot_id",
            "groups.PRIMARY=0:space_id,id", "group_members.PRIMARY=0:space_id,group_id,principal_id", "group_members.uq_member_ordinal=0:space_id,group_id,ordinal", "group_members.ix_member_principal=1:space_id,principal_id,group_id",
            "group_bots.PRIMARY=0:space_id,group_id,bot_id", "group_bots.uq_group_bot_ordinal=0:space_id,group_id,ordinal", "group_bots.ix_group_bot_version=1:space_id,bot_id,bot_version_id,group_id",
            "command_scope.PRIMARY=0:space_id,principal_id", "command_receipts.PRIMARY=0:space_id,principal_id,command_id", "command_receipts.ix_receipt_target=1:space_id,target_type,target_id", "command_receipts.ix_receipt_expiry=1:space_id,expires_at",
            "mutation_outbox.PRIMARY=0:space_id,id", "mutation_outbox.uq_outbox_command=0:space_id,principal_id,command_id", "mutation_outbox.ix_outbox_target=1:space_id,target_type,target_id,target_version", "mutation_outbox.uq_outbox_task_seq=0:space_id,task_seq",
            "task_space_head.PRIMARY=0:space_id", "tasks.PRIMARY=0:space_id,id", "tasks.uq_task_number=0:space_id,task_number", "tasks.ix_task_group=1:space_id,group_id,id",
            "task_messages.PRIMARY=0:space_id,id", "task_messages.uq_task_message_version=0:space_id,task_id,task_version",
            "task_event_cursors.PRIMARY=0:space_id,id", "task_event_cursors.ix_task_cursor_expiry=1:space_id,expires_at",
            "desktop_runtime_nodes.PRIMARY=0:space_id,id", "group_runtime_grants.PRIMARY=0:space_id,group_id", "group_runtime_grants.uq_group_runtime_grant_id=0:space_id,id",
            "requirement_run_queue.PRIMARY=0:space_id,id", "requirement_run_queue.uq_requirement_enqueue=0:space_id,requester_principal_id,command_id", "requirement_run_queue.ix_requirement_group_status=1:space_id,group_id,status", "requirement_run_queue.ix_requirement_node_status=1:space_id,node_id,status",
            "requirement_run_results.PRIMARY=0:space_id,run_id", "requirement_run_results.uq_requirement_result_attempt=0:space_id,attempt_id",
            "group_memory_revisions.PRIMARY=0:space_id,group_id", "group_memories.PRIMARY=0:space_id,group_id,id", "group_memory_commands.PRIMARY=0:space_id,principal_id,command_id",
            "requirement_run_memory_snapshots.PRIMARY=0:space_id,run_id", "requirement_run_memory_snapshots.uq_memory_snapshot_attempt=0:space_id,attempt_id",
            "bot_memory_revisions.PRIMARY=0:space_id,bot_id", "bot_memories.PRIMARY=0:space_id,bot_id,id", "bot_memory_commands.PRIMARY=0:space_id,principal_id,command_id", "group_expert_memory_modes.PRIMARY=0:space_id,group_id"
        };
        Map<String,String> wanted = new TreeMap<String,String>();
        for (String value : declarations) { int split = value.indexOf('='); wanted.put(value.substring(0, split), value.substring(split + 1)); }
        check(wanted.equals(indexes));
        check(scalar(c, "SELECT COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema='devclaw'") == 0);
        check(scalar(c, "SELECT COUNT(*) FROM bot_schema_history WHERE version='1' AND success=1 AND checksum IS NOT NULL") == 1);
        check(scalar(c, "SELECT COUNT(*) FROM bot_schema_history WHERE version='2' AND success=1 AND checksum IS NOT NULL") == 1);
        check(scalar(c, "SELECT COUNT(*) FROM bot_schema_history WHERE version='3' AND success=1 AND checksum IS NOT NULL") == 1);
        check(scalar(c, "SELECT COUNT(*) FROM bot_schema_history WHERE version='4' AND success=1 AND checksum IS NOT NULL") == 1);
        check(scalar(c, "SELECT COUNT(*) FROM bot_schema_history WHERE version='5' AND success=1 AND checksum IS NOT NULL") == 1);
        check(scalar(c, "SELECT COUNT(*) FROM bot_schema_history WHERE version='6' AND success=1 AND checksum IS NOT NULL") == 1);
        check(scalar(c, "SELECT COUNT(*) FROM bot_schema_history WHERE version='7' AND success=1 AND checksum IS NOT NULL") == 1);
    }
    private static byte[] padded(String value, int size) {
        byte[] result = new byte[size], original = value.getBytes(StandardCharsets.UTF_8);
        check(original.length <= size); Arrays.fill(result, (byte)' '); System.arraycopy(original, 0, result, 0, original.length); return result;
    }
    private static String response(String name) {
        return "{\"bot\":{\"id\":\"" + BOT + "\",\"spaceId\":\"Space.A:-\",\"version\":1,\"createdAt\":\"2026-10-01T12:00:00.123Z\",\"updatedAt\":\"2026-10-01T12:00:00.123Z\",\"name\":" + StorageCodec.encodeName(name) + ",\"status\":\"active\",\"currentBotVersionId\":\"V.1\",\"maintainerIds\":[\"pZ\",\"pA\",\"pM\"]},\"botVersion\":{\"id\":\"V.1\",\"botId\":\"" + BOT + "\",\"spaceId\":\"Space.A:-\",\"number\":1,\"config\":" + CONFIG + ",\"createdAt\":\"2026-10-01T12:00:00.123Z\"}}";
    }
    private static void store(HikariDataSource source) throws Exception {
        ContractBoundary boundary = new ContractBoundary();
        byte[] config = padded(CONFIG, 1048000), body = padded(response(NAMES[0]), 1048576);
        // Actual frozen public request/response validation, including escaped text.
        String request = "{\"commandId\":\"c1\",\"name\":\"n\",\"maintainerIds\":[\"pZ\"],\"config\":" + new String(config, StandardCharsets.UTF_8) + "}";
        boundary.readRequest("createBot", request.getBytes(StandardCharsets.UTF_8), BotContracts.CreateBotRequest.class);
        boundary.readResponse("getBot", 200, body, BotContracts.BotResult.class);
        for (String name : NAMES) check(boundary.readResponse("getBot", 200, response(name).getBytes(StandardCharsets.UTF_8), BotContracts.BotResult.class).bot.name.equals(name));
        Timestamp timestamp = Timestamp.valueOf("2026-10-01 12:00:00.123");
        try (Connection c = source.getConnection()) {
            catalog(c); c.setAutoCommit(false);
            for (int i = 0; i < NAMES.length; i++) {
                execute(c, "INSERT INTO bots(space_id,id,version,name_json,status,current_bot_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", "Space.A:-", i == 0 ? BOT : "B" + i, 9007199254740991L, StorageCodec.encodeName(NAMES[i]), "active", "V.1", timestamp, timestamp);
                execute(c, "INSERT INTO groups(space_id,id,version,name_json,limits_bytes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", "Space.A:-", i == 0 ? GROUP : "G" + i, 1L, StorageCodec.encodeName(NAMES[i]), "{\"maxHandoffs\":1,\"maxRuns\":1,\"maxTokens\":1}".getBytes(StandardCharsets.UTF_8), timestamp, timestamp);
            }
            execute(c, "INSERT INTO bot_versions(space_id,id,bot_id,number,config_bytes,created_at) VALUES(?,?,?,?,?,?)", "Space.A:-", "V.1", BOT, 9007199254740991L, StorageCodec.boundedBody(config), timestamp);
            execute(c, "INSERT INTO bot_versions(space_id,id,bot_id,number,config_bytes,created_at) VALUES(?,?,?,?,?,?)", "Space.A:-", "V.2", BOT, 1L, CONFIG.getBytes(StandardCharsets.UTF_8), timestamp);
            for (int i = 0; i < 3; i++) {
                String principal = new String[]{"pZ", "pA", "pM"}[i];
                execute(c, "INSERT INTO bot_maintainers(space_id,bot_id,principal_id,ordinal) VALUES(?,?,?,?)", "Space.A:-", BOT, principal, i);
                execute(c, "INSERT INTO group_members(space_id,group_id,principal_id,role,ordinal) VALUES(?,?,?,?,?)", "Space.A:-", GROUP, principal, i == 0 ? "admin" : "participant", i);
            }
            for (int i = 0; i < 2; i++) execute(c, "INSERT INTO group_bots(space_id,group_id,bot_id,bot_version_id,role,ordinal) VALUES(?,?,?,?,?,?)", "Space.A:-", GROUP, i == 0 ? BOT : "B1", "V.1", "specialist", i);
            execute(c, "INSERT INTO command_scope(space_id,principal_id) VALUES(?,?)", "Space.A:-", "pZ");
            execute(c, "INSERT INTO command_receipts(space_id,principal_id,command_id,operation,target_type,target_id,fingerprint,http_status,body_bytes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 7 DAY))", "Space.A:-", "pZ", "c1", "createBot", "bot", BOT, new byte[32], 201, StorageCodec.boundedBody(body));
            execute(c, "INSERT INTO mutation_outbox(space_id,id,principal_id,command_id,operation,target_type,target_id,target_version,created_at) VALUES(?,?,?,?,?,?,?,?,?)", "Space.A:-", "o1", "pZ", "c1", "createBot", "bot", BOT, 1L, timestamp);
            String maxId = "I.:-" + String.join("", Collections.nCopies(124, "x")); check(maxId.length() == 128);
            execute(c, "INSERT INTO command_scope(space_id,principal_id) VALUES(?,?)", "Space.B:-", maxId);
            c.commit();
            boolean unique = false;
            try { execute(c, "INSERT INTO bot_maintainers(space_id,bot_id,principal_id,ordinal) VALUES(?,?,?,?)", "Space.A:-", BOT, "different", 0); }
            catch (SQLException e) { unique = e.getErrorCode() == 1062; }
            c.rollback(); check(unique);
        }
        // Close actual pool connections; second pool proves bytes/order survive re-open.
    }
    private static void reload(HikariDataSource source) throws Exception {
        byte[] config = padded(CONFIG, 1048000), body = padded(response(NAMES[0]), 1048576);
        try (Connection c = source.getConnection()) {
            catalog(c);
            for (String table : Arrays.asList("bots", "groups")) {
                try (PreparedStatement s = c.prepareStatement("SELECT name_json,created_at FROM " + table + " WHERE space_id=? AND id=?")) {
                    s.setQueryTimeout(3);
                    for (int i = 0; i < NAMES.length; i++) {
                        s.setString(1, "Space.A:-"); s.setString(2, i == 0 ? (table.equals("bots") ? BOT : GROUP) : (table.equals("bots") ? "B" : "G") + i);
                        try (ResultSet r = s.executeQuery()) { check(r.next()); check(StorageCodec.decodeName(r.getString(1)).equals(NAMES[i])); check(r.getTimestamp(2, UTC).equals(Timestamp.valueOf("2026-10-01 12:00:00.123"))); }
                    }
                }
            }
            check(scalar(c, "SELECT COUNT(*) FROM bots WHERE space_id='space.a:-' OR id='bot.a:-'") == 0);
            check(scalar(c, "SELECT version FROM bots WHERE space_id='Space.A:-' AND id='Bot.A:-'") == 9007199254740991L);
            for (String table : Arrays.asList("bot_maintainers", "group_members", "group_bots")) {
                String target = table.equals("bot_maintainers") ? "bot_id" : "group_id", item = table.equals("group_bots") ? "bot_id" : "principal_id";
                List<String> ids = new ArrayList<String>();
                try (PreparedStatement s = c.prepareStatement("SELECT " + item + " FROM " + table + " WHERE space_id=? AND " + target + "=? ORDER BY ordinal")) {
                    s.setQueryTimeout(3); s.setString(1, "Space.A:-"); s.setString(2, table.equals("bot_maintainers") ? BOT : GROUP);
                    try (ResultSet r = s.executeQuery()) { while (r.next()) ids.add(r.getString(1)); }
                }
                check(ids.equals(table.equals("group_bots") ? Arrays.asList(BOT, "B1") : Arrays.asList("pZ", "pA", "pM")));
            }
            try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT config_bytes FROM bot_versions WHERE space_id='Space.A:-' AND id='V.1'")) { check(r.next() && Arrays.equals(config, r.getBytes(1))); }
            try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT body_bytes,http_status,TIMESTAMPDIFF(SECOND,created_at,expires_at) FROM command_receipts WHERE space_id='Space.A:-' AND principal_id='pZ' AND command_id='c1'")) { check(r.next() && Arrays.equals(body, r.getBytes(1)) && r.getInt(2) == 201 && r.getLong(3) == 604800); }
            check(scalar(c, "SELECT COUNT(*) FROM group_bots WHERE space_id='Space.A:-' AND bot_version_id='V.1'") == 2);
            for (String sql : Arrays.asList("SELECT User FROM mysql.user", "CREATE DATABASE b1_forbidden", "CREATE USER 'b1_forbidden'@'localhost'")) {
                boolean denied = false; try (Statement s = c.createStatement()) { s.execute(sql); }
                catch (SQLException e) { denied = Arrays.asList(1044, 1142, 1227).contains(e.getErrorCode()); }
                check(denied);
            }
            // Real query timeout; no fake timeout flag or skipped SQL.
            boolean timedOut = false; long started = System.nanoTime();
            try (Statement s = c.createStatement()) { s.setQueryTimeout(1); s.executeQuery("SELECT SLEEP(5)"); }
            catch (SQLTimeoutException e) { timedOut = true; }
            long elapsed = (System.nanoTime() - started) / 1000000;
            check(timedOut && elapsed >= 750 && elapsed < 4000);
            queryTimeoutMillis = elapsed;
        }
    }
    private static List<List<String>> historyFacts(Connection c) throws SQLException {
        List<List<String>> rows = new ArrayList<List<String>>();
        try (Statement s = c.createStatement()) {
            s.setQueryTimeout(3);
            try (ResultSet r = s.executeQuery("SELECT installed_rank,version,description,type,script,checksum,installed_by,installed_on,execution_time,success FROM bot_schema_history ORDER BY installed_rank")) {
                while (r.next()) {
                    List<String> row = new ArrayList<String>();
                    for (int column = 1; column <= 10; column++) row.add(r.getString(column));
                    rows.add(row);
                }
            }
        }
        return rows;
    }
    private static void historyFailures(HikariDataSource source) throws Exception {
        // Disposable, owner-checked test DB ONLY. Commit each fixed fixture;
        // the real production runner must reject without modifying ANY fact.
        // Known fixture tear-down is explicit test code, never runtime repair.
        String[] edits = {"UPDATE bot_schema_history SET version='0' WHERE installed_rank=1", "UPDATE bot_schema_history SET version='999' WHERE installed_rank=1", "UPDATE bot_schema_history SET checksum=checksum+1 WHERE installed_rank=1", "UPDATE bot_schema_history SET success=0 WHERE installed_rank=1", "DELETE FROM bot_schema_history WHERE installed_rank=1"};
        for (int index = 0; index < edits.length; index++) try (Connection c = source.getConnection()) {
            DatabaseReadiness.requireReady(source);
            List<List<String>> original = historyFacts(c);
            check(original.size() == 8);
            List<String> row = original.get(0);
            check("1".equals(row.get(0)) && "1".equals(row.get(1)) && "SQL".equals(row.get(3)) && MigrationRunner.SCRIPT.equals(row.get(4)) && row.get(5) != null && "1".equals(row.get(9)));
            List<List<String>> expected = new ArrayList<List<String>>();
            if (index != 4) {
                List<String> changed = new ArrayList<String>(row);
                if (index == 0 || index == 1) changed.set(1, index == 0 ? "0" : "999");
                else if (index == 2) changed.set(5, Integer.toString(Math.addExact(Integer.parseInt(row.get(5)), 1)));
                else changed.set(9, "0");
                expected.add(changed);
            }
            // The fixed fixture changes only V1. V2..V8 must remain byte-for-byte
            // represented in both the rejected history and explicit restore.
            expected.add(original.get(1));
            expected.add(original.get(2));
            expected.add(original.get(3));
            expected.add(original.get(4));
            expected.add(original.get(5));
            expected.add(original.get(6));
            expected.add(original.get(7));
            c.setAutoCommit(false); check(execute(c, edits[index]) == 1); c.commit();
            List<List<String>> mutated = historyFacts(c);
            check(expected.equals(mutated));
            boolean rejected = false;
            try { new MigrationRunner(source).requireCurrent(); }
            catch (DatabaseFailure e) { rejected = e.category() == DatabaseFailure.Category.MIGRATION_INVALID; }
            // Stop on unexpected facts; NEVER restore unknown runtime changes.
            check(mutated.equals(historyFacts(c)));
            Object[] values = { Integer.valueOf(row.get(0)), row.get(1), row.get(2), row.get(3), row.get(4), Integer.valueOf(row.get(5)), row.get(6), Timestamp.valueOf(row.get(7)), Integer.valueOf(row.get(8)), Integer.valueOf(row.get(9)) };
            int restored = index == 4
                ? execute(c, "INSERT INTO bot_schema_history(installed_rank,version,description,type,script,checksum,installed_by,installed_on,execution_time,success) VALUES(?,?,?,?,?,?,?,?,?,?)", values)
                : execute(c, "UPDATE bot_schema_history SET installed_rank=?,version=?,description=?,type=?,script=?,checksum=?,installed_by=?,installed_on=?,execution_time=?,success=? WHERE installed_rank=1", values);
            check(restored == 1); c.commit();
            check(original.equals(historyFacts(c)));
            DatabaseReadiness.requireReady(source);
            check(rejected); // restored readiness cannot turn a failed rejection into pass
            historyVerified++;
        }
        DatabaseReadiness.requireReady(source);
    }
    public static void main(String[] args) {
        try {
            check(args.length == 1 && Arrays.asList("store", "reload", "history", "offline").contains(args[0]));
            LocalDatabaseConfig config = LocalDatabaseConfig.fromTrustedLauncher(System.in);
            if (args[0].equals("offline")) {
                System.out.println("{\"stage\":\"armed\"}"); System.out.flush(); Thread.sleep(5000);
                boolean rejected = false;
                try (HikariDataSource source = config.openPool()) { DatabaseReadiness.requireConnection(source); }
                catch (DatabaseFailure e) { rejected = Arrays.asList(DatabaseFailure.Category.DB_UNAVAILABLE, DatabaseFailure.Category.DB_TIMEOUT).contains(e.category()); }
                check(rejected); System.out.println("{\"status\":\"verified\",\"case\":\"offline\"}"); return;
            }
            try (HikariDataSource source = config.openPool()) {
                phase = args[0]; DatabaseReadiness.requireReady(source);
                if (args[0].equals("store")) store(source);
                else if (args[0].equals("reload")) reload(source);
                else historyFailures(source);
                check(new MigrationRunner(source).migrate() == 0);
            }
            System.out.println("{\"status\":\"verified\",\"case\":\"" + args[0] + "\"" + (args[0].equals("history") ? ",\"historyCases\":" + historyVerified : args[0].equals("reload") ? ",\"queryTimeoutMillis\":" + queryTimeoutMillis : "") + "}");
        } catch (Throwable e) {
            System.out.println("{\"status\":\"failed\",\"phase\":\"" + phase + "\",\"category\":\"" + (e instanceof DatabaseFailure ? ((DatabaseFailure)e).category().name() : "PROBE_ASSERTION") + "\"" + (e instanceof SQLException ? ",\"errno\":" + ((SQLException)e).getErrorCode() : "") + "}"); System.exit(1);
        }
    }
}
