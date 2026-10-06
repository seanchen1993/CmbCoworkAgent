package com.devclaw.botcontrol.persistence;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.util.*;

/** Closed transport from the trusted Node local launcher. This type does NOT
 * authenticate a self-reported owner: launcher must prove actual Docker/file
 * ownership before reading a secret and before spawning/sending this input.
 * No env, user settings, arbitrary JDBC URLs, files, or root fallback. */
public final class LocalDatabaseConfig {
    private final int port;
    private final String password;
    private LocalDatabaseConfig(int port, String password) { this.port = port; this.password = password; }
    public static LocalDatabaseConfig fromTrustedLauncher(InputStream input) {
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            for (int value; (value = input.read()) != -1;) {
                if (bytes.size() == 4096) throw new DatabaseFailure(DatabaseFailure.Category.CONFIG_INVALID);
                bytes.write(value);
            }
            ObjectMapper mapper = new ObjectMapper(new JsonFactory().enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION));
            JsonNode n;
            try (JsonParser parser = mapper.getFactory().createParser(bytes.toByteArray())) {
                n = mapper.readTree(parser);
                if (parser.nextToken() != null) throw new DatabaseFailure(DatabaseFailure.Category.CONFIG_INVALID);
            }
            Set<String> keys = new HashSet<String>();
            if (n == null || !n.isObject()) throw new DatabaseFailure(DatabaseFailure.Category.CONFIG_INVALID);
            n.fieldNames().forEachRemaining(keys::add);
            if (!keys.equals(new HashSet<String>(Arrays.asList("mode", "host", "port", "schema", "user", "password"))) ||
                !"local-dev".equals(n.path("mode").textValue()) || !"127.0.0.1".equals(n.path("host").textValue()) ||
                !"devclaw".equals(n.path("schema").textValue()) || !"devclaw_app".equals(n.path("user").textValue()) ||
                !n.path("port").isIntegralNumber() || !n.path("port").canConvertToInt()) throw new DatabaseFailure(DatabaseFailure.Category.CONFIG_INVALID);
            int port = n.get("port").intValue();
            if (port <= 1024 || port > 65535 || Arrays.asList(3306, 9200, 9300, 8333, 9333, 8888).contains(port)) throw new DatabaseFailure(DatabaseFailure.Category.CONFIG_INVALID);
            String password = n.path("password").textValue();
            if (password == null || !password.matches("[a-f0-9]{64}")) throw new DatabaseFailure(DatabaseFailure.Category.SECRET_INVALID);
            return new LocalDatabaseConfig(port, password);
        } catch (DatabaseFailure e) { throw e; }
        catch (Exception e) { throw new DatabaseFailure(DatabaseFailure.Category.CONFIG_INVALID); }
    }
    HikariConfig poolConfiguration() {
        HikariConfig c = new HikariConfig();
        c.setPoolName("bot-local-db");
        c.setDriverClassName("com.mysql.cj.jdbc.Driver");
        c.setJdbcUrl("jdbc:mysql://127.0.0.1:" + port + "/devclaw");
        c.setUsername("devclaw_app"); c.setPassword(password);
        c.addDataSourceProperty("useSSL", "false"); c.addDataSourceProperty("allowPublicKeyRetrieval", "false");
        c.addDataSourceProperty("characterEncoding", "UTF-8"); c.addDataSourceProperty("connectionTimeZone", "UTC");
        c.addDataSourceProperty("forceConnectionTimeZoneToSession", "true");
        c.addDataSourceProperty("connectTimeout", "2000"); c.addDataSourceProperty("socketTimeout", "3000");
        c.addDataSourceProperty("allowMultiQueries", "false"); c.addDataSourceProperty("allowLoadLocalInfile", "false");
        c.setConnectionInitSql("SET SESSION time_zone='+00:00',tx_isolation='READ-COMMITTED',innodb_lock_wait_timeout=2,sql_mode='STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'");
        c.setTransactionIsolation("TRANSACTION_READ_COMMITTED");
        c.setMaximumPoolSize(2); c.setMinimumIdle(0);
        c.setConnectionTimeout(2000); c.setValidationTimeout(1000);
        c.setIdleTimeout(10000); c.setMaxLifetime(30000); c.setInitializationFailTimeout(-1);
        return c;
    }
    public HikariDataSource openPool() { return new HikariDataSource(poolConfiguration()); }
    @Override public String toString() { return "LocalDatabaseConfig[local-dev]"; }
}
