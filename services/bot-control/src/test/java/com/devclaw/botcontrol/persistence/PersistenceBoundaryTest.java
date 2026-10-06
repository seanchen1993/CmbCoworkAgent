package com.devclaw.botcontrol.persistence;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.util.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.flywaydb.core.api.configuration.FluentConfiguration;

class PersistenceBoundaryTest {
    static final String PASSWORD = String.join("", Collections.nCopies(64, "a"));
    static ObjectNode input() { return new ObjectMapper().createObjectNode().put("mode", "local-dev").put("host", "127.0.0.1").put("port", 32881).put("schema", "devclaw").put("user", "devclaw_app").put("password", PASSWORD); }
    static LocalDatabaseConfig config(String input) { return LocalDatabaseConfig.fromTrustedLauncher(new ByteArrayInputStream(input.getBytes(StandardCharsets.UTF_8))); }
    @Test void closedLocalTransportAndPool() {
        LocalDatabaseConfig c = config(input().toString()); HikariConfig pool = c.poolConfiguration();
        assertEquals("jdbc:mysql://127.0.0.1:32881/devclaw", pool.getJdbcUrl());
        assertEquals(2, pool.getMaximumPoolSize()); assertEquals(0, pool.getMinimumIdle());
        assertEquals(2000, pool.getConnectionTimeout()); assertEquals(1000, pool.getValidationTimeout());
        assertEquals("3000", pool.getDataSourceProperties().getProperty("socketTimeout"));
        assertEquals("false", pool.getDataSourceProperties().getProperty("allowMultiQueries"));
        assertEquals("TRANSACTION_READ_COMMITTED", pool.getTransactionIsolation());
        assertFalse(c.toString().contains(PASSWORD));
    }
    @Test void rejectsMissingUnknownRemoteURLBadPortsAndSecrets() {
        for (String key : Arrays.asList("mode", "host", "schema", "user", "password", "port")) {
            ObjectNode n = input(); n.remove(key); assertThrows(DatabaseFailure.class, () -> config(n.toString()));
        }
        for (String host : Arrays.asList("localhost", "::1", "127.1", "127.0.0.1?x=y", "example.com")) { ObjectNode n = input().put("host", host); assertThrows(DatabaseFailure.class, () -> config(n.toString())); }
        for (String key : Arrays.asList("url", "driverClass", "query", "owner")) { ObjectNode n = input().put(key, "secret-sentinel"); assertThrows(DatabaseFailure.class, () -> config(n.toString())); }
        for (int port : Arrays.asList(0, 1024, 3306, 65536, 9200, 8333)) { ObjectNode n = input().put("port", port); assertThrows(DatabaseFailure.class, () -> config(n.toString())); }
        for (ObjectNode n : Arrays.asList(input().put("mode", "production"), input().put("schema", "mysql"), input().put("user", "root"), input().put("password", "sentinel"), input().put("port", "32881"), input().put("port", 32881.5))) assertThrows(DatabaseFailure.class, () -> config(n.toString()));
        for (String n : Arrays.asList(input() + "{}", "{\"mode\":\"local-dev\",\"mode\":\"local-dev\"}", String.join("", Collections.nCopies(4097, " ")))) assertThrows(DatabaseFailure.class, () -> config(n));
    }
    @Test void failuresNeverRetainDriverInputCauseOrStack() {
        DatabaseFailure failure = DatabaseFailure.sql(new SQLException("password/SQL/URL sentinel", "28000", 1045));
        assertEquals(DatabaseFailure.Category.DB_AUTH, failure.category()); assertEquals("DB_AUTH", failure.getMessage());
        assertNull(failure.getCause()); assertEquals(0, failure.getStackTrace().length);
        assertEquals(DatabaseFailure.Category.DB_TIMEOUT, DatabaseFailure.sql(new java.sql.SQLTimeoutException("sentinel")).category());
    }
    @Test void escapedStoragePreservesEveryUTF16UnitAndOriginalBytes() {
        for (String value : Arrays.asList("中文🚀", "x\u0000y", "\ud800", "\udc00", String.join("", Collections.nCopies(256, "🚀")))) {
            String encoded = StorageCodec.encodeName(value);
            assertTrue(StandardCharsets.US_ASCII.newEncoder().canEncode(encoded));
            assertEquals(value, StorageCodec.decodeName(encoded));
        }
        assertEquals(3074, StorageCodec.encodeName(String.join("", Collections.nCopies(256, "🚀"))).length());
        assertThrows(DatabaseFailure.class, () -> StorageCodec.decodeName("\"ok\"{}"));
        assertThrows(DatabaseFailure.class, () -> StorageCodec.encodeName(String.join("", Collections.nCopies(257, "🚀"))));
        byte[] bytes = new byte[1048576]; bytes[33] = (byte)0xff;
        assertArrayEquals(bytes, StorageCodec.boundedBody(bytes));
        assertNotSame(bytes, StorageCodec.boundedBody(bytes));
        assertThrows(DatabaseFailure.class, () -> StorageCodec.boundedBody(new byte[1048577]));
    }
    @Test void fixedMigrationPolicyAndPackagedSource() throws Exception {
        try (HikariDataSource pool = config(input().toString()).openPool()) {
            FluentConfiguration c = MigrationRunner.configuration(pool);
            assertTrue(c.isCleanDisabled()); assertFalse(c.isCleanOnValidationError()); assertFalse(c.isBaselineOnMigrate()); assertFalse(c.isCreateSchemas());
            assertFalse(c.isOutOfOrder()); assertFalse(c.isPlaceholderReplacement()); assertEquals(0, c.getConnectRetries()); assertEquals(2, c.getLockRetryCount());
            assertTrue(c.isIgnorePendingMigrations()); assertFalse(c.isIgnoreFutureMigrations()); assertFalse(c.isIgnoreMissingMigrations()); assertFalse(c.isIgnoreIgnoredMigrations());
            assertEquals("bot_schema_history", c.getTable()); assertEquals("devclaw", c.getDefaultSchema());
            assertEquals("classpath:db/bot-migration", c.getLocations()[0].getDescriptor());
        }
        try (InputStream input = getClass().getResourceAsStream("/db/bot-migration/" + MigrationRunner.SCRIPT)) {
            assertNotNull(input); ByteArrayOutputStream bytes = new ByteArrayOutputStream(); for (int b; (b = input.read()) != -1;) bytes.write(b);
            String sql = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
            assertEquals(9, sql.split("CREATE TABLE ").length - 1); assertFalse(sql.contains("FOREIGN KEY")); assertFalse(sql.contains("CHECK ("));
            assertTrue(sql.contains("MEDIUMBLOB")); assertTrue(sql.contains("name_json VARCHAR(3074)"));
        }
    }
}
