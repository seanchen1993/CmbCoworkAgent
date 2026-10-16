import type { FunctionModelProtocol } from "../../../shared/mods/v2/model-protocol"
/** Deliberately closed authoring subset; absence here is not a runtime compatibility claim. */
export const FUNCTION_AUTHORING_DECLARATIONS = String.raw`// CMB Mods authoring contract, desktop subset v2.
// This is not the complete upstream SDK. No DOM, Node, arbitrary package imports or testing kit.
// Supported authoring families: command, agent registry/spawn, clock, state, env, process, http, session identity, basic UI.
declare module "claude-code" {
  export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
  export type JsonObject = { [key: string]: Json }
  export interface EngineInterface {}
  export interface PluginState {}
  export type StateRef<P extends keyof PluginState,K extends keyof PluginState[P]> = { plugin:P;key:K;id?:string }
  export interface ProcessResult { code:number|null;signal:string|null }
  export interface ProcessChunk { stream:"stdout"|"stderr";text:string }
  export interface Stream<C,R> extends AsyncGenerator<C,R,unknown> { readonly result:Promise<R> }
  export interface ProcessOptions { cwd?:string;env?:Record<string,string>;stdin?:string;timeoutMs?:number }
  export interface AgentSpec {
    name:string;description:string;prompt:string;tools?:readonly string[];disallowedTools?:readonly string[];
    model?:string;
    /** Integer in the supported range 1..100. */
    maxTurns?:number;background?:true;omitClaudeMd?:true;permissionMode?:"default"|"plan"
  }
  export interface AgentSpawnInput {prompt:string;description?:string;subagentType?:string;model?:string;name?:string;cwd?:string}
  /** A hook answering without next starts no child and may omit agentId. */
  export type AgentSpawnResult = {agentId?:string;model:string}|{deny:string}
  export type OperationResult<T> = {value:T}|{deny:string}
  export interface AgentSpawnEvent extends AgentSpawnInput {
    description:string;subagentType:string;tool_use_id:string;parentModel:string;
    provider:{plugin:string;tier:string};parentAgentId?:string;background:true;fork:false
  }
  export interface TurnCompleteEvent {
    answer:string;durationMs:number;isAborted:boolean;turnId:string;agentId?:string;
    reason:"answer"|"aborted"|"error"|"refusal";
    refusal?:{category:string|null;explanation:string|null}
  }
  export type ModelUsage = {input_tokens:number;output_tokens:number;cache_read_input_tokens:number;cache_creation_input_tokens:number}
  export type ModelResult = {isAnswered:true;text:string;usage:ModelUsage} |
    {isAnswered:false;reason:"empty-reply"|"aborted";usage:ModelUsage} |
    {isAnswered:false;reason:"api-error";status:number|null;error:"rate_limit"|"overloaded"|"invalid_request"|"authentication_failed"|"server_error"|"unknown";usage:ModelUsage}
  export type ForkResult = ModelResult | {isAnswered:false;reason:"nothing-to-fork"}
  export interface ModelRequest {model:string;prompt:string;system?:string;maxTokens?:number}
  export interface FileStat {kind:"file"|"dir"|"other";size:number;mtimeMs:number;realPath?:string}
  export interface ToolInfo {name:string;description:string;mcp:boolean}
  export interface ToolResult {result:Json;text?:string;isError?:true;context?:string[];ref?:number}
  export interface UiEvent {component:string;requestId?:string;surface:"desktop";props:JsonObject;viewport?:{columns:number;rows:number}}
  export type UiTree = unknown
  export interface UiElements {
    Box(props:{children?:UiTree[];flexDirection?:"row"|"column";gap?:number;[key:string]:unknown}):UiTree
    Text(props:{children:string|string[];[key:string]:unknown}):UiTree
    Button(props:{label:string;onPress:()=>unknown;key?:string;hotkey?:string;[key:string]:unknown}):UiTree
    TextInput(props:{value:string;onChange:(value:string)=>unknown;key?:string;[key:string]:unknown}):UiTree
    Markdown(props:{text:string;[key:string]:unknown}):UiTree
  }
  export interface PromptSection {id:string;text:string;scope:"session"|"shared"}
  export interface PromptComposition {sections:PromptSection[]}
  export interface ToolEvent extends JsonObject {tool:string}
  export interface SDKBase<Owner extends string=string> {
    fs:{write(path:string,text:string):Promise<void>;read(path:string):Promise<string>;
      list(path?:string):Promise<(Omit<FileStat,"mtimeMs"> & {name:string;mtimeMs?:number})[]>;
      exists(path:string):Promise<boolean>;stat(path:string,options?:{resolve?:boolean}):Promise<FileStat>}
    // __MODEL_PROTOCOL_METHODS__
    plugin:{readonly name:string;readonly root:string}
    session:{id():Promise<string>;cwd():Promise<string>;surface():Promise<"desktop">;surfaces():Promise<"desktop"[]>}
    command:{register(input:{name:string;description:string;immediate?:boolean;argumentHint?:string;isHidden?:boolean}):Promise<void>}
    agent:{register(spec:AgentSpec):Promise<{agent:string}>;spawn(input:AgentSpawnInput):Promise<AgentSpawnResult>}
    clock:{now():Promise<number>;sleep(ms:number,options?:{signal?:AbortSignal}):Promise<void>;
      /** Maximum supported interval is 60000 ms. */
      after(ms:number,callback:()=>void|Promise<void>):{cancel():void};every(ms:number,callback:()=>void|Promise<void>):{cancel():void}}
    state:{get<P extends keyof PluginState,K extends keyof PluginState[P]>(ref:StateRef<P,K>):Promise<{value:PluginState[P][K]|undefined;version:number}>;
      set<P extends Extract<keyof PluginState,Owner>,K extends keyof PluginState[P]>(ref:StateRef<P,K>,value:PluginState[P][K],options?:{ifVersion?:number}):Promise<{isSet:boolean;version:number}>}
    env:{get(name:string):Promise<string|undefined>}
    process:{run(argv:string[],options?:ProcessOptions):Promise<{exitCode:number;stdout:string;stderr:string}>;spawn(input:ProcessEvent):Stream<ProcessChunk,ProcessResult>}
    http:{fetch(url:string,init?:{method?:string;headers?:Record<string,string>;body?:string}):Promise<{status:number;ok:boolean;headers:Record<string,string>;text:string}>}
    /** Tools are deferred by default; false publishes their schema immediately. */
    tool:{register(input:{name:string;description:string;inputSchema?:JsonObject;isDeferred?:boolean}):Promise<unknown>;
      call(input:JsonObject & {tool:string}):Promise<ToolResult|{deny:string}>;
      list():Promise<ToolInfo[]>;
      check(input:{tool:string;input:Json}):Promise<{decision:"allow"|"ask"|"deny";reason?:string;rule?:string;hook?:string;ceiling?:"allow"|"ask"|"deny"}>}
    store:{get(key:string):Promise<Json|undefined>;set(key:string,value:Json):Promise<void>;keys():Promise<string[]>;delete(key:string):Promise<void>}
    ui:{log(text:string):void;status(text?:string):void;toast(text:string):void;
      resolve(event:UiEvent):UiElements;invalidate(event:"ui.render"):void;
      open(input:{id:string;title?:string;focus?:boolean;closeOnEscape?:boolean}):Promise<{isPlaced:boolean}>;
      close(id:string):Promise<unknown>}
  }
  export type SDK<Owner extends string=string> = SDKBase<Owner> & EngineInterface
  export interface Next<E,R> { (event:E):Promise<R>;to(event:E,tier:"append"|"builtin"|"core"):Promise<R>;readonly signal:AbortSignal;readonly event:string }
  export interface NextStream<E> { (event:E):Stream<ProcessChunk,ProcessResult>;to(event:E,tier:"append"|"builtin"|"core"):Stream<ProcessChunk,ProcessResult>;readonly signal:AbortSignal;readonly event:string }
  export interface CommandEvent {command:string;args:string;origin?:Json;presentation?:Json}
  export interface CommandResult {text?:string;kind?:"complete"|"turn"}
  export interface ProcessEvent {argv:string[];cwd?:string;env?:Record<string,string>;input?:string}
  export interface On<Owner extends string=string> {
    (event:"ui.render",filter:{component:string;requestId?:string},handler:($:SDK<Owner>,event:UiEvent,next:Next<UiEvent,UiTree>)=>UiTree|Promise<UiTree>):void
    (event:"tool.call",handler:($:SDK<Owner>,event:ToolEvent,next:Next<ToolEvent,Json>)=>Json|Promise<Json>):void
    (event:"tool.call",filter:{tool:string},handler:($:SDK<Owner>,event:ToolEvent,next:Next<ToolEvent,Json>)=>Json|Promise<Json>):void
    (event:"prompt.submit",handler:($:SDK<Owner>,event:{text:string},next:Next<{text:string},Json>)=>Json|Promise<Json>):void
    (event:"prompt.compose",handler:($:SDK<Owner>,event:JsonObject,next:Next<JsonObject,PromptComposition>)=>PromptComposition|Promise<PromptComposition>):void
    // __MODEL_PROTOCOL_HOOKS__
    (event:"command.run",handler:($:SDK<Owner>,event:CommandEvent,next:Next<CommandEvent,CommandResult>)=>CommandResult|Promise<CommandResult>):{catch(handler:($:SDK<Owner>,event:CommandEvent,next:Next<CommandEvent,CommandResult>)=>CommandResult|Promise<CommandResult>):void}
    (event:"command.run",matcher:{command:string},handler:($:SDK<Owner>,event:CommandEvent,next:Next<CommandEvent,CommandResult>)=>CommandResult|Promise<CommandResult>):void
    (event:"session.start",handler:($:SDK<Owner>,event:{cwd:string;surface:"desktop";isInteractive:boolean},next:Next<{cwd:string;surface:"desktop";isInteractive:boolean},Json>)=>Json|Promise<Json>):void
    (event:"turn.complete",handler:($:SDK<Owner>,event:TurnCompleteEvent,next:Next<TurnCompleteEvent,Json>)=>unknown):void
    (event:"agent.register",handler:($:SDK<Owner>,event:AgentSpec,next:Next<AgentSpec,OperationResult<{agent:string}>>)=>OperationResult<{agent:string}>|Promise<OperationResult<{agent:string}>>):void
    (event:"agent.spawn",handler:($:SDK<Owner>,event:AgentSpawnEvent,next:Next<AgentSpawnEvent,AgentSpawnResult>)=>AgentSpawnResult|Promise<AgentSpawnResult>):void
    (event:"process.spawn",handler:($:SDK<Owner>,event:ProcessEvent,next:NextStream<ProcessEvent>)=>AsyncGenerator<ProcessChunk,ProcessResult,unknown>):void
  }
  export type Register<Owner extends string=string> = (on:On<Owner>,options:JsonObject)=>void
}
interface AbortSignal {readonly aborted:boolean;readonly reason:unknown;throwIfAborted():void;
  addEventListener(type:"abort",listener:()=>void,options?:{once?:boolean}):void;removeEventListener(type:"abort",listener:()=>void):void}
declare var AbortSignal:{prototype:AbortSignal;abort(reason?:unknown):AbortSignal;any(signals:AbortSignal[]):AbortSignal}
interface AbortController {readonly signal:AbortSignal;abort(reason?:unknown):void}
declare var AbortController:{prototype:AbortController;new():AbortController}
interface TextEncoder {readonly encoding:string;encode(text?:string):Uint8Array}
declare var TextEncoder:{prototype:TextEncoder;new():TextEncoder}
interface TextDecoder {decode(data?:ArrayBuffer|ArrayBufferView,options?:{stream?:boolean}):string}
declare var TextDecoder:{prototype:TextDecoder;new(label?:string,options?:{fatal?:boolean;ignoreBOM?:boolean}):TextDecoder}
declare function structuredClone<T>(value:T):T
declare function atob(value:string):string
declare function btoa(value:string):string
declare var crypto:{getRandomValues<T extends ArrayBufferView>(value:T):T;randomUUID():string;
  readonly subtle:{digest(algorithm:string|{name:string},data:ArrayBuffer|ArrayBufferView):Promise<ArrayBuffer>}}
declare var performance:{now():number}
`

/** Manifest-selected SDK types; never infer the model return shape from source expressions. */
export function functionAuthoringDeclarations(protocol: FunctionModelProtocol): string {
  const methods =
    protocol === "result-v1"
      ? "model:{complete(request:ModelRequest & {timeoutMs?:number}):Promise<ModelResult>;fork(request:{prompt:string}):Promise<ForkResult>;classify(text:string,labels:string[],options?:{model?:string;maxTokens?:number}):Promise<string|undefined>}"
      : "model:{complete(request:ModelRequest):Promise<string>;fork(request:{prompt:string;maxTokens?:number}):Promise<{text:string;usage?:Partial<ModelUsage>}|null>;classify(text:string,labels:string[],options?:{model?:string;maxTokens?:number}):Promise<string|undefined>}"
  const modern = protocol === "result-v1"
  const completeInput = modern ? "ModelRequest & {timeoutMs?:number}" : "ModelRequest"
  const completeOutput = modern ? "ModelResult" : "string"
  const forkInput = modern ? "{prompt:string}" : "{prompt:string;maxTokens?:number}"
  const forkOutput = modern ? "ForkResult" : "{text:string;usage?:Partial<ModelUsage>}|null"
  const hooks = [
    ["model.complete", completeInput, completeOutput],
    ["model.fork", forkInput, forkOutput]
  ]
    .map(
      ([event, input, output]) =>
        `(event:"${event}",handler:($:SDK<Owner>,event:${input},next:Next<${input},OperationResult<${output}>>)=>OperationResult<${output}>|Promise<OperationResult<${output}>>):void`
    )
    .join("\n")
  return (
    `// modelProtocol: ${protocol}; bounded desktop SDK, effort/options.signal unavailable.\n` +
    FUNCTION_AUTHORING_DECLARATIONS.replace("// __MODEL_PROTOCOL_METHODS__", methods).replace(
      "// __MODEL_PROTOCOL_HOOKS__",
      hooks
    )
  )
}
