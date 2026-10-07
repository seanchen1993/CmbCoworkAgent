package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.application.Operation;
import java.util.Arrays;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class TaskHttpBoundaryTest {
    @Test void eventsAloneAcceptsFiniteOnceDecodedSelectors() {
        RawRoute route = RawRoute.select("GET", "/api/bot/v1/events", "limit=%32%30%30&after=cursor%3AA.b");
        assertEquals(Operation.GET_EVENTS, route.operation); assertEquals(Long.valueOf(200), route.limit); assertEquals("cursor:A.b", route.after);
        assertNull(RawRoute.select("GET", "/api/bot/v1/events", null).limit);
        for (String bad : Arrays.asList("", "after=", "limit=0", "limit=201", "limit=1.0", "limit=1e0", "limit=01", "limit=-1", "limit=1&limit=2", "after=a&after=b", "x=1", "%6cimit=1", "after=%253A", "after=%３Ａ", "after=%", "after=x+z", "limit=1&"))
            assertThrows(HttpFailure.class, () -> RawRoute.select("GET", "/api/bot/v1/events", bad), bad);
        assertThrows(HttpFailure.class, () -> RawRoute.select("GET", "/api/bot/v1/tasks/id", "limit=1"));
        assertThrows(HttpFailure.class, () -> RawRoute.select("POST", "/api/bot/v1/tasks/messages", null));
    }
}
