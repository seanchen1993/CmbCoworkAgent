package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.adapters.local.LocalIdentityRegistry;
import com.devclaw.botcontrol.contracts.BotContracts.ErrorCode;
import com.devclaw.botcontrol.ports.TrustedContext;
import com.devclaw.botcontrol.validation.ContractBoundary;
import java.io.IOException;
import java.util.*;
import javax.servlet.*;
import javax.servlet.http.*;

final class RawRequestGate implements Filter {
    static final String ROUTE = RawRequestGate.class.getName() + ".route", ACTOR = RawRequestGate.class.getName() + ".actor";
    private final LocalIdentityRegistry identity; private final ContractBoundary boundary = new ContractBoundary();
    private final PartnerHttpHandler partner;
    RawRequestGate(LocalIdentityRegistry identity) { this(identity,null); }
    RawRequestGate(LocalIdentityRegistry identity,PartnerHttpHandler partner) { this.identity = identity;this.partner=partner; }
    @Override public void doFilter(ServletRequest input, ServletResponse output, FilterChain chain) throws IOException, ServletException {
        HttpServletRequest request = (HttpServletRequest)input; HttpServletResponse response = (HttpServletResponse)output; RawRoute route = null;
        if(partner!=null&&partner.accepts(request.getRequestURI())){partner.handle(request,response);return;}
        try {
            route = RawRoute.select(request.getMethod(), request.getRequestURI(), request.getQueryString());
            if (!"127.0.0.1".equals(request.getLocalAddr()) || !"127.0.0.1".equals(request.getRemoteAddr())) throw invalid();
            String host = one(request, "Host", ErrorCode.INVALID_PAYLOAD);
            if (!("127.0.0.1:" + request.getLocalPort()).equals(host) || request.getHeaders("Origin").hasMoreElements()) throw invalid();
            String principal = identity.principalFor(one(request, "Authorization", ErrorCode.UNAUTHENTICATED));
            if (principal == null) throw new HttpFailure(ErrorCode.UNAUTHENTICATED);
            String space = one(request, "X-DevClaw-Space", ErrorCode.INVALID_PAYLOAD);
            try { boundary.validateParameter(route.operation.wire, "X-DevClaw-Space", space); }
            catch (ContractBoundary.Failure failure) { throw new HttpFailure(failure.category() == ContractBoundary.Category.SCHEMA_RESOURCE ? ErrorCode.DEPENDENCY_UNAVAILABLE : ErrorCode.INVALID_PAYLOAD); }
            if (!identity.activeMember(space, principal)) throw new HttpFailure(ErrorCode.FORBIDDEN);
            request.setAttribute(ROUTE, route); request.setAttribute(ACTOR, new TrustedContext(space, principal));
            chain.doFilter(request, response);
        } catch (HttpFailure failure) {
            response.setHeader("Connection", "close"); HttpOutput.write(response, SafeHttpErrors.response(route == null ? null : route.operation, failure.code));
        }
    }
    static String one(HttpServletRequest request, String name, ErrorCode code) {
        Enumeration<String> values = request.getHeaders(name);
        if (!values.hasMoreElements()) throw new HttpFailure(code);
        String value = values.nextElement();
        if (values.hasMoreElements() || value == null || value.indexOf(',') >= 0) throw new HttpFailure(code);
        return value;
    }
    private static HttpFailure invalid() { return new HttpFailure(ErrorCode.INVALID_PAYLOAD); }
}
