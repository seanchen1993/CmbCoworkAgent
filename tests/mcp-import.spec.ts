/**
 * Focused tests for MCP JSON import parsing and conflict planning.
 *
 * Run with:
 *   npx tsx tests/mcp-import.spec.ts
 */
import assert from "node:assert/strict"
import {
  buildMcpImportOperations,
  parseMcpImportConfig,
  previewMcpImportConfig
} from "../src/main/mcp/config-import.ts"
import type { McpConnectorConfig } from "../src/main/types.ts"

function existingConnector(name: string, id = `id-${name}`): McpConnectorConfig {
  return {
    id,
    name,
    kind: "remote",
    url: `https://example.com/${name}`,
    enabled: true,
    lazyLoad: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  }
}

const common = parseMcpImportConfig({
  rawJson: JSON.stringify({
    mcpServers: {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        env: { API_KEY: "secret" }
      },
      docs: {
        type: "http",
        url: "https://docs.example.com/mcp",
        headers: { Authorization: "Bearer token" },
        lazyLoad: true
      }
    }
  })
})

assert.deepEqual(common.errors, [])
assert.equal(common.connectors.length, 2)
assert.equal(common.connectors[0].connector.kind, "stdio")
assert.equal(common.connectors[0].connector.enabled, true)
assert.equal(common.connectors[0].hasEnv, true)
assert.equal(common.connectors[1].connector.kind, "remote")
assert.equal(common.connectors[1].connector.advanced?.transport, "streamable-http")
assert.equal(common.connectors[1].hasHeaders, true)
assert.equal(common.connectors[1].connector.lazyLoad, true)

const nested = parseMcpImportConfig({
  rawJson: JSON.stringify({
    mcp: {
      servers: {
        qmd: {
          type: "local",
          command: ["uvx", "qmd-mcp"],
          environment: { QMD_HOME: "C:/tmp/qmd" }
        }
      }
    }
  })
})

assert.deepEqual(nested.errors, [])
assert.equal(nested.connectors[0].connector.command, "uvx")
assert.deepEqual(nested.connectors[0].connector.args, ["qmd-mcp"])
assert.equal(nested.connectors[0].connector.env?.QMD_HOME, "C:/tmp/qmd")

const single = parseMcpImportConfig({
  rawJson: JSON.stringify({
    name: "single-docs",
    url: "https://single.example.com/mcp",
    transport: "sse"
  })
})

assert.deepEqual(single.errors, [])
assert.equal(single.connectors[0].connector.name, "single-docs")
assert.equal(single.connectors[0].connector.advanced?.transport, "sse")

const remoteType = parseMcpImportConfig({
  rawJson: JSON.stringify({
    mcpServers: {
      remoteDocs: {
        type: "remote",
        url: "https://remote.example.com/mcp"
      }
    }
  })
})

assert.deepEqual(remoteType.errors, [])
assert.equal(remoteType.connectors[0].connector.kind, "remote")
assert.equal(remoteType.connectors[0].connector.advanced?.transport, undefined)

const preview = previewMcpImportConfig(
  {
    rawJson: JSON.stringify({
      mcpServers: {
        docs: { url: "https://new.example.com/mcp" },
        firstDup: { name: "duplicate", url: "https://a.example.com/mcp" },
        secondDup: { name: "duplicate", url: "https://b.example.com/mcp" }
      }
    })
  },
  [existingConnector("docs", "docs-id")]
)

assert.equal(preview.connectors[0].conflict, "existing")
assert.equal(preview.connectors[0].existingId, "docs-id")
assert.equal(preview.connectors[1].conflict, undefined)
assert.equal(preview.connectors[2].conflict, "duplicate")

const parsedForOperations = parseMcpImportConfig({
  rawJson: JSON.stringify({
    mcpServers: {
      docs: { url: "https://new.example.com/mcp" },
      duplicateA: { name: "duplicate", url: "https://a.example.com/mcp" },
      duplicateB: { name: "duplicate", url: "https://b.example.com/mcp" }
    }
  })
})

const updateOps = buildMcpImportOperations({
  parsed: parsedForOperations.connectors,
  existingConnectors: [existingConnector("docs", "docs-id")],
  conflictStrategy: "update"
})
assert.equal(updateOps[0].action, "update")
assert.equal(updateOps[0].action === "update" ? updateOps[0].connector.id : "", "docs-id")
assert.equal(updateOps[2].action, "create")
assert.equal(updateOps[2].action === "create" ? updateOps[2].connector.name : "", "duplicate 2")

const renameOps = buildMcpImportOperations({
  parsed: parsedForOperations.connectors,
  existingConnectors: [existingConnector("docs", "docs-id")],
  conflictStrategy: "rename"
})
assert.equal(renameOps[0].action, "create")
assert.equal(renameOps[0].action === "create" ? renameOps[0].connector.name : "", "docs 2")

const skipOps = buildMcpImportOperations({
  parsed: parsedForOperations.connectors,
  existingConnectors: [existingConnector("docs", "docs-id")],
  conflictStrategy: "skip"
})
assert.equal(skipOps[0].action, "skip")
assert.equal(skipOps[2].action, "skip")

console.log("PASS MCP import parsing")
