/** Real container/list/controller/Radix/installed Virtuoso; deterministic transport and bubble
 * geometry only. This fixture deliberately does not simulate the following state machine. */
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import ts from "typescript"
import { browserWorkerPlugin } from "./browser-worker-plugin.mjs"

export async function buildFollowingFixture(): Promise<{ script: string; css: string }> {
  const renderer = resolve("src/renderer/src")
  const chatFile = resolve(renderer, "components/chat/ChatContainer.tsx")
  const source = readFileSync(chatFile, "utf8")
  const parsed = ts.createSourceFile(
    chatFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const leaves = new Map<string, { names: string[]; helpers: string[] }>()
  for (const node of parsed.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.importClause?.isTypeOnly ||
      !node.importClause?.namedBindings ||
      !ts.isNamedImports(node.importClause.namedBindings)
    )
      continue
    const path = node.moduleSpecifier.text
    if (
      !(
        path.startsWith("./") ||
        path.startsWith("../customize/") ||
        path.startsWith("@/components/")
      )
    )
      continue
    if (
      /\/ui\/|ChatMessageVirtualList|ChatMessageScrollArea|ChatScrollNavigator|ContextReminderController|ModsAgentTranscriptPanel|UserInputRequestDialog/.test(
        path
      )
    )
      continue
    const absolute = path.startsWith("@/")
      ? resolve(renderer, path.slice(2))
      : resolve(dirname(chatFile), path)
    if (!existsSync(absolute + ".tsx")) continue
    const values = node.importClause.namedBindings.elements.filter((item) => !item.isTypeOnly)
    const names = values
      .filter((item) => /^[A-Z][a-z]/.test(item.name.text))
      .map((item) => item.name.text)
    if (names.length)
      leaves.set(path, {
        names,
        helpers: values
          .filter((item) => !names.includes(item.name.text))
          .map((item) => item.name.text)
      })
  }
  const thread = readFileSync(resolve(renderer, "lib/thread-context.tsx"), "utf8")
  const start = thread.indexOf("const createDefaultThreadState =")
  const initial = thread
    .slice(thread.indexOf("=> ({", start) + 3, thread.indexOf("\n})", start) + 3)
    .replace("createDefaultContextReminderState()", "{status:'idle',enabled:false}")
  const bundle = await build({
    entryPoints: [resolve("tests/support/chat-following-fixture-entry.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": renderer },
    loader: { ".png": "dataurl", ".md": "text" },
    define: {
      "process.env.NODE_ENV": '"development"',
      "import.meta.env": "{}",
      "import.meta.hot": "undefined",
      "import.meta.url": '"http://fixture.invalid/fixture.js"',
      __APP_VERSION__: '"2.0.0"'
    },
    plugins: [
      browserWorkerPlugin(),
      {
        name: "following-transport-and-presentation",
        setup(builder) {
          builder.onResolve({ filter: /^fixture:thread$|(?:^|\/)thread-context$/ }, () => ({
            path: "thread",
            namespace: "following"
          }))
          builder.onLoad({ filter: /.*/, namespace: "following" }, () => ({
            loader: "tsx",
            resolveDir: process.cwd(),
            contents: `
          import {create} from 'zustand';
          const noop=()=>{},asyncNoop=async()=>null;
          export const threadStore=create(()=>({...${initial},workspacePath:'C:/fixture',historyLoading:false,currentModel:'test',
            historyConversationPresence:'nonempty',historyLoadedMessageCount:80,historyMessageTotal:80,
            messages:Array.from({length:80},(_,i)=>({id:'message-'+i,role:i%2?'assistant':'user',content:'Readable message '+i+'\\n'+('Continuous body line.\\n').repeat(6)}))}));
          const change=patch=>threadStore.setState(patch);
          const actions=new Proxy({setDraftInput:draftInput=>change({draftInput}),refreshGoalUi:asyncNoop},{get:(target,name)=>target[name]??noop});
          export const streamStore=create(()=>({stream:{submit:asyncNoop,stop:noop},isLoading:false,messages:[],liveMessages:[]}));
          export function useCurrentThread(){return new Proxy({...threadStore(),...actions},{get:(target,name)=>Object.hasOwn(target,name)?target[name]:actions[name]})}
          export const useThreadStream=()=>streamStore(),useThreadActions=()=>actions,useThreadStateSelector=(_id,select)=>select(threadStore());
          const logs=[],context={getThreadState:()=>threadStore.getState(),getThreadActions:()=>actions,subscribeToHookLogs:()=>noop,getHookLogBuckets:()=>logs};
          export const useThreadContext=()=>context;
        `
          }))
          builder.onResolve({ filter: /^\.\/MessageBubble$/ }, () => ({
            path: "bubble",
            namespace: "following-bubble"
          }))
          builder.onLoad({ filter: /.*/, namespace: "following-bubble" }, () => ({
            loader: "tsx",
            resolveDir: process.cwd(),
            contents: `
          export const MessageBubble=({message})=><>
            <article data-readable-body style={{whiteSpace:'pre-wrap',lineHeight:'24px',padding:'8px 0'}}>{message.content}</article>
            {message.tool_calls?.map(tool=><section key={tool.id} data-fixture-tail-tool style={{whiteSpace:'pre-wrap',lineHeight:'24px'}}>{tool.args.output}</section>)}
          </>;
        `
          }))
          builder.onResolve({ filter: /.*/ }, (args) =>
            args.importer === chatFile && leaves.has(args.path)
              ? { path: args.path, namespace: "following-chrome" }
              : undefined
          )
          builder.onLoad({ filter: /.*/, namespace: "following-chrome" }, (args) => {
            const leaf = leaves.get(args.path)!
            const absolute = args.path.startsWith("@/")
              ? resolve(renderer, args.path.slice(2))
              : resolve(dirname(chatFile), args.path)
            return {
              loader: "tsx",
              resolveDir: dirname(chatFile),
              contents: `
            ${leaf.helpers.length ? `export {${leaf.helpers.join(",")}} from ${JSON.stringify(absolute)};` : ""}
            ${leaf.names
              .map((name) =>
                name === "ChatTodos"
                  ? `export const ChatTodos=({todos})=><section data-fixture-footer>{todos.map((item,i)=><p key={i}>{item.content}</p>)}</section>;`
                  : `export const ${name}=p=>p.fallback??p.children??null;`
              )
              .join("\n")}
          `
            }
          })
        }
      }
    ]
  })
  const styles = await compile(
    readFileSync(resolve(renderer, "index.css"), "utf8").replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => undefined }
  )
  const scanner = new Scanner({
    sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
  })
  return { script: bundle.outputFiles[0].text, css: styles.build(scanner.scan()) }
}
