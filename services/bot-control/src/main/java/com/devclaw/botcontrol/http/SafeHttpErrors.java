package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.application.*;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.validation.ContractBoundary;
import java.util.UUID;

final class SafeHttpErrors {
    private static final ContractBoundary BOUNDARY = new ContractBoundary();
    static ApplicationResponse response(Operation operation, ErrorCode code) {
        int status;
        switch (code) {
            case INVALID_PAYLOAD: status = 400; break;
            case UNAUTHENTICATED: status = 401; break;
            case FORBIDDEN: status = 403; break;
            case NOT_FOUND: status = 404; break;
            case PAYLOAD_TOO_LARGE: status = 413; break;
            case RATE_LIMITED: status = 429; break;
            case DEPENDENCY_UNAVAILABLE: status = 503; break;
            default: throw new IllegalArgumentException("HTTP_ERROR_SELECTION");
        }
        ErrorResponse body = new ErrorResponse(); body.requestId = UUID.randomUUID().toString(); body.error = new ErrorResponseError();
        body.error.code = code; body.error.message = "Request could not be completed";
        body.error.retryable = code == ErrorCode.DEPENDENCY_UNAVAILABLE || code == ErrorCode.RATE_LIMITED;
        if (code == ErrorCode.RATE_LIMITED) body.error.retryAfterSeconds = 1L;
        return new ApplicationResponse(status, BOUNDARY.writeResponse(operation == null ? "getBot" : operation.wire, status, body));
    }
}
