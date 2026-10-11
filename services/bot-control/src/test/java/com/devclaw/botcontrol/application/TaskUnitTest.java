package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.CanonicalCommand;
import com.devclaw.botcontrol.persistence.JdbcApplicationStore;
import com.devclaw.botcontrol.ports.TransactionObserver;
import com.devclaw.botcontrol.validation.ContractBoundary;
import java.lang.reflect.Proxy;
import java.sql.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class TaskUnitTest {
    final ContractBoundary boundary = new ContractBoundary();
    @Test void unknownCursorRemainsNullableAndReturns410WithRollback() {
        AtomicInteger rollbacks = new AtomicInteger(), commits = new AtomicInteger();
        Connection connection = (Connection)Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{Connection.class}, (c, method, args) -> {
            if (method.getName().equals("rollback")) { rollbacks.incrementAndGet(); return null; }
            if (method.getName().equals("commit")) { commits.incrementAndGet(); return null; }
            if (Arrays.asList("setTransactionIsolation", "setAutoCommit", "close").contains(method.getName())) return null;
            if (!method.getName().equals("prepareStatement")) throw new AssertionError(method.getName());
            String sql = (String)args[0];
            assertTrue(sql.startsWith("INSERT INTO task_space_head") || sql.startsWith("SELECT event_seq,task_number") || sql.equals("SELECT UTC_TIMESTAMP(3)") || sql.startsWith("SELECT high_water,created_at,expires_at"));
            return Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{PreparedStatement.class}, (p, pm, pa) -> {
                if (pm.getName().startsWith("set") || pm.getName().equals("close")) return null;
                if (pm.getName().equals("executeUpdate")) return 1;
                if (!pm.getName().equals("executeQuery")) throw new AssertionError(pm.getName());
                AtomicInteger rows = new AtomicInteger();
                return Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{ResultSet.class}, (r, rm, ra) -> {
                    if (rm.getName().equals("next")) return !sql.startsWith("SELECT high_water") && rows.getAndIncrement() == 0;
                    if (rm.getName().equals("getLong")) return 0L;
                    if (rm.getName().equals("getTimestamp")) return Timestamp.from(java.time.Instant.parse("2026-10-11T00:00:00Z"));
                    if (rm.getName().equals("close")) return null;
                    throw new AssertionError(rm.getName());
                });
            });
        });
        DataSource source = (DataSource)Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{DataSource.class}, (s, method, args) -> {
            if (method.getName().equals("getConnection")) return connection;
            throw new AssertionError(method.getName());
        });
        ApplicationResponse response = new TaskApplication(source, ApplicationUnitTest.policy(true), TransactionObserver.NONE)
            .execute(Operation.GET_EVENTS, ApplicationUnitTest.ACTOR, null, "unknown", null, null);
        assertEquals(410, response.status);
        assertEquals(ErrorCode.CURSOR_EXPIRED, boundary.readResponse("getEvents", 410, response.body(), ErrorResponse.class).error.code);
        assertEquals(1, rollbacks.get()); assertEquals(0, commits.get());
    }
    @Test void fourSelectorsHaveClosedSourceErrorsBeforeDatabase() {
        AtomicInteger calls = new AtomicInteger(); TaskApplication app = new TaskApplication(ApplicationUnitTest.unavailable(calls), ApplicationUnitTest.policy(true), TransactionObserver.NONE);
        for (Operation op : Operation.values()) if (op.task()) {
            String id = op == Operation.GET_TASK || op == Operation.CREATE_TASK_MESSAGE ? "task" : null;
            ApplicationResponse r = app.execute(op, null, id, null, null, null); assertEquals(401, r.status); boundary.readResponse(op.wire, 401, r.body(), ErrorResponse.class);
            r = app.execute(op, ApplicationUnitTest.ACTOR, id, null, null, ApplicationUnitTest.bytes("{}")); assertEquals(400, r.status); boundary.readResponse(op.wire, 400, r.body(), ErrorResponse.class);
            r = app.execute(op, ApplicationUnitTest.ACTOR, id, null, null, new byte[1048577]); assertEquals(op.write() ? 413 : 400, r.status); boundary.readResponse(op.wire, r.status, r.body(), ErrorResponse.class);
        }
        for (long limit : new long[]{0, 201, Long.MAX_VALUE}) assertEquals(400, app.execute(Operation.GET_EVENTS, ApplicationUnitTest.ACTOR, null, null, limit, null).status);
        assertEquals(400, app.execute(Operation.GET_TASK, ApplicationUnitTest.ACTOR, "task", "cursor", null, null).status);
        assertEquals(0, calls.get());
        assertEquals(503, app.execute(Operation.GET_EVENTS, ApplicationUnitTest.ACTOR, null, null, 200L, null).status); assertEquals(1, calls.get());
    }
    @Test void typedMessageCanonicalIntegersPathsAndTextRemainExact() {
        byte[] fingerprint = null;
        for (String number : Arrays.asList("1", "1.0", "1e0")) {
            CreateTaskMessageRequest value = boundary.readRequest("createTaskMessage", ApplicationUnitTest.bytes("{\"commandId\":\"c\",\"expectedVersion\":" + number + ",\"text\":\"中文\\ud800\\u0000🚀\",\"artifactVersions\":[]}"), CreateTaskMessageRequest.class);
            assertEquals(Long.valueOf(1), value.expectedVersion); assertTrue(value.text.contains("\ud800"));
            byte[] actual = CanonicalCommand.fingerprint(ApplicationUnitTest.ACTOR, Operation.CREATE_TASK_MESSAGE, "task", value);
            if (fingerprint == null) fingerprint = actual; else assertArrayEquals(fingerprint, actual);
            assertFalse(Arrays.equals(actual, CanonicalCommand.fingerprint(ApplicationUnitTest.ACTOR, Operation.CREATE_TASK_MESSAGE, "Task", value)));
            value.expectedVersion = 2L; assertFalse(Arrays.equals(actual, CanonicalCommand.fingerprint(ApplicationUnitTest.ACTOR, Operation.CREATE_TASK_MESSAGE, "task", value)));
        }
        CreateTaskRequest r = new CreateTaskRequest(); r.commandId = "c"; r.groupId = "g"; r.title = "title"; r.goal = "goal"; r.inputArtifactVersions = Collections.emptyList();
        assertEquals("g", boundary.readRequest("createTask", JdbcApplicationStore.json(r), CreateTaskRequest.class).groupId);
    }
    @Test void inactiveMemberCannotReachConnectionEvenWithValidNewRequest() {
        AtomicInteger calls = new AtomicInteger(); TaskApplication app = new TaskApplication(ApplicationUnitTest.unavailable(calls), ApplicationUnitTest.policy(false), TransactionObserver.NONE);
        byte[] request = ApplicationUnitTest.bytes("{\"commandId\":\"c\",\"groupId\":\"g\",\"title\":\"t\",\"goal\":\"g\",\"inputArtifactVersions\":[]}");
        ApplicationResponse response = app.execute(Operation.CREATE_TASK, ApplicationUnitTest.ACTOR, null, null, null, request);
        assertEquals(403, response.status); boundary.readResponse("createTask", 403, response.body(), ErrorResponse.class); assertEquals(0, calls.get());
    }
}
