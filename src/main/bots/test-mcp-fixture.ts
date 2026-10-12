import { createRequire } from "node:module"
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { CapabilitySource } from "../mcp/capability-core"

/** Real SDK server in a child process, using only disposable test data. */
export async function mcpFixture(
  mode: "normal" | "disconnect" | "held" | "held-discovery" = "normal",
  response?: { text: string; isError?: boolean; structuredContent?: Record<string, unknown> },
  resourceOptions?: { only?: boolean }
) {
  const directory = await mkdtemp(join(tmpdir(), "bot-mcp-fixture-"))
  const script = join(directory, "server.mjs"),
    log = join(directory, "calls.jsonl")
  const require = createRequire(import.meta.url)
  const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(require.resolve(name)).href)
  await writeFile(
    script,
    `
import { Server } from ${moduleUrl("@modelcontextprotocol/sdk/server/index.js")};
import { StdioServerTransport } from ${moduleUrl("@modelcontextprotocol/sdk/server/stdio.js")};
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema } from ${moduleUrl("@modelcontextprotocol/sdk/types.js")};
import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const server = new Server({ name: "test-notes", version: "1" }, { capabilities: ${JSON.stringify({ ...(!resourceOptions?.only ? { tools: {} } : {}), ...(resourceOptions ? { resources: {} } : {}) })} });
if (${!resourceOptions?.only}) server.setRequestHandler(ListToolsRequestSchema, async () => {
  appendFileSync(${JSON.stringify(join(directory, "discovery"))}, "started\\n");
  if (${JSON.stringify(mode)} === "held-discovery") while (!existsSync(${JSON.stringify(join(directory, "release"))})) await delay(20);
  return { tools: [{
  name: "append_note", description: "Save a project note",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
}] };
});
if (${!resourceOptions?.only}) server.setRequestHandler(CallToolRequestSchema, async (request) => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(request.params) + "\\n");
  if (${JSON.stringify(mode)} === "disconnect") process.exit(0);
  if (${JSON.stringify(mode)} === "held") while (!existsSync(${JSON.stringify(join(directory, "release"))})) await delay(20);
  return ${response ? JSON.stringify({ content: [{ type: "text", text: response.text }], isError: response.isError ?? false, ...(response.structuredContent ? { structuredContent: response.structuredContent } : {}) }) : '{ content: [{ type: "text", text: "saved: " + request.params.arguments.text }] }'};
});
if (${Boolean(resourceOptions)}) {
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    appendFileSync(${JSON.stringify(join(directory, "discovery"))}, "resources\\n");
    if (${JSON.stringify(mode)} === "held-discovery") while (!existsSync(${JSON.stringify(join(directory, "release"))})) await delay(20);
    return request.params?.cursor
      ? { resources: [{ name: "Binary sample", uri: "notes://resource/binary", mimeType: "application/octet-stream" }] }
      : { resources: [{ name: "Project notes", uri: "notes://resource/first", mimeType: "text/plain" }], nextCursor: "second" };
  });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{ name: "Project query", uriTemplate: "notes://project/{project}{?q}", mimeType: "text/plain" }]
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: "resources/read", ...request.params }) + "\\n");
    if (${JSON.stringify(mode)} === "disconnect") process.exit(0);
    if (${JSON.stringify(mode)} === "held") while (!existsSync(${JSON.stringify(join(directory, "release"))})) await delay(20);
    return { contents: [request.params.uri === "notes://resource/binary"
      ? { uri: request.params.uri, mimeType: "application/octet-stream", blob: "AQIDBA==" }
      : { uri: request.params.uri, mimeType: "text/plain", text: ${response ? JSON.stringify(response.text) : '"read: " + request.params.uri'} }] };
  });
}
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => process.exit(0));
`
  )
  const source: CapabilitySource = {
    kind: "connector",
    providerKey: "notes",
    providerDisplayName: "Notes",
    visibility: "lazy",
    priority: 100,
    scope: "global",
    serverConfig: {
      transport: "stdio",
      command: process.execPath,
      args: [script],
      env: { FIXTURE_PRIVATE_KEY: "private-credential" }
    }
  }
  return {
    source,
    directory,
    release: () => writeFile(join(directory, "release"), "release"),
    discovering: () =>
      access(join(directory, "discovery")).then(
        () => true,
        () => false
      ),
    async calls(): Promise<unknown[]> {
      const text = await readFile(log, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })
      return text.trim()
        ? text
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : []
    },
    close: () => rm(directory, { recursive: true, force: true })
  }
}
