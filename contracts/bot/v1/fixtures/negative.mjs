import { requests, runtime, runSpec, workspace, prd, toolApproval, now } from "./positive.mjs"

const modify = (data, fn) => {
  const copy = structuredClone(data)
  fn(copy)
  return copy
}
const runtimeOf = (type) => runtime.find((value) => value.type === type)
export const negative = [
  ...['W/"1"', "*", '"1", "2"', '"01"', '"0"', '"9007199254740992"'].map((value) => ({
    name: `invalid strong ETag ${value}`,
    schema: "IfMatchVersion",
    value
  })),
  ...["Text/Plain", "text/plain; charset=utf-8", " text/plain", "text/*"].map((value) => ({
    name: `noncanonical HTTP Content-Type ${value}`,
    schema: "MediaType",
    value
  })),
  {
    name: "unknown business outcome cannot advertise retry",
    schema: "ErrorResponse",
    value: {
      requestId: "request-1",
      error: {
        code: "OUTCOME_UNKNOWN",
        message: "Inspect before executing again.",
        retryable: true
      }
    }
  },
  {
    name: "unknown Runtime outcome cannot advertise retry",
    schema: "RuntimeEnvelope",
    value: modify(runtimeOf("error"), (x) => {
      x.body.retryable = true
    })
  },
  {
    name: "create cannot claim version zero",
    schema: "CreateBotRequest",
    value: { ...requests.createBot, expectedVersion: 0 }
  },
  {
    name: "mode cannot broaden requirement into project",
    schema: "CreateRunRequest",
    value: modify(requests.createRun, (x) => {
      x.mode.id = "coding"
    })
  },
  {
    name: "unknown capability",
    schema: "CreateRunRequest",
    value: modify(requests.createRun, (x) => {
      x.requestedCapabilities = ["all.tools"]
    })
  },
  {
    name: "unsafe integer version",
    schema: "CancelRunRequest",
    value: { ...requests.cancelRun, expectedVersion: 9007199254740992 }
  },
  {
    name: "zero CAS",
    schema: "CancelRunRequest",
    value: { ...requests.cancelRun, expectedVersion: 0 }
  },
  {
    name: "fractional CAS",
    schema: "CancelRunRequest",
    value: { ...requests.cancelRun, expectedVersion: 1.5 }
  },
  {
    name: "invalid digest",
    schema: "CreateUploadRequest",
    value: { ...requests.createUpload, digest: "sha256:BAD" }
  },
  {
    name: "non UTC timestamp",
    schema: "CreateApprovalRequest",
    value: { ...requests.createApproval, expiresAt: "2026-10-01T20:00:00+08:00" }
  },
  {
    name: "invalid calendar date",
    schema: "CreateApprovalRequest",
    value: { ...requests.createApproval, expiresAt: "2026-02-30T12:00:00Z" }
  },
  {
    name: "filename is not a path",
    schema: "CreateUploadRequest",
    value: { ...requests.createUpload, fileName: "/private/synthetic.txt" }
  },
  {
    name: "filename rejects windows separators",
    schema: "CreateUploadRequest",
    value: { ...requests.createUpload, fileName: "C:\\synthetic.txt" }
  },
  { name: "RunSpec is not CreateRunRequest", schema: "CreateRunRequest", value: runSpec },
  {
    name: "URL cannot be opaque workspace",
    schema: "WorkspaceSpec",
    value: { ...workspace, workspaceRef: "https://invalid.example/file" }
  },
  {
    name: "repository ref/revision must appear together",
    schema: "WorkspaceSpec",
    value: modify(workspace, (x) => {
      delete x.repositoryRevision
    })
  },
  {
    name: "tool approval requires exact action",
    schema: "Approval",
    value: modify(toolApproval, (x) => {
      delete x.requestedAction
    })
  },
  {
    name: "business approval cannot smuggle tool action",
    schema: "CreateApprovalRequest",
    value: { ...requests.createApproval, requestedAction: toolApproval.requestedAction }
  },
  {
    name: "runtime wrong protocol",
    schema: "RuntimeEnvelope",
    value: { ...runtimeOf("accepted"), protocol: "im.v1" }
  },
  {
    name: "runtime wrong schema version",
    schema: "RuntimeEnvelope",
    value: { ...runtimeOf("accepted"), schemaVersion: 2 }
  },
  {
    name: "runtime unknown type",
    schema: "RuntimeEnvelope",
    value: { ...runtimeOf("accepted"), type: "execute_tool" }
  },
  {
    name: "runtime type/body mismatch",
    schema: "RuntimeEnvelope",
    value: { ...runtimeOf("accepted"), body: runtimeOf("heartbeat").body }
  },
  {
    name: "runtime local path forbidden",
    schema: "RuntimeEnvelope",
    value: modify(runtimeOf("workspace_prepared"), (x) => {
      x.body.path = "/private/synthetic"
    })
  },
  {
    name: "runtime zero actual event sequence",
    schema: "RuntimeEnvelope",
    value: modify(runtimeOf("event"), (x) => {
      x.body.eventSeq = 0
    })
  },
  {
    name: "runtime zero ACK sequence",
    schema: "RuntimeEnvelope",
    value: modify(runtimeOf("ack"), (x) => {
      x.body.eventSeq = 0
    })
  },
  {
    name: "runtime negative inspection watermark",
    schema: "RuntimeEnvelope",
    value: modify(runtimeOf("inspection"), (x) => {
      x.body.lastEventSeq = -1
    })
  },
  {
    name: "progress cannot claim success",
    schema: "RuntimeEnvelope",
    value: modify(runtimeOf("event"), (x) => {
      x.body.data = { outcome: "succeeded", artifactVersions: [prd] }
    })
  },
  {
    name: "closed completed data",
    schema: "CompletedData",
    value: { outcome: "succeeded", artifactVersions: [], authorization: "synthetic-forged" }
  },
  {
    name: "read result secret injection",
    schema: "ArtifactVersion",
    value: {
      id: "v1",
      artifactId: "a1",
      spaceId: "s1",
      taskId: "t1",
      number: 1,
      digest: prd.digest,
      mediaType: "text/plain",
      sizeBytes: 3,
      blobRef: "blob1",
      createdAt: now,
      createdBy: "p1",
      token: "synthetic"
    }
  }
]
