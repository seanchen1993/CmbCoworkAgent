package com.devclaw.botcontrol.application;

/** Closed application selectors, not an HTTP router. */
public enum Operation {
    CREATE_BOT("createBot", "POST", "/api/bot/v1/bots", 201),
    GET_BOT("getBot", "GET", "/api/bot/v1/bots/", 200),
    CREATE_BOT_VERSION("createBotVersion", "POST", "/api/bot/v1/bots/", 201),
    CREATE_GROUP("createGroup", "POST", "/api/bot/v1/groups", 201),
    GET_GROUP("getGroup", "GET", "/api/bot/v1/groups/", 200),
    UPDATE_GROUP_MEMBERS("updateGroupMembers", "PUT", "/api/bot/v1/groups/", 200),
    CREATE_TASK("createTask", "POST", "/api/bot/v1/tasks", 201),
    GET_TASK("getTask", "GET", "/api/bot/v1/tasks/", 200),
    CREATE_TASK_MESSAGE("createTaskMessage", "POST", "/api/bot/v1/tasks/", 201),
    GET_EVENTS("getEvents", "GET", "/api/bot/v1/events", 200);
    public final String wire, method;
    public final int success;
    private final String prefix;
    Operation(String wire, String method, String prefix, int success) { this.wire = wire; this.method = method; this.prefix = prefix; this.success = success; }
    public boolean write() { return method.equals("POST") || method.equals("PUT"); }
    public boolean create() { return this == CREATE_BOT || this == CREATE_GROUP || this == CREATE_TASK; }
    public boolean task() { return this == CREATE_TASK || this == GET_TASK || this == CREATE_TASK_MESSAGE || this == GET_EVENTS; }
    public String receiptType() { return this == CREATE_BOT_VERSION ? "bot_version" : bot() ? "bot" : this == CREATE_TASK ? "task" : this == CREATE_TASK_MESSAGE ? "task_message" : "group"; }
    public boolean bot() { return this == CREATE_BOT || this == GET_BOT || this == CREATE_BOT_VERSION; }
    public String path(String id) { return create() || this == GET_EVENTS ? prefix : prefix + id + (this == CREATE_BOT_VERSION ? "/versions" : this == UPDATE_GROUP_MEMBERS ? "/members" : this == CREATE_TASK_MESSAGE ? "/messages" : ""); }
}
