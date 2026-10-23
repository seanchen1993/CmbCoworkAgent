import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
import {
  createDesignState,
  type DesignSessionSnapshot
} from "../../../shared/managed-design-session"
import { DesignSessionStore } from "./session-store"

function seed(): DesignSessionSnapshot {
  return {
    id: "ds_disk",
    seq: 1,
    meta: { id: "ds_disk", title: "持久化", createdAt: 1, updatedAt: 1 },
    state: {
      ...createDesignState(),
      messages: [
        { id: "user", role: "user", content: "我的需求" },
        {
          id: "assistant",
          role: "assistant",
          content: "",
          isStreaming: true,
          executionEvents: [{ id: "tool", kind: "tool_call", name: "write_file", timestamp: 1 }]
        }
      ]
    },
    workspacePath: "/workspace",
    activeRunId: "run",
    lastSeenSeq: 0
  }
}

describe("durable design storage", () => {
  it("stores draft content once outside message snapshots and restores it on reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "design-draft-durable-"))
    const path = join(dir, "design.sqlite")
    try {
      const db = new NativeSqliteAdapter(new DatabaseSync(path))
      const store = new DesignSessionStore(db)
      const snapshot = seed()
      snapshot.state.draftPreview = {
        runId: "run",
        revision: 1,
        html: "<html>durable-draft</html>",
        draftPath: "/draft.html",
        phase: "scaffold",
        status: "building",
        sections: [],
        completedSections: [],
        totalSections: 0,
        tweaks: null,
        createdAt: 1,
        updatedAt: 1
      }
      store.save(snapshot, [{ type: "preview", preview: snapshot.state.draftPreview }])
      expect(String(db.exec("SELECT state FROM design_sessions")[0].values[0][0])).not.toContain(
        "durable-draft"
      )
      expect(
        String(db.exec("SELECT payload FROM design_session_events")[0].values[0][0])
      ).not.toContain("durable-draft")
      db.close()
      const reopened = new NativeSqliteAdapter(new DatabaseSync(path))
      try {
        const recovered = new DesignSessionStore(reopened)
        expect(recovered.get("ds_disk")!.state.draftPreview!.html).toBe(
          "<html>durable-draft</html>"
        )
        recovered.remove("ds_disk")
        expect(reopened.exec("SELECT count(*) FROM design_draft_previews")[0].values[0][0]).toBe(0)
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reopens the file with execution-only messages, run inputs and the same event cursor", () => {
    const dir = mkdtempSync(join(tmpdir(), "design-session-durable-"))
    const path = join(dir, "design.sqlite")
    try {
      const db = new NativeSqliteAdapter(new DatabaseSync(path))
      const store = new DesignSessionStore(db)
      store.save(seed(), [{ type: "start" }], {
        designSessionId: "ds_disk",
        requestId: "request",
        kind: "image",
        prompt: "截图",
        imageData: "base64",
        mimeType: "image/png"
      })
      db.close()
      const reopened = new NativeSqliteAdapter(new DatabaseSync(path))
      try {
        const recovered = new DesignSessionStore(reopened)
        expect(recovered.get("ds_disk")).toEqual(seed())
        expect(recovered.latestRequest("ds_disk")!.imageData).toBe("base64")
        expect(recovered.findRequest("request")).toEqual({ sessionId: "ds_disk", runId: "run" })
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rolls back a failed journal commit along with message and snapshot mutations", () => {
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    try {
      const store = new DesignSessionStore(db)
      store.save(seed(), [{ type: "created" }])
      const changed = seed()
      changed.state.messages[0].content = "不应提交"
      changed.state.html = "不应提交"
      expect(() => store.save(changed, [{ type: "duplicate-cursor" }])).toThrow()
      expect(store.get("ds_disk")!.state.messages[0].content).toBe("我的需求")
      expect(store.get("ds_disk")!.state.html).toBe("")
    } finally {
      db.close()
    }
  })

  it("keeps deletion tombstones across reopen so legacy migration cannot resurrect records", () => {
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    try {
      const store = new DesignSessionStore(db)
      store.save(seed(), [{ type: "created" }])
      store.remove("ds_disk")
      const reopened = new DesignSessionStore(db)
      expect(reopened.wasDeleted("ds_disk")).toBe(true)
      expect(reopened.get("ds_disk")).toBeNull()
    } finally {
      db.close()
    }
  })
})
