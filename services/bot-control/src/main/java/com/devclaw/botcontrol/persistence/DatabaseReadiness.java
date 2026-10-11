package com.devclaw.botcontrol.persistence;

import java.sql.*;
import java.util.*;
import javax.sql.DataSource;

public final class DatabaseReadiness {
    public static final List<String> TABLES = Collections.unmodifiableList(Arrays.asList("bots", "bot_versions", "bot_maintainers", "groups", "group_members", "group_bots", "command_scope", "command_receipts", "mutation_outbox", "tasks", "task_messages", "task_space_head", "task_event_cursors", "desktop_runtime_nodes", "group_runtime_grants", "requirement_run_queue", "bot_schema_history"));
    private DatabaseReadiness() {}
    public static void requireConnection(DataSource source) {
        try (Connection c = source.getConnection()) { requireConnection(c); }
        catch (SQLException e) { throw DatabaseFailure.sql(e); }
    }
    public static void requireConnection(Connection c) throws SQLException {
        if (!System.getProperty("java.version").startsWith("1.8.") || !"8.0.33".equals(com.mysql.cj.jdbc.Driver.class.getPackage().getImplementationVersion()) ||
            !"5.7.44".equals(c.getMetaData().getDatabaseProductVersion()) || !c.getMetaData().getDriverVersion().contains("8.0.33") ||
            c.getTransactionIsolation() != Connection.TRANSACTION_READ_COMMITTED) throw new DatabaseFailure(DatabaseFailure.Category.DB_CONFIGURATION);
        try (Statement s = c.createStatement()) {
            s.setQueryTimeout(3);
            try (ResultSet r = s.executeQuery("SELECT DATABASE(),CURRENT_USER(),@@session.time_zone,@@character_set_connection,@@character_set_database,@@tx_isolation,@@innodb_lock_wait_timeout")) {
                if (!r.next() || !"devclaw".equals(r.getString(1)) || !"devclaw_app@%".equals(r.getString(2)) || !"+00:00".equals(r.getString(3)) ||
                    !"utf8mb4".equals(r.getString(4)) || !"utf8mb4".equals(r.getString(5)) || !"READ-COMMITTED".equals(r.getString(6)) || r.getInt(7) != 2) throw new DatabaseFailure(DatabaseFailure.Category.DB_CONFIGURATION);
            }
            boolean all = false, usage = false;
            try (ResultSet r = s.executeQuery("SHOW GRANTS FOR CURRENT_USER()")) {
                while (r.next()) {
                    String grant = r.getString(1); int on = grant.indexOf(" ON "), to = grant.indexOf(" TO ");
                    if (!grant.startsWith("GRANT ") || on < 6 || to < on || grant.contains("GRANT OPTION")) throw new DatabaseFailure(DatabaseFailure.Category.DB_CONFIGURATION);
                    String scope = grant.substring(on + 4, to), privileges = grant.substring(6, on);
                    if ("*.*".equals(scope) && "USAGE".equals(privileges) && !usage) usage = true;
                    else if ("`devclaw`.*".equals(scope) && "ALL PRIVILEGES".equals(privileges) && !all) all = true;
                    else throw new DatabaseFailure(DatabaseFailure.Category.DB_CONFIGURATION);
                }
            }
            if (!usage || !all) throw new DatabaseFailure(DatabaseFailure.Category.DB_CONFIGURATION);
        }
    }
    public static void requireReady(DataSource source) {
        requireConnection(source);
        try (Connection c = source.getConnection(); Statement s = c.createStatement()) {
            s.setQueryTimeout(3); Set<String> found = new HashSet<String>();
            try (ResultSet r = s.executeQuery("SELECT table_name,engine,table_collation FROM information_schema.tables WHERE table_schema='devclaw'")) {
                while (r.next()) {
                    if (!TABLES.contains(r.getString(1)) || !"InnoDB".equals(r.getString(2)) || !"utf8mb4_unicode_ci".equals(r.getString(3))) throw new DatabaseFailure(DatabaseFailure.Category.MIGRATION_INVALID);
                    found.add(r.getString(1));
                }
            }
            if (!found.equals(new HashSet<String>(TABLES))) throw new DatabaseFailure(DatabaseFailure.Category.MIGRATION_INVALID);
            try (ResultSet r = s.executeQuery("SELECT COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema='devclaw'")) {
                if (!r.next() || r.getInt(1) != 0) throw new DatabaseFailure(DatabaseFailure.Category.MIGRATION_INVALID);
            }
        } catch (SQLException e) { throw DatabaseFailure.sql(e); }
        new MigrationRunner(source).requireCurrent();
    }
}
