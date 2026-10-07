package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.CanonicalCommand;
import com.devclaw.botcontrol.persistence.JdbcApplicationStore;
import com.devclaw.botcontrol.ports.TransactionObserver;
import com.devclaw.botcontrol.validation.ContractBoundary;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class TaskUnitTest {
    final ContractBoundary boundary = new ContractBoundary();
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
