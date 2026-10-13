package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.contracts.BotContracts.ErrorCode;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.persistence.JdbcTaskStore;
import com.devclaw.botcontrol.validation.ContractBoundary;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.time.Instant;
import java.time.format.DateTimeFormatterBuilder;
import java.util.*;

/** Private closed DTOs, independent of the frozen public contract graph. */
public final class GroupMemoryValues {
    private GroupMemoryValues() {}
    private static final ObjectMapper JSON = CompatibilityProbe.strictMapper();
    private static final ContractBoundary BOUNDARY = new ContractBoundary();
    private static ApplicationFault invalid() { return new ApplicationFault(ErrorCode.INVALID_PAYLOAD); }
    public static String id(String value) {
        try { return BOUNDARY.validateParameter("getBot", "botId", value); }
        catch (ContractBoundary.Failure failure) { throw new ApplicationFault(failure.category()==ContractBoundary.Category.SCHEMA_RESOURCE?ErrorCode.DEPENDENCY_UNAVAILABLE:ErrorCode.INVALID_PAYLOAD); }
    }
    public static long version(long value, long minimum) { if(value<minimum||value>JdbcTaskStore.MAX)throw invalid();return value; }
    public static String text(String value) {
        if(value==null||value.matches("[\\x09-\\x0D \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*")||value.length()>512)throw invalid();
        for(int i=0;i<value.length();i++){char ch=value.charAt(i);if(Character.isHighSurrogate(ch)){if(++i>=value.length()||!Character.isLowSurrogate(value.charAt(i)))throw invalid();}else if(ch==0||Character.isLowSurrogate(ch))throw invalid();}
        return value;
    }
    public static String status(String value) { if(!Arrays.asList("active","disabled").contains(value))throw invalid();return value; }
    public static String date(Instant value) { return new DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(value); }
    private static String date(String value) { if(value==null||!value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z"))throw invalid();try{if(!date(Instant.parse(value)).equals(value))throw invalid();}catch(RuntimeException f){throw invalid();}return value; }
    private static void exact(JsonNode node,String... fields) { Set<String> names=new HashSet<String>();if(node==null||!node.isObject())throw invalid();node.fieldNames().forEachRemaining(names::add);if(!names.equals(new HashSet<String>(Arrays.asList(fields))))throw invalid(); }
    private static String string(JsonNode node,String field) { JsonNode value=node.get(field);if(value==null||!value.isTextual())throw invalid();return value.textValue(); }
    private static long number(JsonNode node,String field,long minimum) { JsonNode value=node.get(field);if(value==null||!value.isIntegralNumber()||!value.canConvertToLong())throw invalid();return version(value.longValue(),minimum); }
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class Source {
        public final String kind,taskId,runId;public final Long taskVersion;
        private Source(String kind,String taskId,Long taskVersion,String runId){this.kind=kind;this.taskId=taskId;this.taskVersion=taskVersion;this.runId=runId;}
    }
    public static Source source(JsonNode node) {
        if(node==null||!node.isObject())throw invalid();String kind=string(node,"kind");
        switch(kind){case "manual":exact(node,"kind");return new Source(kind,null,null,null);
            case "task":exact(node,"kind","taskId","taskVersion");return new Source(kind,id(string(node,"taskId")),number(node,"taskVersion",1),null);
            case "result":exact(node,"kind","runId");return new Source(kind,null,null,id(string(node,"runId")));
            default:throw invalid();}
    }
    public static final class Memory {
        public final String id,spaceId,groupId,text,status,createdBy,updatedBy,createdAt,updatedAt;
        public final long version;public final Source source;
        public Memory(String id,String space,String group,long version,String text,String status,Source source,String createdBy,String updatedBy,String createdAt,String updatedAt){
            this.id=GroupMemoryValues.id(id);spaceId=GroupMemoryValues.id(space);groupId=GroupMemoryValues.id(group);this.version=GroupMemoryValues.version(version,1);this.text=GroupMemoryValues.text(text);this.status=GroupMemoryValues.status(status);
            this.source=GroupMemoryValues.source(JSON.valueToTree(source));this.createdBy=GroupMemoryValues.id(createdBy);this.updatedBy=GroupMemoryValues.id(updatedBy);this.createdAt=date(createdAt);this.updatedAt=date(updatedAt);
            if(Instant.parse(updatedAt).isBefore(Instant.parse(createdAt)))throw invalid();
        }
    }
    private static Memory memory(JsonNode n) {
        exact(n,"id","spaceId","groupId","version","text","status","source","createdBy","updatedBy","createdAt","updatedAt");
        return new Memory(string(n,"id"),string(n,"spaceId"),string(n,"groupId"),number(n,"version",1),string(n,"text"),string(n,"status"),source(n.get("source")),string(n,"createdBy"),string(n,"updatedBy"),string(n,"createdAt"),string(n,"updatedAt"));
    }
    public static final class Snapshot {
        public final long revision;public final List<Memory> memories;
        public Snapshot(long revision,List<Memory> memories){this.revision=version(revision,0);this.memories=Collections.unmodifiableList(new ArrayList<Memory>(memories));validateMemories(this.memories,true);for(Memory memory:this.memories)if(memory.version>revision)throw invalid();budget(this.memories);}
    }
    public static final class Changed {
        public final long revision;public final Memory memory;
        public Changed(long revision,Memory memory){this.revision=version(revision,1);this.memory=memory;}
    }
    public static String encode(Object value) { try{return JSON.writeValueAsString(value);}catch(Exception failure){throw invalid();} }
    public static Source decodeSource(String value) { try{return source(JSON.readTree(value));}catch(Exception failure){throw invalid();} }
    public static Changed decodeChanged(String value) { try{JsonNode node=JSON.readTree(value);exact(node,"revision","memory");return new Changed(number(node,"revision",1),memory(node.get("memory")));}catch(Exception failure){throw invalid();} }
    public static Snapshot decodeSnapshot(String value,String space,String group) {
        try{JsonNode node=JSON.readTree(value);if(node==null)throw invalid();if(node.isNull())return null;exact(node,"revision","memories");JsonNode values=node.get("memories");if(!values.isArray()||values.size()>10)throw invalid();
            List<Memory> memories=new ArrayList<Memory>();for(JsonNode item:values){Memory memory=memory(item);if(!space.equals(memory.spaceId)||!group.equals(memory.groupId))throw invalid();memories.add(memory);}return new Snapshot(number(node,"revision",0),memories);
        }catch(Exception failure){throw invalid();}
    }
    public static void validateMemories(List<Memory> memories,boolean activeOnly) {
        if(memories.size()>(activeOnly?10:100))throw new ApplicationFault(ErrorCode.PAYLOAD_TOO_LARGE);String previous=null;int active=0;
        for(Memory memory:memories){if(previous!=null&&previous.compareTo(memory.id)>=0)throw invalid();previous=memory.id;if("active".equals(memory.status))active++;else if(activeOnly)throw invalid();}
        if(active>10)throw new ApplicationFault(ErrorCode.PAYLOAD_TOO_LARGE);
    }
    /** Matches JS JSON.stringify followed by <,>,&,backtick -> literal Unicode escapes;
     * Java String.length intentionally measures UTF-16, not code points/UTF-8 bytes. */
    public static int budget(List<Memory> memories) {
        ArrayNode values=JSON.createArrayNode();for(Memory memory:memories)if("active".equals(memory.status))values.add(JSON.createObjectNode().put("scope","group").put("sourceRef","memory:"+memory.id+":v"+memory.version).put("text",memory.text));
        String encoded=encode(values);int length=encoded.length();for(int i=0;i<encoded.length();i++)if("<>&`".indexOf(encoded.charAt(i))>=0)length+=5;
        if(length>10000)throw new ApplicationFault(ErrorCode.PAYLOAD_TOO_LARGE);return length;
    }
}
