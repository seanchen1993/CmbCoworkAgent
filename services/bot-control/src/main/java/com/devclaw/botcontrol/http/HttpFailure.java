package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.contracts.BotContracts.ErrorCode;

/** Only a closed safe transport classification, never the input or its cause. */
final class HttpFailure extends RuntimeException {
    final ErrorCode code;
    HttpFailure(ErrorCode code) { super(code.wire(), null, false, false); this.code = code; }
}
