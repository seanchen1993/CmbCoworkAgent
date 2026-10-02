import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.sql.*;
import java.util.*;

/** Development compatibility probe only; no production DTO, service or CRUD. */
public final class JdbcProbe {
    private static void check(boolean value, String label) {
        if (!value) throw new IllegalStateException("Probe assertion: " + label);
    }
    private static int count(Connection c, String id) throws SQLException {
        try (PreparedStatement s = c.prepareStatement("SELECT COUNT(*) FROM f05_probe WHERE external_id=?")) {
            s.setString(1, id);
            try (ResultSet r = s.executeQuery()) { r.next(); return r.getInt(1); }
        }
    }
    private static void insert(Connection c, String id, String text, Timestamp time) throws SQLException {
        try (PreparedStatement s = c.prepareStatement("INSERT INTO f05_probe(external_id,body,observed_at,version) VALUES (?,?,?,1)")) {
            s.setString(1, id); s.setString(2, text);
            s.setTimestamp(3, time, Calendar.getInstance(TimeZone.getTimeZone("UTC")));
            check(s.executeUpdate() == 1, "insert");
        }
    }
    public static void main(String[] args) {
        try {
            check(System.getProperty("java.version").startsWith("1.8."), "actual Java 8 runtime");
            Class<?> driver = Class.forName("com.mysql.cj.jdbc.Driver");
            check("8.0.33".equals(driver.getPackage().getImplementationVersion()), "cached Connector/J 8.0.33");
            if (args.length == 1 && "driver".equals(args[0])) {
                System.out.println("{\"driver\":\"8.0.33\",\"java\":\"" + System.getProperty("java.version") + "\"}");
                return;
            }
            check(args.length == 1, "SQL path");
            Properties p = new Properties();
            p.load(System.in);
            String port = p.getProperty("port", "");
            check(port.matches("[0-9]{1,5}") && Integer.parseInt(port) > 1024 && Integer.parseInt(port) != 3306, "exclusive nondefault port");
            Properties connection = new Properties();
            connection.setProperty("user", p.getProperty("user"));
            connection.setProperty("password", p.getProperty("password"));
            connection.setProperty("useSSL", "false");
            connection.setProperty("allowPublicKeyRetrieval", "false");
            connection.setProperty("characterEncoding", "UTF-8");
            connection.setProperty("connectionTimeZone", "UTC");
            connection.setProperty("forceConnectionTimeZoneToSession", "true");
            connection.setProperty("connectTimeout", "2000");
            connection.setProperty("socketTimeout", "3000");
            String url = "jdbc:mysql://127.0.0.1:" + port + "/f05_compat";
            try (Connection c = DriverManager.getConnection(url, connection);
                 Connection other = DriverManager.getConnection(url, connection)) {
                String version = c.getMetaData().getDatabaseProductVersion();
                check(version.startsWith("5.7."), "real MySQL 5.7");
                check(c.getMetaData().getDriverVersion().contains("8.0.33"), "real JDBC driver");
                if ("ping".equals(args[0])) {
                    try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT 1")) {
                        check(r.next() && r.getInt(1) == 1, "real SQL readiness");
                    }
                    System.out.println("{\"sqlReady\":true}"); return;
                }
                c.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED);
                other.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED);
                check(c.getTransactionIsolation() == Connection.TRANSACTION_READ_COMMITTED, "JDBC READ_COMMITTED");
                try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT @@session.time_zone,@@character_set_connection,@@tx_isolation,@@port,@@bind_address,@@skip_networking,@@character_set_database")) {
                    r.next(); check("+00:00".equals(r.getString(1)), "UTC session");
                    check("utf8mb4".equals(r.getString(2)), "utf8mb4 session");
                    check("READ-COMMITTED".equals(r.getString(3)), "server isolation");
                    check(r.getInt(4) == Integer.parseInt(port) && "127.0.0.1".equals(r.getString(5)) && r.getInt(6) == 0, "owned loopback endpoint");
                    check("utf8mb4".equals(r.getString(7)), "utf8mb4 database");
                }
                try (Statement s = c.createStatement()) {
                    s.execute(new String(Files.readAllBytes(new File(args[0]).toPath()), StandardCharsets.UTF_8));
                }
                Calendar utc = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
                utc.clear(); utc.set(2026, Calendar.OCTOBER, 2, 15, 0, 0);
                Timestamp time = new Timestamp(utc.getTimeInMillis()); time.setNanos(123000000);
                String unicode = "中文合成\uD83D\uDE80";
                c.setAutoCommit(false);
                insert(c, "committed", unicode, time); c.commit();
                try (PreparedStatement s = c.prepareStatement("SELECT body,observed_at,version FROM f05_probe WHERE external_id=?")) {
                    s.setString(1, "committed");
                    try (ResultSet r = s.executeQuery()) {
                        check(r.next(), "commit visible"); check(unicode.equals(r.getString(1)), "Chinese/emoji round trip");
                        Timestamp actual = r.getTimestamp(2, Calendar.getInstance(TimeZone.getTimeZone("UTC")));
                        check(actual.getTime() == time.getTime() && actual.getNanos() == 123000000, "DATETIME(3) UTC round trip");
                    }
                }
                insert(c, "rolled-back", "rollback", time); c.rollback();
                check(count(c, "rolled-back") == 0 && count(other, "rolled-back") == 0, "rollback across connections");
                boolean unique = false;
                try { insert(c, "committed", "duplicate", time); }
                catch (SQLException e) { unique = e.getErrorCode() == 1062 && "23000".equals(e.getSQLState()); }
                c.rollback(); check(unique && count(other, "committed") == 1, "unique index no partial write");
                check(count(c, "read-committed") == 0, "initial read");
                other.setAutoCommit(false); insert(other, "read-committed", "visible", time);
                check(count(c, "read-committed") == 0, "uncommitted invisible");
                other.commit(); check(count(c, "read-committed") == 1, "new commit visible in same RC transaction"); c.commit();
                try (PreparedStatement s = c.prepareStatement("UPDATE f05_probe SET version=version+1 WHERE external_id=? AND version=?")) {
                    s.setString(1, "committed"); s.setInt(2, 1); check(s.executeUpdate() == 1, "CAS winner"); c.commit();
                }
                try (PreparedStatement s = other.prepareStatement("UPDATE f05_probe SET version=version+1 WHERE external_id=? AND version=?")) {
                    s.setString(1, "committed"); s.setInt(2, 1); check(s.executeUpdate() == 0, "CAS stale writer"); other.rollback();
                }
                try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT version FROM f05_probe WHERE external_id='committed'")) {
                    check(r.next() && r.getInt(1) == 2, "CAS increments once");
                }
                boolean restricted = false;
                try (Statement s = c.createStatement()) { s.executeQuery("SELECT User FROM mysql.user"); }
                catch (SQLException e) { restricted = e.getErrorCode() == 1142; }
                check(restricted, "limited test account");
                c.rollback();
                System.out.println("{\"status\":\"verified\",\"mysql\":\"" + version + "\",\"jdbc\":\"8.0.33\",\"checks\":[\"utf8mb4\",\"UTC\",\"DATETIME(3)\",\"READ_COMMITTED\",\"commit\",\"rollback\",\"unique_key\",\"expectedVersion_CAS\",\"limited_account\"]}");
            }
        } catch (Throwable e) {
            // Never print SQL, URLs, credentials, arbitrary driver messages or stack traces.
            System.err.println("Probe failed: " + e.getClass().getSimpleName() + (e instanceof SQLException ? " SQLState=" + ((SQLException)e).getSQLState() + " code=" + ((SQLException)e).getErrorCode() : ""));
            System.exit(1);
        }
    }
}
