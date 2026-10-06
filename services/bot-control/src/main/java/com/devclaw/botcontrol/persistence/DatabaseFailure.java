package com.devclaw.botcontrol.persistence;

import java.sql.SQLException;

/** No arbitrary message/cause/SQL survives this boundary. */
public final class DatabaseFailure extends RuntimeException {
    public enum Category { CONFIG_INVALID, SECRET_INVALID, DB_AUTH, DB_UNAVAILABLE, DB_TIMEOUT, DB_CONFIGURATION, MIGRATION_INVALID, STORAGE_INVALID }
    private final Category category;
    public DatabaseFailure(Category category) { super(category.name(), null, false, false); this.category = category; }
    public Category category() { return category; }
    static DatabaseFailure sql(SQLException error) {
        Throwable e = error;
        for (int i = 0; e != null && i < 16; i++, e = e.getCause()) {
            if (e instanceof SQLException) {
                SQLException s = (SQLException)e;
                if (s.getErrorCode() == 1045) return new DatabaseFailure(Category.DB_AUTH);
                if (s.getErrorCode() == 1205 || s instanceof java.sql.SQLTimeoutException || "HYT00".equals(s.getSQLState())) return new DatabaseFailure(Category.DB_TIMEOUT);
            }
        }
        return new DatabaseFailure(Category.DB_UNAVAILABLE);
    }
}
