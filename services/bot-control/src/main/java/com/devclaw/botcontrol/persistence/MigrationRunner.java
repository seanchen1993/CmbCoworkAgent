package com.devclaw.botcontrol.persistence;

import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationState;
import org.flywaydb.core.api.configuration.FluentConfiguration;

/** Fixed classpath, explicit incremental migration; never clean/repair/baseline. */
public final class MigrationRunner {
    static final String SCRIPT = "V1__bot_group_storage.sql";
    static final String TASK_SCRIPT = "V2__task_collaboration.sql";
    static final String NODE_SCRIPT = "V3__runtime_node_authorization.sql";
    static final String RUN_SCRIPT = "V4__requirement_run_queue.sql";
    static final String RESULT_SCRIPT = "V5__requirement_run_results.sql";
    static final String MEMORY_SCRIPT = "V6__group_explicit_memory.sql";
    static final String EXPERT_MEMORY_SCRIPT = "V7__expert_memory.sql";
    static final String DELIVERY_SCRIPT = "V8__text_delivery_review.sql";
    static final String CONVERSATION_SCRIPT = "V9__expert_task_conversations.sql";
    private final Flyway flyway;
    public MigrationRunner(DataSource source) { flyway = configuration(source).load(); }
    static FluentConfiguration configuration(DataSource source) {
        return Flyway.configure().dataSource(source).locations("classpath:db/bot-migration")
            .defaultSchema("devclaw").schemas("devclaw").table("bot_schema_history")
            .cleanDisabled(true).cleanOnValidationError(false).baselineOnMigrate(false).createSchemas(false)
            .validateOnMigrate(true).validateMigrationNaming(true).failOnMissingLocations(true)
            // Pending source migrations are legitimate for explicit migrate;
            // readiness additionally requires all nine applied successes.
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
            if (all.length != 9) throw new IllegalStateException();
            String[] scripts = {SCRIPT, TASK_SCRIPT, NODE_SCRIPT, RUN_SCRIPT, RESULT_SCRIPT, MEMORY_SCRIPT, EXPERT_MEMORY_SCRIPT, DELIVERY_SCRIPT, CONVERSATION_SCRIPT};
            for (int i = 0; i < scripts.length; i++) if (all[i].getVersion() == null || !String.valueOf(i + 1).equals(all[i].getVersion().getVersion()) ||
                !scripts[i].equals(all[i].getScript()) || all[i].getChecksum() == null || all[i].getState() != MigrationState.SUCCESS) throw new IllegalStateException();
        } catch (RuntimeException e) { throw new DatabaseFailure(DatabaseFailure.Category.MIGRATION_INVALID); }
    }
}
