package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.adapters.local.LocalLaunchConfig;
import java.util.concurrent.CountDownLatch;

/** Production stdin is exactly one full config document through EOF; no controls. */
public final class LocalHttpMain {
    private LocalHttpMain() { }
    public static void main(String[] args) {
        try {
            if (args.length != 0) throw new IllegalArgumentException("HTTP_ARGUMENTS");
            LocalLaunchConfig config = LocalLaunchConfig.read(System.in);
            LocalHttpServer server = LocalHttpServer.start(config); CountDownLatch stopped = new CountDownLatch(1);
            Runtime.getRuntime().addShutdownHook(new Thread(() -> { try { server.close(); } finally { stopped.countDown(); } }, "bot-http-stop"));
            System.out.println("{\"stage\":\"http-ready\",\"port\":" + server.port() + "}"); System.out.flush();
            stopped.await();
        } catch (Exception failure) { System.out.println("{\"status\":\"failed\",\"reason\":\"HTTP_STARTUP\"}"); System.exit(1); }
    }
}
