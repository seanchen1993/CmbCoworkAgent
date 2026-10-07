package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.application.ApplicationResponse;
import com.devclaw.botcontrol.contracts.BotContracts.ErrorCode;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicReference;
import org.apache.catalina.Lifecycle;
import org.apache.catalina.connector.Connector;
import org.apache.catalina.connector.CoyoteAdapter;
import org.apache.coyote.*;
import org.apache.tomcat.util.net.SocketEvent;

/** Public pinned Adapter delegation before CoyoteAdapter's method shortcuts. */
final class ClosedMethodAdapter implements Adapter {
    private final Adapter delegate;
    ClosedMethodAdapter(Adapter delegate) { if (delegate == null) throw new IllegalArgumentException("HTTP_ADAPTER"); this.delegate = delegate; }
    static void install(Connector connector) {
        AtomicReference<ClosedMethodAdapter> installed = new AtomicReference<ClosedMethodAdapter>();
        connector.addLifecycleListener(event -> {
            if (!Lifecycle.BEFORE_START_EVENT.equals(event.getType())) return;
            Adapter current = connector.getProtocolHandler().getAdapter();
            if (installed.get() != null) {
                if (current != installed.get()) throw new IllegalStateException("HTTP_ADAPTER");
                return;
            }
            // Connector.initInternal has installed this exact fixed-version
            // delegate; protocol.start/acceptors have not started yet.
            if (current == null || current.getClass() != CoyoteAdapter.class) throw new IllegalStateException("HTTP_ADAPTER");
            ClosedMethodAdapter wrapper = new ClosedMethodAdapter(current);
            connector.getProtocolHandler().setAdapter(wrapper); installed.set(wrapper);
        });
    }
    private boolean reject(Request request, Response response) throws Exception {
        String method = request.method().toString();
        if ("GET".equals(method) || "POST".equals(method) || "PUT".equals(method) || "HEAD".equals(method)) return false;
        ApplicationResponse result = SafeHttpErrors.response(null, ErrorCode.INVALID_PAYLOAD); byte[] bytes = result.body();
        response.setStatus(result.status); response.setContentType("application/json"); response.setContentLength(bytes.length);
        response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("Connection", "close");
        response.action(ActionCode.DISABLE_SWALLOW_INPUT, null); response.doWrite(ByteBuffer.wrap(bytes));
        return true;
    }
    @Override public void service(Request request, Response response) throws Exception { if (!reject(request,response)) delegate.service(request,response); }
    @Override public boolean prepare(Request request, Response response) throws Exception { return !reject(request,response) && delegate.prepare(request,response); }
    @Override public boolean asyncDispatch(Request request, Response response, SocketEvent event) throws Exception { return delegate.asyncDispatch(request,response,event); }
    @Override public void log(Request request, Response response, long time) { delegate.log(request,response,time); }
    @Override public void checkRecycled(Request request, Response response) { delegate.checkRecycled(request,response); }
    @Override public String getDomain() { return delegate.getDomain(); }
}
