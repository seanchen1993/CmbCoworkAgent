import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;

/** B00 development-only probe: a loopback host mapping is distinct from the container's port. */
public final class DockerJdbcProbe {
    private static void check(boolean value) {
        if (!value) throw new IllegalStateException("B00 assertion failed");
    }
    private static int count(Connection c, String id) throws SQLException {
        try (PreparedStatement s = c.prepareStatement("SELECT COUNT(*) FROM b00_probe WHERE external_id=?")) {
            s.setString(1, id);
            try (ResultSet r = s.executeQuery()) { r.next(); return r.getInt(1); }
        }
    }
    private static void insert(Connection c, String id, String body, Timestamp time) throws SQLException {
        try (PreparedStatement s = c.prepareStatement("INSERT INTO b00_probe(external_id,body,observed_at,version) VALUES (?,?,?,1)")) {
            s.setString(1, id); s.setString(2, body); s.setTimestamp(3, time, Calendar.getInstance(TimeZone.getTimeZone("UTC")));
            check(s.executeUpdate() == 1);
        }
    }
    private static void denied(Connection c, String sql) throws SQLException {
        boolean rejected = false;
        try (Statement s = c.createStatement()) { s.execute(sql); }
        catch (SQLException e) { rejected = Arrays.asList(1044, 1142, 1227).contains(e.getErrorCode()); }
        check(rejected);
    }
    public static void main(String[] args) {
        try {
            check(args.length == 1 && Arrays.asList("probe", "persist", "empty", "ping", "reject-version").contains(args[0]));
            check(System.getProperty("java.version").startsWith("1.8."));
            Class<?> driver = Class.forName("com.mysql.cj.jdbc.Driver");
            check("8.0.33".equals(driver.getPackage().getImplementationVersion()));
            Properties p = new Properties(); p.load(System.in);
            String port = p.getProperty("port", ""), password = p.getProperty("password", "");
            check(port.matches("[0-9]{1,5}") && Integer.parseInt(port) > 1024 && Integer.parseInt(port) <= 65535 && Integer.parseInt(port) != 3306);
            check(password.matches("[a-f0-9]{64}"));
            Properties connection = new Properties();
            connection.setProperty("user", "devclaw_app"); connection.setProperty("password", password);
            connection.setProperty("useSSL", "false"); connection.setProperty("allowPublicKeyRetrieval", "false");
            connection.setProperty("characterEncoding", "UTF-8"); connection.setProperty("connectionTimeZone", "UTC");
            connection.setProperty("forceConnectionTimeZoneToSession", "true"); connection.setProperty("connectTimeout", "2000"); connection.setProperty("socketTimeout", "3000");
            try (Connection c = DriverManager.getConnection("jdbc:mysql://127.0.0.1:" + port + "/devclaw", connection);
                 Connection other = DriverManager.getConnection("jdbc:mysql://127.0.0.1:" + port + "/devclaw", connection)) {
                String version = c.getMetaData().getDatabaseProductVersion();
                check(("reject-version".equals(args[0]) ? "8.0.0" : "5.7.44").equals(version));
                check(c.getMetaData().getDriverVersion().contains("8.0.33"));
                try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT @@session.time_zone,@@character_set_connection,@@tx_isolation,@@port,@@skip_networking,@@character_set_database,CURRENT_USER()")) {
                    check(r.next()); check("+00:00".equals(r.getString(1))); check("utf8mb4".equals(r.getString(2)));
                    check("READ-COMMITTED".equals(r.getString(3))); check(r.getInt(4) == 3306 && r.getInt(5) == 0);
                    check("utf8mb4".equals(r.getString(6))); check("devclaw_app@%".equals(r.getString(7)));
                }
                denied(c, "SELECT User FROM mysql.user");
                denied(c, "CREATE DATABASE b00_forbidden");
                denied(c, "GRANT SELECT ON devclaw.* TO 'nobody'@'%'");
                if ("empty".equals(args[0])) {
                    try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='devclaw'")) { check(r.next() && r.getInt(1) == 0); }
                } else if ("persist".equals(args[0])) {
                    check(count(c, "committed") == 1 && count(c, "read-committed") == 1 && count(c, "rolled-back") == 0);
                    try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT body,version FROM b00_probe WHERE external_id='committed'")) { check(r.next() && "中文合成\uD83D\uDE80".equals(r.getString(1)) && r.getInt(2) == 2); }
                } else if ("probe".equals(args[0])) {
                    c.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED); other.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED);
                    try (Statement s = c.createStatement()) { s.execute("CREATE TABLE b00_probe (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, external_id VARCHAR(64) NOT NULL, body VARCHAR(128) NOT NULL, observed_at DATETIME(3) NOT NULL, version INT NOT NULL, UNIQUE KEY uq_b00_external(external_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"); }
                    Calendar utc = Calendar.getInstance(TimeZone.getTimeZone("UTC")); utc.clear(); utc.set(2026, Calendar.OCTOBER, 3, 15, 0, 0);
                    Timestamp time = new Timestamp(utc.getTimeInMillis()); time.setNanos(123000000);
                    String unicode = "中文合成\uD83D\uDE80";
                    c.setAutoCommit(false); insert(c, "committed", unicode, time); c.commit();
                    try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT body,observed_at FROM b00_probe WHERE external_id='committed'")) {
                        check(r.next() && unicode.equals(r.getString(1))); Timestamp actual = r.getTimestamp(2, Calendar.getInstance(TimeZone.getTimeZone("UTC")));
                        check(actual.getTime() == time.getTime() && actual.getNanos() == 123000000);
                    }
                    insert(c, "rolled-back", "rollback", time); c.rollback(); check(count(c, "rolled-back") == 0 && count(other, "rolled-back") == 0);
                    boolean unique = false;
                    try { insert(c, "committed", "duplicate", time); } catch (SQLException e) { unique = e.getErrorCode() == 1062 && "23000".equals(e.getSQLState()); }
                    c.rollback(); check(unique && count(other, "committed") == 1);
                    check(count(c, "read-committed") == 0); other.setAutoCommit(false); insert(other, "read-committed", "visible", time);
                    check(count(c, "read-committed") == 0); other.commit(); check(count(c, "read-committed") == 1); c.commit();
                    try (Statement s = c.createStatement()) { check(s.executeUpdate("UPDATE b00_probe SET version=version+1 WHERE external_id='committed' AND version=1") == 1); c.commit(); }
                    try (Statement s = other.createStatement()) { check(s.executeUpdate("UPDATE b00_probe SET version=version+1 WHERE external_id='committed' AND version=1") == 0); other.rollback(); }
                    try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT version FROM b00_probe WHERE external_id='committed'")) { check(r.next() && r.getInt(1) == 2); }
                    c.rollback();
                }
                System.out.println("{\"status\":\"verified\",\"action\":\"" + args[0] + "\",\"mysql\":\"5.7.44\",\"jdbc\":\"8.0.33\",\"java\":\"" + System.getProperty("java.version") + "\"}");
            }
        } catch (Throwable e) {
            // Never emit arbitrary JDBC messages, SQL, credential bytes, URLs or stack traces.
            System.err.println("B00 JDBC failed: " + e.getClass().getSimpleName() + (e instanceof SQLException ? " SQLState=" + ((SQLException)e).getSQLState() + " code=" + ((SQLException)e).getErrorCode() : ""));
            System.exit(1);
        }
    }
}
