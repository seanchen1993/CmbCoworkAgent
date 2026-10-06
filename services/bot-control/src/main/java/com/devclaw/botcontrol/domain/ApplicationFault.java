package com.devclaw.botcontrol.domain;

import com.devclaw.botcontrol.contracts.BotContracts.ErrorCode;

/** Safe enum only: never retain JDBC messages, input or exception causes. */
public final class ApplicationFault extends RuntimeException {
    public final ErrorCode code;
    public final Long currentVersion;
    public ApplicationFault(ErrorCode code) { this(code, null); }
    public ApplicationFault(ErrorCode code, Long currentVersion) { super(code.wire(), null, false, false); this.code = code; this.currentVersion = currentVersion; }
}
