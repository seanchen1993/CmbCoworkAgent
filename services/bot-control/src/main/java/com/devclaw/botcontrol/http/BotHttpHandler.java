package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.application.*;
import com.devclaw.botcontrol.contracts.BotContracts.ErrorCode;
import com.devclaw.botcontrol.ports.TrustedContext;
import java.io.IOException;
import java.util.concurrent.Semaphore;
import javax.servlet.http.*;
import org.springframework.web.HttpRequestHandler;

final class BotHttpHandler implements HttpRequestHandler {
    private final BotApplication application; private final TaskApplication tasks; private final Semaphore admission = new Semaphore(4);
    BotHttpHandler(BotApplication application, TaskApplication tasks) { this.application = application; this.tasks = tasks; }
    @Override public void handleRequest(HttpServletRequest request, HttpServletResponse response) throws IOException {
        RawRoute route = (RawRoute)request.getAttribute(RawRequestGate.ROUTE);
        if (route == null) { HttpOutput.write(response, SafeHttpErrors.response(null, ErrorCode.INVALID_PAYLOAD)); return; }
        if (!admission.tryAcquire()) { response.setHeader("Connection", "close"); HttpOutput.write(response, SafeHttpErrors.response(route.operation, ErrorCode.RATE_LIMITED)); return; }
        try {
            if (request.getHeaders("Content-Encoding").hasMoreElements()) throw new HttpFailure(ErrorCode.INVALID_PAYLOAD);
            if (route.operation.write()) {
                String type = RawRequestGate.one(request, "Content-Type", ErrorCode.INVALID_PAYLOAD);
                if (!type.matches("(?i)application/json(?:[ \\t]*;[ \\t]*charset[ \\t]*=[ \\t]*UTF-8)?")) throw new HttpFailure(ErrorCode.INVALID_PAYLOAD);
            }
            byte[] body = BoundedBody.read(request.getInputStream(), route.operation);
            TrustedContext actor = (TrustedContext)request.getAttribute(RawRequestGate.ACTOR);
            ApplicationResponse result = route.operation.task() ? tasks.execute(route.operation, actor, route.id, route.after, route.limit, body) : application.execute(route.operation, actor, route.id, body);
            HttpOutput.write(response, result);
        } catch (HttpFailure failure) {
            response.setHeader("Connection", "close"); HttpOutput.write(response, SafeHttpErrors.response(route.operation, failure.code));
        } catch (RuntimeException failure) {
            response.setHeader("Connection", "close"); HttpOutput.write(response, SafeHttpErrors.response(route.operation, ErrorCode.DEPENDENCY_UNAVAILABLE));
        } finally { admission.release(); }
    }
}
