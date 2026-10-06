package com.devclaw.botcontrol.ports;

/** Constructor-only observation/failure seam; no request or environment switch. */
public interface TransactionObserver {
    enum Stage { BEFORE_SCOPE, SCOPE_LOCKED, VERSION_WRITTEN, MEMBER_WRITTEN, BEFORE_RECEIPT, BEFORE_COMMIT, AFTER_COMMIT }
    void reached(Stage stage);
    TransactionObserver NONE = stage -> {};
}
