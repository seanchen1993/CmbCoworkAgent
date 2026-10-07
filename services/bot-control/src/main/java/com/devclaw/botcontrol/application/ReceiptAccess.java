package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.persistence.*;
import com.devclaw.botcontrol.ports.TrustedContext;
import com.devclaw.botcontrol.validation.ContractBoundary;
import java.sql.*;

/** Shared receipt locator only: current target authorization precedes expiry/conflict/body. */
final class ReceiptAccess {
    private ReceiptAccess() {}
    static boolean member(TrustedContext actor, Group group, boolean admin) {
        for (GroupMember m : group.members) if (actor.principalId.equals(m.principalId) && (!admin || m.role == GroupMemberRole.ADMIN)) return true;
        return false;
    }
    static void authorize(JdbcApplicationStore db, JdbcTaskStore tasks, TrustedContext actor, JdbcApplicationStore.Receipt receipt) throws SQLException {
        if ("bot".equals(receipt.type) || "bot_version".equals(receipt.type)) {
            Bot bot = db.bot("bot".equals(receipt.type) ? receipt.target : db.versionOwner(receipt.target));
            if (bot == null) throw JdbcApplicationStore.corrupt();
            if (!bot.maintainerIds.contains(actor.principalId)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
        } else if ("group".equals(receipt.type) || "task".equals(receipt.type) || "task_message".equals(receipt.type)) {
            boolean task = !"group".equals(receipt.type);
            String taskId = "task_message".equals(receipt.type) ? tasks.messageTask(receipt.target) : receipt.target;
            String groupId = task ? tasks.groupId(taskId) : receipt.target;
            if (groupId == null) throw JdbcApplicationStore.corrupt(); Group group = db.group(groupId);
            if (group == null) throw JdbcApplicationStore.corrupt();
            if (!member(actor, group, !task)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
        } else throw JdbcApplicationStore.corrupt();
    }
    static void metadata(JdbcApplicationStore.Receipt receipt, ContractBoundary boundary) {
        Operation original = null;
        for (Operation op : Operation.values()) if (op.write() && op.wire.equals(receipt.operation)) original = op;
        if (original == null || receipt.status != original.success || !original.receiptType().equals(receipt.type)) throw JdbcApplicationStore.corrupt();
        try { boundary.validateParameter("getBot", "botId", receipt.target); }
        catch (ContractBoundary.Failure failure) { throw JdbcApplicationStore.corrupt(); }
    }
}
