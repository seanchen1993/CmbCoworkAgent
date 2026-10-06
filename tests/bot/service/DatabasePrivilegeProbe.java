import java.sql.*;
import java.util.*;

/** B1 v2 test-only app/schema-ALL prerequisite. No FK/root/repair path. */
public final class DatabasePrivilegeProbe {
    public static void main(String[] args) {
        try {
            if (args.length != 0 || !System.getProperty("java.version").startsWith("1.8.")) throw new IllegalStateException();
            Properties input = new Properties(); input.load(System.in);
            String port = input.getProperty("port", ""), password = input.getProperty("password", "");
            if (input.size() != 2 || !port.matches("[0-9]{4,5}") || Integer.parseInt(port) <= 1024 || Integer.parseInt(port) > 65535 ||
                Integer.parseInt(port) == 3306 || !password.matches("[a-f0-9]{64}")) throw new IllegalStateException();
            Properties p = new Properties();
            p.setProperty("user", "devclaw_app"); p.setProperty("password", password);
            p.setProperty("useSSL", "false"); p.setProperty("allowPublicKeyRetrieval", "false");
            p.setProperty("connectTimeout", "2000"); p.setProperty("socketTimeout", "3000");
            p.setProperty("characterEncoding", "UTF-8"); p.setProperty("connectionTimeZone", "UTC");
            p.setProperty("forceConnectionTimeZoneToSession", "true");
            try (Connection c = DriverManager.getConnection("jdbc:mysql://127.0.0.1:" + port + "/devclaw", p)) {
                if (!"5.7.44".equals(c.getMetaData().getDatabaseProductVersion()) || !c.getMetaData().getDriverVersion().contains("8.0.33")) throw new IllegalStateException();
                try (Statement s = c.createStatement()) {
                    s.setQueryTimeout(3);
                    try (ResultSet r = s.executeQuery("SELECT DATABASE(),CURRENT_USER(),@@time_zone,@@character_set_connection,@@tx_isolation")) {
                        if (!r.next() || !"devclaw".equals(r.getString(1)) || !"devclaw_app@%".equals(r.getString(2)) || !"+00:00".equals(r.getString(3)) ||
                            !"utf8mb4".equals(r.getString(4)) || !"READ-COMMITTED".equals(r.getString(5))) throw new IllegalStateException();
                    }
                    boolean schemaAll = false, usage = false;
                    try (ResultSet r = s.executeQuery("SHOW GRANTS FOR CURRENT_USER()")) {
                        while (r.next()) {
                            String grant = r.getString(1);
                            int on = grant.indexOf(" ON "), to = grant.indexOf(" TO ");
                            if (!grant.startsWith("GRANT ") || on < 6 || to < on || grant.contains("GRANT OPTION")) throw new IllegalStateException();
                            String scope = grant.substring(on + 4, to), privileges = grant.substring(6, on);
                            if ("*.*".equals(scope) && "USAGE".equals(privileges) && !usage) usage = true;
                            else if ("`devclaw`.*".equals(scope) && "ALL PRIVILEGES".equals(privileges) && !schemaAll) schemaAll = true;
                            else throw new IllegalStateException();
                        }
                    }
                    if (!schemaAll || !usage) throw new IllegalStateException();
                    s.execute("CREATE TABLE b1_privilege_parent (space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, PRIMARY KEY(space_id,id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
                    s.execute("CREATE TABLE b1_privilege_child (space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, PRIMARY KEY(space_id,id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
                    s.execute("ALTER TABLE b1_privilege_child ADD COLUMN ordinal INT NOT NULL DEFAULT 0");
                    s.execute("CREATE INDEX ix_b1_privilege ON b1_privilege_child(space_id,ordinal)");
                    try (ResultSet r = s.executeQuery("SELECT COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema='devclaw'")) { if (!r.next() || r.getInt(1) != 0) throw new IllegalStateException(); }
                    for (String forbidden : Arrays.asList("SELECT User FROM mysql.user", "CREATE DATABASE b1_forbidden", "CREATE USER 'b1_forbidden'@'localhost'")) {
                        boolean denied = false;
                        try { s.execute(forbidden); } catch (SQLException e) { denied = Arrays.asList(1044, 1142, 1227).contains(e.getErrorCode()); }
                        if (!denied) throw new IllegalStateException();
                    }
                    // Only the two explicit disposable prerequisite tables, not a migration reset.
                    s.execute("DROP TABLE b1_privilege_child"); s.execute("DROP TABLE b1_privilege_parent");
                }
            }
            System.out.println("{\"status\":\"verified\",\"java\":\"1.8.0_482\",\"mysql\":\"5.7.44\",\"jdbc\":\"8.0.33\",\"account\":\"schema-ALL\",\"zeroForeignKeys\":true,\"denials\":3}");
        } catch (SQLException e) {
            System.out.println("{\"status\":\"failed\",\"category\":\"DDL_PRIVILEGE\",\"sqlState\":\"" + e.getSQLState() + "\",\"errno\":" + e.getErrorCode() + "}");
            System.exit(1);
        } catch (Throwable e) {
            System.out.println("{\"status\":\"failed\",\"category\":\"PREREQUISITE\"}"); System.exit(1);
        }
    }
}
