package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.application.GroupMemoryValues.*;
import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.contracts.BotContracts.ErrorCode;
import com.devclaw.botcontrol.domain.ApplicationFault;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class GroupMemoryUnitTest {
    private static Source source(String json)throws Exception{return GroupMemoryValues.source(CompatibilityProbe.strictMapper().readTree(json));}
    private static Memory memory(String id,String text,String status)throws Exception{return new Memory(id,"A","g",1,text,status,source("{\"kind\":\"manual\"}"),"owner","owner","2026-10-12T12:00:00.000Z","2026-10-12T12:00:00.000Z");}
    private static String repeated(String text,int count){return String.join("",Collections.nCopies(count,text));}
    @Test void sourceIsClosedAndDoesNotAcceptAuthorUrlOrOtherScope()throws Exception {
        assertEquals("{\"kind\":\"manual\"}",GroupMemoryValues.encode(source("{\"kind\":\"manual\"}")));
        assertEquals(3L,source("{\"kind\":\"task\",\"taskId\":\"task\",\"taskVersion\":3}").taskVersion.longValue());
        assertEquals("run",source("{\"kind\":\"result\",\"runId\":\"run\"}").runId);
        for(String json:Arrays.asList("null","[]","{\"kind\":\"manual\",\"author\":\"other\"}","{\"kind\":\"url\",\"url\":\"https://invalid.test\"}","{\"kind\":\"task\",\"taskId\":\"task\",\"taskVersion\":0}","{\"kind\":\"result\",\"runId\":\"run\",\"spaceId\":\"B\"}"))assertThrows(ApplicationFault.class,()->source(json));
    }
    @Test void textUsesUtf16AndRejectsNulUnpairedSurrogatesAndBlankUnicode(){
        assertEquals(512,GroupMemoryValues.text(repeated("🚀",256)).length());
        for(String text:Arrays.asList(""," ","\u00a0\ufeff",repeated("🚀",257),"nul\u0000", "\ud800", "\udc00", "x\ud800y"))assertThrows(ApplicationFault.class,()->GroupMemoryValues.text(text));
        assertEquals("中文<&>`",GroupMemoryValues.text("中文<&>`"));
    }
    @Test void budgetMatchesLiteralEscapesAndCountsWrappingUtf16()throws Exception {
        List<Memory> one=Collections.singletonList(memory("m1","<&>`🚀","active"));
        String exact="[{\"scope\":\"group\",\"sourceRef\":\"memory:m1:v1\",\"text\":\"\\u003c\\u0026\\u003e\\u0060🚀\"}]";
        assertEquals(exact.length(),GroupMemoryValues.budget(one));
        List<Memory> values=new ArrayList<Memory>();for(int i=0;i<3;i++)values.add(memory("m"+i,repeated("<",512),"active"));assertTrue(GroupMemoryValues.budget(values)<=10000);
        values.add(memory("m3",repeated("<",512),"active"));assertEquals(ErrorCode.PAYLOAD_TOO_LARGE,assertThrows(ApplicationFault.class,()->GroupMemoryValues.budget(values)).code);
        assertEquals(2,GroupMemoryValues.budget(Collections.singletonList(memory("m","<","disabled"))));
    }
    @Test void snapshotIsClosedScopedSortedUniqueActiveAndNullIsExplicit()throws Exception {
        assertNull(GroupMemoryValues.decodeSnapshot("null","A","g"));
        Snapshot empty=new Snapshot(0,Collections.emptyList());assertEquals("{\"revision\":0,\"memories\":[]}",GroupMemoryValues.encode(empty));
        Snapshot snapshot=new Snapshot(1,Collections.singletonList(memory("m","saved","active")));String json=GroupMemoryValues.encode(snapshot);
        assertEquals(json,GroupMemoryValues.encode(GroupMemoryValues.decodeSnapshot(json,"A","g")));
        assertThrows(ApplicationFault.class,()->GroupMemoryValues.decodeSnapshot(json,"B","g"));
        assertThrows(ApplicationFault.class,()->GroupMemoryValues.decodeSnapshot(json,"A","other"));
        assertThrows(ApplicationFault.class,()->new Snapshot(1,Arrays.asList(memory("m","one","active"),memory("m","two","active"))));
        assertThrows(ApplicationFault.class,()->new Snapshot(1,Collections.singletonList(memory("m","one","disabled"))));
        assertThrows(ApplicationFault.class,()->GroupMemoryValues.decodeSnapshot("{\"revision\":0,\"memories\":[],\"author\":\"owner\"}","A","g"));
    }
    @Test void storedAndActiveBoundsVersionAndReceiptRoundtrip()throws Exception {
        List<Memory> values=new ArrayList<Memory>();for(int i=0;i<100;i++)values.add(memory(String.format(Locale.ROOT,"m%03d",i),"saved",i<10?"active":"disabled"));GroupMemoryValues.validateMemories(values,false);
        values.add(memory("z","extra","disabled"));assertEquals(ErrorCode.PAYLOAD_TOO_LARGE,assertThrows(ApplicationFault.class,()->GroupMemoryValues.validateMemories(values,false)).code);
        List<Memory> active=new ArrayList<Memory>();for(int i=0;i<11;i++)active.add(memory(String.format(Locale.ROOT,"m%02d",i),"saved","active"));assertThrows(ApplicationFault.class,()->GroupMemoryValues.validateMemories(active,false));
        Changed value=new Changed(1,memory("m","saved","active"));assertEquals(GroupMemoryValues.encode(value),GroupMemoryValues.encode(GroupMemoryValues.decodeChanged(GroupMemoryValues.encode(value))));
        assertThrows(ApplicationFault.class,()->GroupMemoryValues.version(9007199254740992L,0));
    }
}
