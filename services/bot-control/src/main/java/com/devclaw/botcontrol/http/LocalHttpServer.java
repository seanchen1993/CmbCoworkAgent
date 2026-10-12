package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.adapters.local.LocalLaunchConfig;
import com.devclaw.botcontrol.adapters.local.PartnerLaunchConfig;
import com.devclaw.botcontrol.application.BotApplication;
import com.devclaw.botcontrol.application.TaskApplication;
import com.devclaw.botcontrol.persistence.DatabaseReadiness;
import com.devclaw.botcontrol.ports.TransactionObserver;
import com.zaxxer.hikari.HikariDataSource;
import java.io.File;
import java.net.InetAddress;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.logging.*;
import javax.servlet.*;
import org.apache.catalina.core.StandardHost;
import org.apache.catalina.startup.Tomcat;
import org.apache.coyote.http11.Http11NioProtocol;
import org.apache.tomcat.util.threads.TaskQueue;
import org.apache.tomcat.util.threads.ThreadPoolExecutor;
import org.springframework.boot.web.embedded.tomcat.*;
import org.springframework.boot.web.server.WebServer;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.web.context.support.GenericWebApplicationContext;
import org.springframework.web.servlet.DispatcherServlet;
import org.springframework.web.servlet.handler.SimpleUrlHandlerMapping;
import org.springframework.web.servlet.mvc.HttpRequestHandlerAdapter;

/** Explicit local-only assembly. No SpringApplication/env/config scanning or DDL. */
public final class LocalHttpServer implements AutoCloseable {
    // JUL keeps named loggers weakly. Retain these parents so schema-loading GC
    // cannot discard their OFF levels and pollute the closed launcher output.
    private static final List<Logger> QUIET_LOGGERS = Arrays.asList(
        Logger.getLogger("org.apache.catalina"), Logger.getLogger("org.apache.coyote"), Logger.getLogger("org.apache.tomcat"));
    private final HikariDataSource source;
    private final GenericWebApplicationContext context = new GenericWebApplicationContext();
    private final TaskQueue queue = new TaskQueue(16);
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(8, 8, 60, TimeUnit.SECONDS, queue,
        runnable -> { Thread t = new Thread(runnable, "bot-http-worker"); t.setDaemon(true); return t; });
    private final AtomicBoolean closed = new AtomicBoolean();
    private WebServer server;
    private LocalHttpServer(HikariDataSource source) { this.source = source; queue.setParent(workers); }
    public static LocalHttpServer start(LocalLaunchConfig config) { return start(config, TransactionObserver.NONE); }
    public static LocalHttpServer start(PartnerLaunchConfig config) { if(config==null)throw new IllegalArgumentException("HTTP_STARTUP");return start(config.legacy,TransactionObserver.NONE,config); }
    // Package-private existing observer is available only to same-package tests.
    static LocalHttpServer start(LocalLaunchConfig config, TransactionObserver observer) {
        return start(config,observer,null);
    }
    private static LocalHttpServer start(LocalLaunchConfig config,TransactionObserver observer,PartnerLaunchConfig partner) {
        HikariDataSource source = config.database.openPool(); LocalHttpServer result = null;
        try {
            // Even getWebServer/factory construction can bind: do not create either
            // until the complete immutable config and actual DB readiness passed.
            DatabaseReadiness.requireReady(source);
            result = new LocalHttpServer(source);
            result.bind(config, observer,partner);
            return result;
        } catch (Exception failure) {
            if (result != null) result.close(); else source.close();
            throw new IllegalStateException("HTTP_STARTUP");
        }
    }
    private void bind(LocalLaunchConfig config, TransactionObserver observer,PartnerLaunchConfig partnerConfig) throws Exception {
        for (Logger logger : QUIET_LOGGERS) logger.setLevel(Level.OFF);
        StandardEnvironment environment = new StandardEnvironment();
        environment.getPropertySources().remove(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME);
        environment.getPropertySources().remove(StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME);
        context.setEnvironment(environment);
        BotHttpHandler handler = new BotHttpHandler(new BotApplication(source, config.identity, observer), new TaskApplication(source, config.identity, observer));
        PartnerHttpHandler partner=partnerConfig==null?null:new PartnerHttpHandler(partnerConfig,source);
        TomcatServletWebServerFactory factory = new TomcatServletWebServerFactory() {
            @Override protected TomcatWebServer getTomcatWebServer(Tomcat tomcat) {
                ((StandardHost)tomcat.getHost()).setErrorReportValveClass(null);
                return super.getTomcatWebServer(tomcat);
            }
        };
        factory.setAddress(InetAddress.getByAddress(new byte[]{127, 0, 0, 1})); factory.setPort(0);
        factory.setBaseDirectory(new File(".")); factory.setRegisterDefaultServlet(false); factory.getJsp().setRegistered(false);
        factory.setDisableMBeanRegistry(true); factory.addContextValves(new ProtocolHeadValve());
        factory.addConnectorCustomizers(connector -> {
            if (!(connector.getProtocolHandler() instanceof Http11NioProtocol)) throw new IllegalStateException("HTTP_CONNECTOR");
            connector.setAllowTrace(false); connector.setXpoweredBy(false); connector.setEncodedSolidusHandling("reject");
            ClosedMethodAdapter.install(connector);
            Http11NioProtocol protocol = (Http11NioProtocol)connector.getProtocolHandler();
            protocol.setExecutor(workers); protocol.setMaxConnections(32); protocol.setAcceptCount(32);
            protocol.setMaxThreads(8); protocol.setMinSpareThreads(8); protocol.setMaxHeaderCount(32); protocol.setMaxHttpRequestHeaderSize(8192);
            protocol.setConnectionTimeout(2000); protocol.setKeepAliveTimeout(2000); protocol.setConnectionUploadTimeout(2000); protocol.setDisableUploadTimeout(false);
            protocol.setRejectIllegalHeader(true); protocol.setMaxSwallowSize(0); protocol.setMaxTrailerSize(0);
            protocol.setAllowedTrailerHeaders(""); protocol.setCompression("off"); protocol.setUseSendfile(false);
        });
        server = factory.getWebServer(servletContext -> {
            servletContext.setSessionTrackingModes(Collections.emptySet()); context.setServletContext(servletContext);
            SimpleUrlHandlerMapping mapping = new SimpleUrlHandlerMapping(); mapping.setUrlMap(Collections.singletonMap("/**", handler)); mapping.setOrder(0);
            context.getBeanFactory().registerSingleton("handlerMapping", mapping);
            context.getBeanFactory().registerSingleton("handlerAdapter", new HttpRequestHandlerAdapter());
            context.refresh(); mapping.setApplicationContext(context);
            DispatcherServlet dispatcher = new DispatcherServlet(context);
            ServletRegistration.Dynamic registration = servletContext.addServlet("bot-contract", dispatcher);
            registration.setLoadOnStartup(1); registration.addMapping("/");
            FilterRegistration.Dynamic gate = servletContext.addFilter("raw-contract-gate", new RawRequestGate(config.identity,partner));
            gate.setAsyncSupported(false); gate.addMappingForUrlPatterns(EnumSet.of(DispatcherType.REQUEST), false, "/*");
        });
        server.start();
    }
    public int port() { if (server == null || closed.get()) throw new IllegalStateException("HTTP_STOPPED"); return server.getPort(); }
    @Override public void close() {
        if (!closed.compareAndSet(false, true)) return;
        try { if (server != null) server.stop(); }
        finally {
            try { if (context.isActive()) context.close(); }
            finally { workers.shutdownNow(); try { workers.awaitTermination(2, TimeUnit.SECONDS); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); } finally { source.close(); } }
        }
    }
}
