import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { NativeSqliteAdapter } from "../../src/main/db/native-sqlite-adapter"
import type { AgentRunDelivery } from "../../src/main/agent/agent-run-service"
import type {
  PartnerRequirementInput,
  PartnerRequirementRun
} from "../../src/main/services/bot/requirement-execution-types"

export const delivery: AgentRunDelivery = {
  // Exactly the documented managed window surface; no Electron instance.
  window: {
    id: -601,
    isDestroyed: () => false,
    webContents: { send: () => {}, isDestroyed: () => false }
  } as unknown as AgentRunDelivery["window"],
  isAvailable: () => true,
  send: () => {}
}
export function runFixture(): PartnerRequirementRun {
  return {
    id: "run",
    spaceId: "A",
    taskId: "task",
    stageId: "stage",
    groupId: "group",
    botId: "expert",
    botVersionId: "expert-v1",
    nodeId: "node",
    ownerPrincipalId: "owner",
    workspaceRef: "workspace",
    attemptId: "attempt",
    leaseId: "lease",
    fence: 1,
    taskVersion: 1,
    groupVersion: 1,
    status: "starting",
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    deadline: new Date(Date.now() + 600_000).toISOString()
  }
}
export function inputFixture(): PartnerRequirementInput {
  const createdAt = "2026-10-11T08:00:00Z"
  return {
    messages: [],
    memorySnapshot: null,
    bot: {
      id: "expert",
      spaceId: "A",
      version: 1,
      name: "支付专家",
      status: "active",
      currentBotVersionId: "expert-v1",
      maintainerIds: ["owner"],
      createdAt,
      updatedAt: createdAt
    },
    botVersion: {
      id: "expert-v1",
      spaceId: "A",
      botId: "expert",
      number: 1,
      createdAt,
      config: {
        description: "支付领域",
        instructions: "不要把推测当代码事实",
        persona: "严谨简洁",
        knowledgeRefs: ["guide"],
        repositoryRefs: ["repo"],
        skillAllowlist: [],
        capabilityCeiling: ["requirements.analyze"],
        memoryPolicy: "disabled"
      }
    },
    group: {
      id: "group",
      spaceId: "A",
      version: 1,
      name: "需求团队",
      createdAt,
      updatedAt: createdAt,
      bots: [{ botId: "expert", botVersionId: "expert-v1", role: "specialist" }],
      members: [
        { principalId: "owner", role: "admin" },
        { principalId: "business", role: "business_owner" }
      ],
      limits: { maxRuns: 2, maxHandoffs: 2, maxTokens: 10000 }
    },
    task: {
      id: "task",
      spaceId: "A",
      groupId: "group",
      version: 1,
      taskNumber: "TASK-1",
      title: "交易查询",
      goal: "支持按日期查询交易，先梳理权限与边界",
      status: "active",
      currentStageId: "stage",
      inputArtifactVersions: [],
      createdAt,
      updatedAt: createdAt,
      stages: [
        {
          id: "stage",
          kind: "requirement",
          status: "active",
          inputArtifactVersions: [],
          outputArtifactVersions: []
        }
      ]
    }
  }
}
export function open(path: string) {
  return new NativeSqliteAdapter(new DatabaseSync(path, { timeout: 2000 }))
}
export async function withSqlite<T>(
  work: (db: NativeSqliteAdapter, path: string) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "devclaw-bot-execution-test-")),
    path = join(dir, "threads.sqlite"),
    db = open(path)
  try {
    db.run("PRAGMA journal_mode=WAL")
    db.run(`CREATE TABLE threads(thread_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,metadata TEXT,status TEXT DEFAULT 'idle',thread_values TEXT,title TEXT)`)
    return await work(db, path)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
