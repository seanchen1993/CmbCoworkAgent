package com.devclaw.botcontrol.application;

/** Closed application selectors, not an HTTP router. */
public enum Operation {
    CREATE_BOT("createBot", "POST", "/api/bot/v1/bots", 201),
    GET_BOT("getBot", "GET", "/api/bot/v1/bots/", 200),
    CREATE_BOT_VERSION("createBotVersion", "POST", "/api/bot/v1/bots/", 201),
    CREATE_GROUP("createGroup", "POST", "/api/bot/v1/groups", 201),
    GET_GROUP("getGroup", "GET", "/api/bot/v1/groups/", 200),
    UPDATE_GROUP_MEMBERS("updateGroupMembers", "PUT", "/api/bot/v1/groups/", 200);
    public final String wire, method;
    public final int success;
    private final String prefix;
    Operation(String wire, String method, String prefix, int success) { this.wire = wire; this.method = method; this.prefix = prefix; this.success = success; }
    public boolean write() { return this != GET_BOT && this != GET_GROUP; }
    public boolean create() { return this == CREATE_BOT || this == CREATE_GROUP; }
    public boolean bot() { return this == CREATE_BOT || this == GET_BOT || this == CREATE_BOT_VERSION; }
    public String path(String id) { return create() ? prefix : prefix + id + (this == CREATE_BOT_VERSION ? "/versions" : this == UPDATE_GROUP_MEMBERS ? "/members" : ""); }
}
