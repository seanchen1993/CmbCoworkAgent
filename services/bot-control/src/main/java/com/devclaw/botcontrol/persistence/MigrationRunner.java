package com.devclaw.botcontrol.persistence;

import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationState;
import org.flywaydb.core.api.configuration.FluentConfiguration;

/** Fixed classpath, explicit incremental migration; never clean/repair/baseline. */
public final class MigrationRunner {
    static final String SCRIPT = "V1__bot_group_storage.sql";
    private final Flyway flyway;
    public MigrationRunner(DataSource source) { flyway = configuration(source).load(); }
    static FluentConfiguration configuration(DataSource source) {
        return Flyway.configure().dataSource(source).locations("classpath:db/bot-migration")
            .defaultSchema("devclaw").schemas("devclaw").table("bot_schema_history")
            .cleanDisabled(true).cleanOnValidationError(false).baselineOnMigrate(false).createSchemas(false)
            .validateOnMigrate(true).validateMigrationNaming(true).failOnMissingLocations(true)
            // Pending source migrations are legitimate for explicit migrate;
            // readiness additionally requires exactly one applied SUCCESS.
            .ignorePendingMigrations(true).ignoreFutureMigrations(false)
            .ignoreMissingMigrations(false).ignoreIgnoredMigrations(false)
            .outOfOrder(false).placeholderReplacement(false)
            .connectRetries(0).lockRetryCount(2).loggers("slf4j");
    }
    public int migrate() {
        try { flyway.validate(); return flyway.migrate().migrationsExecuted; }
        catch (RuntimeException e) { throw new DatabaseFailure(DatabaseFailure.Category.MIGRATION_INVALID); }
    }
    public void requireCurrent() {
        try {
            flyway.validate();
            MigrationInfo[] all = flyway.info().all();
            if (all.length != 1 || all[0].getVersion() == null || !"1".equals(all[0].getVersion().getVersion()) ||
                !SCRIPT.equals(all[0].getScript()) || all[0].getChecksum() == null || all[0].getState() != MigrationState.SUCCESS) throw new IllegalStateException();
        } catch (RuntimeException e) { throw new DatabaseFailure(DatabaseFailure.Category.MIGRATION_INVALID); }
    }
}
