package com.devclaw.botcontrol.persistence;

import com.zaxxer.hikari.HikariDataSource;

/** Development-only command invoked by owner-checked Node launcher; no server. */
public final class DatabaseCommand {
    public static void main(String[] args) {
        try {
            if (args.length != 1 || !("migrate".equals(args[0]) || "readiness".equals(args[0]))) throw new DatabaseFailure(DatabaseFailure.Category.CONFIG_INVALID);
            LocalDatabaseConfig config = LocalDatabaseConfig.fromTrustedLauncher(System.in);
            try (HikariDataSource source = config.openPool()) {
                DatabaseReadiness.requireConnection(source);
                int migrated = "migrate".equals(args[0]) ? new MigrationRunner(source).migrate() : 0;
                DatabaseReadiness.requireReady(source);
                System.out.println("{\"status\":\"verified\",\"migrations\":" + migrated + ",\"version\":7}");
            }
        } catch (DatabaseFailure e) { System.out.println("{\"status\":\"failed\",\"category\":\"" + e.category().name() + "\"}"); System.exit(1); }
        catch (Throwable e) { System.out.println("{\"status\":\"failed\",\"category\":\"DB_CONFIGURATION\"}"); System.exit(1); }
    }
}
