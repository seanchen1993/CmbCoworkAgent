package com.devclaw.botcontrol.persistence;

import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.validation.ContractBoundary;
import java.sql.*;
import java.util.*;

/** Task SQL only; caller locks command scope -> space head -> sorted Groups -> Task. */
public final class JdbcTaskStore {
    public static final long MAX = 9007199254740991L;
    private static final ContractBoundary BOUNDARY = new ContractBoundary();
    private final Connection c; private final String space;
    public JdbcTaskStore(Connection c, String space) { this.c = c; this.space = space; }
    private static Calendar utc() { return Calendar.getInstance(TimeZone.getTimeZone("UTC")); }
    private PreparedStatement prepare(String sql, Object... values) throws SQLException {
        PreparedStatement p = c.prepareStatement(sql);
        try {
            p.setQueryTimeout(2);
            for (int i = 0; i < values.length; i++) {
                Object v = values[i];
                if (v instanceof byte[]) p.setBytes(i + 1, (byte[])v);
                else if (v instanceof Timestamp) p.setTimestamp(i + 1, (Timestamp)v, utc());
                else p.setObject(i + 1, v);
            }
            return p;
        } catch (SQLException failure) { p.close(); throw failure; }
    }
    private void change(String sql, Object... values) throws SQLException {
        try (PreparedStatement p = prepare(sql, values)) { if (p.executeUpdate() != 1) throw JdbcApplicationStore.corrupt(); }
    }
    public long lockHead() throws SQLException {
        try (PreparedStatement p = prepare("INSERT INTO task_space_head(space_id,event_seq,task_number) VALUES(?,0,0) ON DUPLICATE KEY UPDATE space_id=VALUES(space_id)", space)) { p.executeUpdate(); }
        try (PreparedStatement p = prepare("SELECT event_seq,task_number FROM task_space_head WHERE space_id=? FOR UPDATE", space); ResultSet r = p.executeQuery()) {
            if (!r.next()) throw JdbcApplicationStore.corrupt(); long seq = r.getLong(1), number = r.getLong(2);
            if (seq < 0 || seq > MAX || number < 0 || number > MAX || r.next()) throw JdbcApplicationStore.corrupt(); return seq;
        }
    }
    public String nextNumber() throws SQLException {
        try (PreparedStatement p = prepare("SELECT task_number FROM task_space_head WHERE space_id=? FOR UPDATE", space); ResultSet r = p.executeQuery()) {
            if (!r.next()) throw JdbcApplicationStore.corrupt(); long old = r.getLong(1);
            if (old < 0 || old >= MAX || r.next()) throw JdbcApplicationStore.corrupt();
            change("UPDATE task_space_head SET task_number=? WHERE space_id=? AND task_number=?", old + 1, space, old); return "TASK-" + (old + 1);
        }
    }
    // Metadata locators expose no persisted body and are followed by current Group authorization.
    public String groupId(String id) throws SQLException {
        try (PreparedStatement p = prepare("SELECT group_id FROM tasks WHERE space_id=? AND id=?", space, id); ResultSet r = p.executeQuery()) {
            if (!r.next()) return null; String group = r.getString(1); if (group == null || r.next()) throw JdbcApplicationStore.corrupt(); return group;
        }
    }
    public String messageTask(String id) throws SQLException {
        try (PreparedStatement p = prepare("SELECT task_id FROM task_messages WHERE space_id=? AND id=?", space, id); ResultSet r = p.executeQuery()) {
            if (!r.next()) throw JdbcApplicationStore.corrupt(); String task = r.getString(1); if (task == null || r.next()) throw JdbcApplicationStore.corrupt(); return task;
        }
    }
    public Task task(String id) throws SQLException {
        try (PreparedStatement p = prepare("SELECT group_id,version,task_number,body_bytes FROM tasks WHERE space_id=? AND id=? FOR UPDATE", space, id); ResultSet r = p.executeQuery()) {
            if (!r.next()) return null;
            try {
                Task value = BOUNDARY.readResponse("createTask", 201, r.getBytes(4), TaskResult.class).task;
                if (!space.equals(value.spaceId) || !id.equals(value.id) || !r.getString(1).equals(value.groupId) || r.getLong(2) != value.version || !r.getString(3).equals(value.taskNumber) || r.next()) throw JdbcApplicationStore.corrupt();
                if (value.status != TaskStatus.ACTIVE || !value.inputArtifactVersions.isEmpty() || value.stages.size() != StageKind.values().length || !value.currentStageId.equals(value.stages.get(0).id)) throw JdbcApplicationStore.corrupt();
                Set<String> stageIds = new HashSet<String>();
                for (int i = 0; i < value.stages.size(); i++) {
                    Stage stage = value.stages.get(i);
                    if (!stageIds.add(stage.id) || stage.kind != StageKind.values()[i] || stage.status != (i == 0 ? StageStatus.ACTIVE : StageStatus.PENDING) || !stage.inputArtifactVersions.isEmpty() || !stage.outputArtifactVersions.isEmpty()) throw JdbcApplicationStore.corrupt();
                }
                return value;
            } catch (ContractBoundary.Failure failure) { throw JdbcApplicationStore.corrupt(); }
        }
    }
    private static byte[] taskBytes(Task task) { TaskResult result = new TaskResult(); result.task = task; return BOUNDARY.writeResponse("createTask", 201, result); }
    public void create(Task task) throws SQLException {
        change("INSERT INTO tasks(space_id,id,group_id,version,task_number,body_bytes) VALUES(?,?,?,?,?,?)", space, task.id, task.groupId, task.version, task.taskNumber, taskBytes(task));
    }
    public void advance(Task task, long expected) throws SQLException {
        change("UPDATE tasks SET version=?,body_bytes=? WHERE space_id=? AND id=? AND version=?", task.version, taskBytes(task), space, task.id, expected);
    }
    public void message(TaskMessageResult value, String target) throws SQLException {
        TaskMessage m = value.message;
        change("INSERT INTO task_messages(space_id,id,task_id,author_principal_id,task_version,target_bot_id,body_bytes) VALUES(?,?,?,?,?,?,?)", space, m.id, m.taskId, m.authorPrincipalId, value.taskVersion, target, BOUNDARY.writeResponse("createTaskMessage", 201, value));
    }
    public TaskMessageResult message(String id) throws SQLException {
        try (PreparedStatement p = prepare("SELECT task_id,author_principal_id,task_version,body_bytes FROM task_messages WHERE space_id=? AND id=? FOR UPDATE", space, id); ResultSet r = p.executeQuery()) {
            if (!r.next()) throw JdbcApplicationStore.corrupt();
            try {
                TaskMessageResult value = BOUNDARY.readResponse("createTaskMessage", 201, r.getBytes(4), TaskMessageResult.class); TaskMessage m = value.message;
                if (!space.equals(m.spaceId) || !id.equals(m.id) || !r.getString(1).equals(m.taskId) || !r.getString(2).equals(m.authorPrincipalId) || r.getLong(3) != value.taskVersion || r.next()) throw JdbcApplicationStore.corrupt();
                return value;
            } catch (ContractBoundary.Failure failure) { throw JdbcApplicationStore.corrupt(); }
        }
    }
    /** Internal input-only requirement view. Caller already holds the current
     * authorized Group/Task locks; never a whole-group or personal-history read.
     * LIMIT 51 detects excess and fails, it never truncates accepted context. */
    public List<TaskMessageResult> requirementMessages(Task task, String botId) throws SQLException {
        if(task==null||!space.equals(task.spaceId)||task.version<1||task.version>MAX||botId==null)throw JdbcApplicationStore.corrupt();
        long characters=(long)task.title.length()+task.goal.length();
        if(characters>60000)throw new ApplicationFault(ErrorCode.RATE_LIMITED);
        List<TaskMessageResult> result=new ArrayList<TaskMessageResult>();
        try(PreparedStatement p=prepare("SELECT id,task_version,author_principal_id FROM task_messages WHERE space_id=? AND task_id=? AND task_version<=? AND (target_bot_id IS NULL OR target_bot_id=?) ORDER BY task_version LIMIT 51",space,task.id,task.version,botId);ResultSet r=p.executeQuery()){
            long previous=1;
            while(r.next()){
                if(result.size()==50)throw new ApplicationFault(ErrorCode.RATE_LIMITED);
                TaskMessageResult value=message(r.getString(1));
                if(!task.id.equals(value.message.taskId)||!space.equals(value.message.spaceId)||!r.getString(3).equals(value.message.authorPrincipalId)||value.taskVersion!=r.getLong(2)||value.taskVersion<=previous||value.taskVersion>task.version)throw JdbcApplicationStore.corrupt();
                if(!value.message.artifactVersions.isEmpty())throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);
                characters+=value.message.text.length();if(characters>60000)throw new ApplicationFault(ErrorCode.RATE_LIMITED);
                previous=value.taskVersion;result.add(value);
            }
        }
        return Collections.unmodifiableList(result);
    }
    public void event(Task task, String principal, String command, long oldHead, Timestamp now) throws SQLException {
        if (oldHead < 0 || oldHead >= MAX) throw JdbcApplicationStore.corrupt();
        Event event = new Event(); event.eventId = UUID.randomUUID().toString(); event.spaceId = space; event.seq = oldHead + 1; event.occurredAt = JdbcApplicationStore.text(now);
        event.kind = EventKind.TASK_UPDATED; event.taskId = task.id; event.entityRef = new EntityRef(); event.entityRef.kind = EntityRefKind.TASK; event.entityRef.id = task.id; event.entityRef.version = task.version;
        EventsResult result = new EventsResult(); result.events = Collections.singletonList(event); result.nextCursor = "storage"; result.hasMore = false;
        change("UPDATE mutation_outbox SET task_seq=?,task_group_id=?,event_bytes=? WHERE space_id=? AND principal_id=? AND command_id=? AND target_type='task' AND target_id=? AND target_version=? AND task_seq IS NULL AND task_group_id IS NULL AND event_bytes IS NULL", event.seq, task.groupId, BOUNDARY.writeResponse("getEvents", 200, result), space, principal, command, task.id, task.version);
        change("UPDATE task_space_head SET event_seq=? WHERE space_id=? AND event_seq=?", event.seq, space, oldHead);
    }
    public static final class EventRow {
        public final Event event; public final String group;
        EventRow(Event event, String group) { this.event = event; this.group = group; }
    }
    public List<EventRow> events(long after, long head, int limit) throws SQLException {
        List<EventRow> result = new ArrayList<EventRow>();
        try (PreparedStatement p = prepare("SELECT task_seq,target_id,task_group_id,event_bytes,target_version FROM mutation_outbox WHERE space_id=? AND task_seq>? AND task_seq<=? AND target_type='task' ORDER BY task_seq LIMIT ?", space, after, head, limit); ResultSet r = p.executeQuery()) {
            long next = after + 1;
            while (r.next()) try {
                EventsResult envelope = BOUNDARY.readResponse("getEvents", 200, r.getBytes(4), EventsResult.class);
                if (envelope.events.size() != 1) throw JdbcApplicationStore.corrupt(); Event e = envelope.events.get(0);
                if (r.getLong(1) != next++ || r.getLong(1) != e.seq || !space.equals(e.spaceId) || !r.getString(2).equals(e.taskId) || !e.taskId.equals(e.entityRef.id) || r.getLong(5) != e.entityRef.version || e.kind != EventKind.TASK_UPDATED || e.entityRef.kind != EntityRefKind.TASK || e.runId != null || r.getString(3) == null) throw JdbcApplicationStore.corrupt();
                result.add(new EventRow(e, r.getString(3)));
            } catch (ContractBoundary.Failure failure) { throw JdbcApplicationStore.corrupt(); }
        }
        if (result.size() != Math.min((long)limit, head - after)) throw JdbcApplicationStore.corrupt(); return result;
    }
    public Long cursor(String id, Timestamp now, long head) throws SQLException {
        try (PreparedStatement p = prepare("SELECT high_water,created_at,expires_at FROM task_event_cursors WHERE space_id=? AND id=?", space, id); ResultSet r = p.executeQuery()) {
            if (!r.next()) return null; long value = r.getLong(1); Timestamp created = r.getTimestamp(2, utc()), expires = r.getTimestamp(3, utc());
            if (created == null || expires == null || expires.getTime() - created.getTime() != 86400000L || value < 0 || value > head || r.next()) throw JdbcApplicationStore.corrupt();
            return now.before(expires) ? value : null;
        }
    }
    public String cursor(long highWater, Timestamp now) throws SQLException {
        if (highWater < 0 || highWater > MAX) throw JdbcApplicationStore.corrupt(); String id = UUID.randomUUID().toString();
        change("INSERT INTO task_event_cursors(space_id,id,high_water,created_at,expires_at) VALUES(?,?,?,?,?)", space, id, highWater, now, new Timestamp(now.getTime() + 86400000L)); return id;
    }
}
