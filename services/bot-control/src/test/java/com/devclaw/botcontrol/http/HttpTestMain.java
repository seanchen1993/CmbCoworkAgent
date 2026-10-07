package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.adapters.local.LocalLaunchConfig;
import com.devclaw.botcontrol.ports.TransactionObserver;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.CountDownLatch;

/** Test classpath only: finite constructor observers and bounded stdin controls. */
public final class HttpTestMain {
    private HttpTestMain() { }
    private static byte[] line(int maximum, long deadlineMs) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); long started = System.nanoTime();
        while (System.nanoTime() - started < deadlineMs * 1000000L) {
            if (System.in.available() == 0) { Thread.sleep(5); continue; }
            int value = System.in.read(); if (value == -1) throw new IllegalStateException("TEST_CONTROL");
            if (value == '\n') return bytes.toByteArray();
            if (bytes.size() == maximum) throw new IllegalStateException("TEST_CONTROL"); bytes.write(value);
        }
        throw new IllegalStateException("TEST_CONTROL");
    }
    private static synchronized void control(String expected) {
        try { if (!expected.equals(new String(line(32, 15000), StandardCharsets.US_ASCII))) throw new IllegalStateException("TEST_CONTROL"); }
        catch (Exception failure) { throw new IllegalStateException("TEST_CONTROL"); }
    }
    private static void stage(String stage) { System.out.println("{\"stage\":\"" + stage + "\"}"); System.out.flush(); }
    public static void main(String[] args) {
        try {
            if (args.length != 1 || !Arrays.asList("serve", "race-same", "race-cas", "partial-version", "partial-members", "before-receipt", "before-commit", "lost-response").contains(args[0])) throw new IllegalStateException("TEST_SELECTION");
            LocalLaunchConfig config = LocalLaunchConfig.parse(line(LocalLaunchConfig.MAX_BYTES, 15000)); String mode = args[0]; AtomicBoolean observed = new AtomicBoolean();
            TransactionObserver observer = reached -> {
                if (mode.equals("race-same") && reached == TransactionObserver.Stage.BEFORE_SCOPE && observed.compareAndSet(false, true)) { stage("before-scope"); control("go"); }
                if (mode.equals("race-cas") && reached == TransactionObserver.Stage.SCOPE_LOCKED && observed.compareAndSet(false, true)) { stage("scoped"); control("commit-go"); }
                if ((mode.equals("partial-version") && reached == TransactionObserver.Stage.VERSION_WRITTEN) || (mode.equals("partial-members") && reached == TransactionObserver.Stage.MEMBER_WRITTEN) ||
                    (mode.equals("before-receipt") && reached == TransactionObserver.Stage.BEFORE_RECEIPT) || (mode.equals("before-commit") && reached == TransactionObserver.Stage.BEFORE_COMMIT)) throw new IllegalStateException("TEST_INJECTED");
                if (mode.equals("lost-response") && reached == TransactionObserver.Stage.AFTER_COMMIT && observed.compareAndSet(false, true)) { stage("committed"); control("response-go"); }
            };
            try (LocalHttpServer server = LocalHttpServer.start(config, observer)) {
                CountDownLatch stopped = new CountDownLatch(1);
                Runtime.getRuntime().addShutdownHook(new Thread(() -> { try { server.close(); } finally { stopped.countDown(); } }, "test-http-stop"));
                System.out.println("{\"stage\":\"http-ready\",\"port\":" + server.port() + "}"); System.out.flush();
                stopped.await();
            }
        } catch (Exception failure) { System.out.println("{\"status\":\"failed\",\"reason\":\"HTTP_TEST_BOUNDARY\"}"); System.exit(1); }
    }
}
