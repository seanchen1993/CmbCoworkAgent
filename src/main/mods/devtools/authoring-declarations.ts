import type { FunctionModelProtocol } from "../../../shared/mods/v2/model-protocol"
import {
  FUNCTION_COMPATIBILITY_EVENT_NAMES,
  getFunctionEventSupport
} from "../../../shared/mods/v2/compatibility-catalog"
/** Deliberately closed authoring subset; absence here is not a runtime compatibility claim. */
export const FUNCTION_AUTHORING_DECLARATIONS = String.raw`// CMB Mods authoring contract, desktop subset v2.
// This is not the complete upstream SDK. No DOM, Node, arbitrary package imports or testing kit.
// Supported authoring families: command, agent registry/spawn, clock, state, env, process, http, session identity, basic UI.
declare namespace DevClawMods {
  export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
  export type JsonObject = { [key: string]: Json }
  export interface EngineInterface {}
  export interface PluginState {}
  export interface StateSource<T> {readonly __stateValue?:T}
  export interface Atom<T> extends StateSource<T> {readonly ref:{plugin:string;key:string;id?:string};readonly initial:T;readonly shape?:string}
  export interface Derived<T> extends StateSource<T> {}
  export type StateValue<S> = S extends StateSource<infer T> ? T : unknown
  /** VM helper exports; host state checks and owner-only writes still apply. */
  export function atom<T>(ref:{plugin:string;key:string;id?:string},initial:T,options?:{shape?:string}):Atom<T>
  export function derive<S extends readonly StateSource<unknown>[],T>(sources:S,compute:(...values:{[K in keyof S]:StateValue<S[K]>})=>T):Derived<T>
  export function memberOf<T>(family:Atom<T>,event:{requestId:string}):Atom<T>
  export function memberOf<P extends keyof PluginState,K extends keyof PluginState[P]>(family:StateRef<P,K>,event:{requestId:string}):StateRef<P,K>
  export function read<T>(sdk:Pick<SDKBase,"state">,source:StateSource<T>):Promise<T>
  export function update<T>(sdk:Pick<SDKBase,"state">,target:Atom<T>,change:(previous:T)=>T):Promise<T>
  export type StateRef<P extends keyof PluginState,K extends keyof PluginState[P]> = { plugin:P;key:K;id?:string }
  export interface ProcessResult { code:number|null;signal:string|null }
  export interface ProcessChunk { stream:"stdout"|"stderr";text:string }
  export interface Stream<C,R> extends AsyncGenerator<C,R,unknown> { readonly result:Promise<R> }
  export interface ProcessOptions {
    cwd?:string;env?:Record<string,string>;stdin?:string;timeoutMs?:number;
    /** Require one native process execution with unchanged normalized request and original result. Hooks may observe or deny; substitutions fail closed. Does not add permissions. */
    integrity?:"native"
  }
  export interface AgentSpec {
    name:string;description:string;prompt:string;tools?:readonly string[];disallowedTools?:readonly string[];
    model?:string;
    /** Integer in the supported range 1..100. */
    maxTurns?:number;background?:true;omitClaudeMd?:true;permissionMode?:"default"|"plan"
  }
  export interface AgentSpawnInput {prompt:string;description?:string;subagentType?:string;model?:string;name?:string;cwd?:string}
  /** A hook answering without next starts no child and may omit agentId. */
  export type AgentSpawnResult = {agentId?:string;model:string}|{deny:string}
  export interface AgentInfo {id:string;description:string;type:string;status:string;parentId?:string;spawnedBy?:string;name?:string}
  export type AgentTaskState = "running"|"stopping"|"completed"|"failed"|"cancelled"|"unknown"
  export interface AgentTaskStatus {agentId:string;status:AgentTaskState;model:string;description:string;startedAt:number;finishedAt?:number;
    scope:{workspace:string;readOnly:boolean;allowedTools?:string[];blockedTools:string[];maxTurns?:number};
    outcome?:{answer:string;reason:string;durationMs:number;isAborted:boolean};diagnostic?:string}
  export interface AgentTaskMessage {role:"user"|"assistant";text:string;toolUses:JsonObject[];toolResults?:JsonObject[]}
  export interface AgentTaskMessages {agentId:string;messages:AgentTaskMessage[];nextCursor?:string;truncated:boolean;skippedMessages:number;history:"retained"|"partial"|"unavailable"}
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
  /** Native, immutable manifest and static scan facts for one hooks module. */
  export interface PluginRegisterUses {
    events:readonly string[];calls:readonly string[];
    env?:{reads:readonly string[];writes:readonly string[]};
    state?:{reads:readonly {plugin:string;key:string}[];writes:readonly {plugin:string;key:string}[]}
  }
  export interface PluginRegisterEvent {
    name:string;tier:"prepend"|"user"|"append"|"builtin";root:string;version?:string;
    /** Desktop host source, e.g. name@local or name@development; never a fabricated marketplace. */
    provenance:string;uses:PluginRegisterUses
  }
  export type PluginRegisterResult = {allow:true;refuse?:never}|{refuse:string;allow?:never}
  export interface CaughtNext<Input,Output> extends Next<Input,Output> {
    readonly called:boolean;readonly error:{kind:string;message?:string;budget:number}
  }
  export interface HookHandle<Input,Output,Owner extends string=string> {
    catch(handler:($:SDK<Owner>,event:Input,next:CaughtNext<Input,Output>)=>Output|Promise<Output>):void
  }
  /** Real local desktop binding only; it is not a Remote Control online status. */
  export interface DesktopAttachEvent {surface:"desktop";clientId:string}
  export interface DesktopDetachEvent extends DesktopAttachEvent {reason:"detach"|"end"}
  export interface ClassicWorktreeRemoveEvent {
    hook_event_name:"WorktreeRemove";session_id:string;transcript_path:string;cwd:string;
    worktree_path:string;permission_mode?:string;agent_id?:string
  }
  /** Bounded cleanup observer: reads and local records, without starting a native writer. */
  export type WorktreeObserverSDK<Owner extends string=string> = Pick<SDKBase<Owner>,"plugin"|"state"|"store"|"settings"> & {
    session:Pick<SDKBase<Owner>["session"],"id"|"cwd"|"root"|"version"|"surface"|"surfaces"|"repo"|"model"|"messages"|"turns"|"usage">;
    fs:Pick<SDKBase<Owner>["fs"],"ancestors"|"read"|"exists"|"stat"|"list">;
    clock:Pick<SDKBase<Owner>["clock"],"now"|"sleep">;ui:Pick<SDKBase<Owner>["ui"],"log">;
    config:Pick<SDKBase<Owner>["config"],"list">;env:Pick<SDKBase<Owner>["env"],"get">
  }
  /** DevClaw extension; native skill facts are immutable through next(). */
  export interface ClassicSkillUseEvent {
    hook_event_name:"PreSkillUse"|"PostSkillUse";session_id:string;transcript_path:string;cwd:string;
    skill_name:string;skill_path:string;skill_root:string;skill_trigger_tool_name:string;
    permission_mode?:string;agent_id?:string;tool_name?:string;tool_input?:Json;tool_response?:Json;
    plugin_id?:string;plugin_name?:string;plugin_root?:string;
    stop_context?:{userMessage?:string;assistantResponse?:string;toolCalls?:string[];usedSkills?:string[]}
  }
  export interface ClassicSkillUseResult {
    block?:string;preventContinuation?:true;stopReason?:string;additionalContext?:string[]
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
  export type UiSpace = number|"xs"|"sm"|"md"|"lg"|"xl"
  /** Desktop layout. Dimensions are character/line units or 0..100%; spacing numbers are 8px. Positioning is clipped to the plugin subtree. No arbitrary DOM/CSS. */
  export interface UiBoxProps {
    key?:string;children?:UiTree[];
    flexDirection?:"row"|"column"|"row-reverse"|"column-reverse";
    /** Finite 0..100. */
    flexGrow?:number;flexShrink?:number;
    flexWrap?:"nowrap"|"wrap"|"wrap-reverse";
    alignItems?:"flex-start"|"center"|"flex-end"|"stretch";
    alignSelf?:"auto"|"flex-start"|"center"|"flex-end"|"stretch";
    justifyContent?:"flex-start"|"center"|"flex-end"|"space-between"|"space-around"|"space-evenly";
    gap?:UiSpace;padding?:UiSpace;paddingX?:UiSpace;paddingY?:UiSpace;
    margin?:UiSpace;marginX?:UiSpace;marginY?:UiSpace;marginTop?:UiSpace;
    /** Additional spacing is finite 0..128; use minWidth:0 and flexShrink for narrow layouts. */
    rowGap?:UiSpace;columnGap?:UiSpace;paddingTop?:UiSpace;paddingBottom?:UiSpace;paddingLeft?:UiSpace;paddingRight?:UiSpace;
    marginBottom?:UiSpace;marginLeft?:UiSpace;marginRight?:UiSpace;
    width?:number|string;height?:number|string;minWidth?:number|string;minHeight?:number|string;
    borderStyle?:string;borderColor?:string;backgroundColor?:string;overflow?:"visible"|"hidden";
    position?:"relative"|"absolute";top?:number;left?:number;right?:number;bottom?:number;
    display?:"flex"|"none";borderDimColor?:boolean;
    /** Local keyed Box hover only, no cross-site scope. */
    hover?:{borderStyle?:string;borderColor?:string;borderDimColor?:boolean;backgroundColor?:string;
      display?:"flex";top?:number;left?:number;right?:number;bottom?:number}
  }
  export interface UiTextProps {
    key?:string;children:string|UiTree[];color?:string;backgroundColor?:string;
    bold?:boolean;italic?:boolean;underline?:boolean;strikethrough?:boolean;inverse?:boolean;dimColor?:boolean;
    size?:"caption"|"footnote"|"body"|"heading"|"title";
    weight?:"regular"|"medium"|"semibold"|"bold";mono?:boolean;tabular?:boolean;
    /** Full text remains available to selection/accessibility. Explicit weight outranks bold. */
    wrap?:"wrap"|"end"|"middle"|"truncate"|"truncate-start"|"truncate-end"|"truncate-middle";
    dir?:"ltr"|"rtl";
    /** Nearest keyed Box hover; scope is unsupported. */
    hover?:UiTextHover
  }
  export interface UiTextHover {color?:string;backgroundColor?:string;dimColor?:boolean;bold?:boolean;
    italic?:boolean;underline?:boolean;strikethrough?:boolean;inverse?:boolean}
  export interface UiElements {
    Box(props:UiBoxProps):UiTree
    Text(props:UiTextProps):UiTree
    Button(props:({label:string;children?:UiTree[]}|{label?:string;children:UiTree[]|string})&{
      onPress:()=>unknown;key?:string;hotkey?:string;plain?:true;dimColor?:boolean;autoFocus?:true;
      variant?:"primary"|"secondary";role?:"dismiss";hover?:UiTextHover}):UiTree
    Input(props:{key:string;label?:string;placeholder?:string;value?:string;submitLabel?:string;rows?:number;autoFocus?:true;onSubmit:(value:string)=>unknown;onInput?:(value:string)=>unknown}):UiTree
    Select(props:{key:string;label?:string;options:{value:string;label:string}[];value?:string;autoFocus?:true;onSelect:(value:string)=>unknown}):UiTree
    Code(props:{source:string;language?:string;path?:string;startLine?:number;format?:"source"|"diff";wrap?:"wrap"|"truncate-start"|"truncate-end"}):UiTree
    Link(props:{href:string;label?:string;children?:UiTree[]|string}):UiTree
    Svg(props:{source:string;alt?:string;width?:number;height?:number;isInteractive?:boolean}):UiTree
    /** Package-local QuickJS client module; not arbitrary JS, URL, Node or DOM. */
    Client(props:{key:string;module:string;props?:Json;width?:number;height?:number;flexGrow?:number}):UiTree
    TextInput(props:{value:string;onChange:(value:string)=>unknown;key?:string;[key:string]:unknown}):UiTree
    Markdown(props:{text:string;[key:string]:unknown}):UiTree
    List(props:JsonObject):UiTree
    Table(props:JsonObject):UiTree
    Tree(props:JsonObject):UiTree
    Chart(props:JsonObject):UiTree
    Log(props:JsonObject):UiTree
    Form(props:{key:string;fields:JsonObject[];values?:JsonObject;onSubmit:(json:string)=>unknown;[key:string]:unknown}):UiTree
  }
  export interface PromptSection {id:string;text:string;scope:"session"|"shared"}
  export interface PromptComposition {sections:PromptSection[]}
  export interface PromptDecoration {
    start:number;end:number;virtualText?:string;color?:string;backgroundColor?:string;
    dimColor?:boolean;bold?:boolean;italic?:boolean;underline?:boolean;strikethrough?:boolean
  }
  export interface PromptContext {blocks:{name:string;text:string}[];
    instructionFiles?:{path:string;kind:"managed"|"user"|"project"|"local"|"memory";content:string;parent?:string}[]}
  export interface PromptAttachment {type:string;text:string;
    origin:{kind:"engine"}|{kind:"hook"|"plugin";event:string};agentId?:string;detail?:JsonObject}
  export type NotifyResult = {isSent:true;channel:"desktop"}|{isSent:false;
    reason:"disabled"|"no-channel"|"no-surface"|"refused"|"rate-limit"|"failed"|"timeout"}
  export interface TelemetryChoice {value:string;of:readonly string[]}
  export type TelemetryProp = number|boolean|TelemetryChoice
  export interface TelemetryMark {feature:string;kind:"ok"|"sad"|"bad";reason?:string;props?:Readonly<Record<string,TelemetryProp>>}
  export type TelemetryLog = {to?:"anthropic";event:string;props?:Readonly<Record<string,TelemetryProp>>}|
    {to:"collector";event:string;attributes:Readonly<Record<string,string|number|boolean|readonly string[]>>;
      loggedAt:string;span?:{traceId:string;spanId:string;traceFlags:number}}
  export interface ConfigRow {key:string;label:string;description?:string;kind:"boolean"|"choice"|"text"|"number";
    value:string|boolean|number|string[];options?:string[];provider:{plugin:string;tier:string};isLocked:boolean}
  export interface SessionApiMessage {role:"user"|"assistant";content:JsonObject[]}
  export interface SessionAppendArgs {message:{type:"user"|"system";content:{type:"text";text:string}[]};agentId?:string}
  export interface ToolEvent extends JsonObject {tool:string}
  export interface PlatformRef {provider:string;id:string;version:string}
  export interface PlatformQuery {ref:PlatformRef;target:{kind:"current"}}
  export interface PlatformAction {id:string;title:string;inputSchema:JsonObject;outputSchema:JsonObject;
    requiredPermissions:string[];cancellable:boolean;idempotency:"keyed"}
  /** Existing public surface metadata. Host owns scope, initialization and Pane lifetime. */
  export type PlatformSurfacePresentation = {
    type:"surface";id:string;title:string;
    placement:"page"|"navigation"|"sidebar"|"toolbar"|"settings";
    paneId:string;openAction:string;closeAction?:string;order?:number;description?:string
  } & ({apiVersion:"devclaw.surface/v1";interaction?:never}|
    {apiVersion:"devclaw.surface/v2";interaction:"query"})
  export interface PlatformDescriptor {apiVersion:"devclaw.capability/v1";id:string;version:string;
    title:string;scope:"conversation"|"workspace";stateSchema:JsonObject;actions:PlatformAction[];presentation?:PlatformSurfacePresentation|JsonObject}
  export interface PlatformState {status:"ready"|"unknown";revision:number;
    source:{provider:string;digest:string;generation:string};value?:Json;reason?:string}
  export interface PlatformActionResult {requestKey:string;status:"running"|"succeeded"|"failed"|"cancelled"|"unknown";value?:Json;error?:string}
  export interface PlatformActionInput extends PlatformQuery {action:string;input:JsonObject;requestKey:string}
  export interface PlatformSdk {
    list():Promise<{status:"ready"|"unknown";capabilities:Array<{ref:PlatformRef;descriptor:PlatformDescriptor;available:boolean}>}>
    read(input:PlatformQuery):Promise<PlatformState>
    subscribe(input:PlatformQuery):Promise<{subscriptionId:string;revision:number}>
    poll(input:{subscriptionId:string;afterRevision:number}):Promise<{subscriptionId:string;revision:number;events:Array<{revision:number;value:Json}>;resync:boolean}>
    unsubscribe(input:{subscriptionId:string}):Promise<void>
    publish(input:{id:string;version:string;target:{kind:"current"};value:JsonObject;expectedRevision?:number}):Promise<PlatformState>
    act(input:PlatformActionInput,options?:{signal?:AbortSignal}):Promise<PlatformActionResult>
    cancel(input:PlatformQuery&{requestKey:string}):Promise<PlatformActionResult>
    status(input:PlatformQuery&{requestKey:string}):Promise<PlatformActionResult>
  }
  export interface SDKBase<Owner extends string=string> {
    /** Desktop-owned sources explicitly selected in the current Claw. Never supply URL/command/credentials. */
    mcp:{
      connect(sourceId:string,options?:{signal?:AbortSignal}):Promise<
        {isConnected:true;server:string}|{isConnected:false;reason:"unlisted"|"unapproved"|"disabled"|"policy"|"auth"|"failed";message:string}>;
      call(server:string,tool:string,args?:JsonObject):Promise<JsonObject>;
      /** Desktop extensions. Reading never initializes a server. */
      list(input?:Record<string,never>):Promise<{sources:{sourceId:string;name:string;configDigest:string}[];connections:McpConnectionStatus[]}>;
      status(input:{server:string}):Promise<McpConnectionStatus>;
      disconnect(input:{server:string}):Promise<McpConnectionStatus>
    }
    platform:PlatformSdk
    fs:{write(path:string,text:string):Promise<void>;read(path:string):Promise<string>;
      read(path:string,options:{as:"bytes"}):Promise<{base64:string}>;
      read(path:string,options:{as:"text"}):Promise<string>;
      ancestors(input:{names:string[];of?:string;below?:string}):Promise<{dir:string;name:string;content:string;parts:{path:string;content:string}[]}[]>;
      list(path?:string):Promise<(Omit<FileStat,"mtimeMs"> & {name:string;mtimeMs?:number})[]>;
      exists(path:string):Promise<boolean>;stat(path:string,options?:{resolve?:boolean}):Promise<FileStat>}
    // __MODEL_PROTOCOL_METHODS__
    plugin:{readonly name:string;readonly root:string}
    session:{id():Promise<string>;cwd():Promise<string>;root():Promise<string>;
      version():Promise<{version:string;base?:string;builtAt?:string}>;
      surface():Promise<"desktop">;surfaces():Promise<"desktop"[]>;
      /** Trusted organization policy only. Ordinary desktop plugins receive deny. */
      identity():Promise<{deny:string}>;
      model():Promise<string>;repo():Promise<{root:string;remote:string|null;internal:boolean;name:string|null}|null>;
      messages(options?:{agentId?:string}):Promise<AgentTaskMessage[]|{deny:string}>;
      messages(options:{as:"api";agentId?:string}):Promise<SessionApiMessage[]|{deny:string}>;
      turns():Promise<JsonObject[]>;usage(options?:{breakdown?:"summary"|"full";columns?:number}):Promise<JsonObject>;
      compact(options?:{instructions?:string}):Promise<Json>;
      /** No credentials are returned. Null when no host-owned authorization provider exists. */
      authorize():Promise<{handle:string;kind:"bearer"|"api-key"}|null>;
      send(input:{to:string|{sessionId:string}|{agentId:string};text:string}):Promise<{isDelivered:boolean}>;
      append(input:SessionAppendArgs):Promise<{message:JsonObject;uuid:string}|{deny:string}>}
    command:{register(input:{/** 1..64 ASCII letters, digits, underscore or hyphen; use description for Chinese labels. */name:string;description:string;immediate?:true;argumentHint?:string;isHidden?:boolean}):Promise<void>;
      list():Promise<JsonObject[]>;run(input:{command:string;args?:string}):Promise<CommandResult>}
    config:{list():Promise<ConfigRow[]>;set(input:{key:string;value:string|boolean|number|string[]}):Promise<{value:string|boolean|number|string[]}|{deny:string}>}
    prompt:{read():Promise<{text:string;cursor:number}>;
      fill(input:{text:string;mode?:"replace"|"append"|"insert";decorations?:PromptDecoration[]}):Promise<{text:string;cursor:number;isFilled:boolean;refusal?:"no_composer"|"dialog"}>;
      /** Display only. Nonempty decorations require exact text; without prompt.read the returned box is empty. */
      paint(input:{text?:string;decorations:PromptDecoration[]}):Promise<{isPainted:boolean;text:string;cursor:number}>;
      suggest(input:{text:string}):Promise<{isShown:boolean}>;
      compose(input?:JsonObject):Promise<PromptComposition>;context(input:PromptContext):Promise<PromptContext>;
      /** Text reminders only; this is not a media attachment API. */
      attachment(input:PromptAttachment):Promise<{text:string}>;
      submit(input:{text:string;asUser?:true}):Promise<JsonObject>}
    agent:{register(spec:AgentSpec):Promise<{agent:string}>;spawn(input:AgentSpawnInput):Promise<AgentSpawnResult>;
      list():Promise<AgentInfo[]>;status(input:{agentId:string}):Promise<AgentTaskStatus>;
      /** Own child only; limit 1..100, default 50. Cursor is bound to the retained transcript revision. */
      messages(input:{agentId:string;cursor?:string;limit?:number}):Promise<AgentTaskMessages>;
      stop(input:{agentId:string}):Promise<{agentId:string;stopRequested:boolean;status:AgentTaskState}>}
    clock:{now():Promise<number>;sleep(ms:number,options?:{signal?:AbortSignal}):Promise<void>;
      /** Maximum supported interval is 60000 ms. */
      after(ms:number,callback:()=>void|Promise<void>):{cancel():Promise<void>};every(ms:number,callback:()=>void|Promise<void>):{cancel():Promise<void>}}
    state:{get<P extends keyof PluginState,K extends keyof PluginState[P]>(ref:StateRef<P,K>):Promise<{value:PluginState[P][K]|undefined;version:number}>;
      set<P extends Extract<keyof PluginState,Owner>,K extends keyof PluginState[P]>(ref:StateRef<P,K>,value:PluginState[P][K],options?:{ifVersion?:number}):Promise<{isSet:boolean;version:number}>}
    env:{get(name:string):Promise<string|undefined>;
      /** Literal names, own session/process overlay only. Protected host variables return deny. */
      set(name:string,value:string|undefined):Promise<{deny?:string}>}
    telemetry:{log(input:TelemetryLog):Promise<void>;mark(input:TelemetryMark):Promise<void>;
      /** Desktop diagnostic extension. No upload to Anthropic or enterprise collector. */
      records():Promise<{delivery:"local-only";records:{method:string;at:number;input:JsonObject}[]}>}
    process:{run(argv:string[],options?:ProcessOptions):Promise<{exitCode:number;stdout:string;stderr:string}>;spawn(input:ProcessEvent):Stream<ProcessChunk,ProcessResult>}
    http:{fetch(url:string,init?:{method?:string;headers?:Record<string,string>;body?:string}):Promise<{status:number;ok:boolean;headers:Record<string,string>;text:string}>}
    /** Tools are deferred by default; false publishes their schema immediately. */
    tool:{register(input:{name:string;description:string;inputSchema?:JsonObject;isDeferred?:boolean}):Promise<unknown>;
      call(input:JsonObject & {tool:string}):Promise<ToolResult|{deny:string}>;
      list():Promise<ToolInfo[]>;
      check(input:{tool:string;input:Json}):Promise<{decision:"allow"|"ask"|"deny";reason?:string;rule?:string;hook?:string;ceiling?:"allow"|"ask"|"deny"}>}
    store:{get(key:string):Promise<Json|undefined>;set(key:string,value:Json):Promise<void>;keys():Promise<string[]>;delete(key:string):Promise<void>}
    turn:{abort(turnId:string):Promise<void>}
    settings:{read():Promise<JsonObject>}
    ui:{log(text:string,options?:{to?:"transcript"|"debug"}):void;status(text?:string):void;toast(text:string,options?:{timeoutMs?:number}):void;
      ask(question:string,options?:string[]|{options?:string[];header?:string;multiSelect?:boolean}):Promise<string>;
      notice(tool_use_id:string,text:string|undefined):void;
      /** Default desktop has no terminal channel; surface desktop explicitly requests native OS delivery. */
      notify(text:string,options?:{title?:string;surface?:"desktop"}):Promise<NotifyResult>;
      /** Terminal-only character Raster. Desktop returns deny; media source swaps are excluded. */
      blit(input:{requestId:string;key:string;cells:string;columns?:number;rows?:number}):Promise<{deny?:string}>;
      copy(input:{text:string;surface?:"terminal"|"desktop"|"mobile"|"vscode"}):Promise<{isCopied:true}|{isCopied:false;reason:"no-surface"|"no-clipboard"|"refused"}>;
      selection():Promise<{text:string;requestId?:string}|null>;
      panes():Promise<{id:string;title:string;isShown:boolean;isFocused:boolean;isPlaced:boolean}[]>;
      focus(input:{requestId:string;key:string}):Promise<{deny?:string}>;
      scroll(input:{to:"start"|"end"|{key:string}|{requestId:string};in?:string;block?:"start"|"center"|"end"|"nearest"}):Promise<{deny?:string}>;
      /** Ephemeral row in the current ordinary desktop chat. Does not enter model/history. */
      place(input:UiPlaceArgs):Promise<UiPlaceResult>;
      /** Desktop extension: genuine user control callback only; own child, explicit interactive mode. */
      view(input:{agentId:string;mode?:"readonly"|"interactive"}):Promise<{
        requested:true;agentId:string;mode:"readonly"|"interactive";readOnly:boolean;inputTarget:"parent"|"owned-child"}>;
      resolve(event:UiEvent):UiElements;invalidate(event:"ui.render"):void;
      open(input:{id:string;title?:string;focus?:boolean;closeOnEscape?:boolean;
        rows?:number;columns?:number;backgroundColor?:string;holdToasts?:true}):Promise<{isPlaced:boolean}>;
      close(id:string):Promise<unknown>}
  }
  export interface McpConnectionStatus {
    server:string;sourceId:string;configDigest:string;
    state:"connecting"|"connected"|"closing"|"closed"|"failed"|"unknown";toolCount:number;
    tools?:{name:string;description?:string;inputSchema?:JsonObject}[]
  }
  export type UiResolveConstructors = Pick<UiElements,"Box"|"Text"|"Button"|"Input"|"Select"|"Link"|"Code"|"Svg"|"Markdown"|"Client">
  export interface UiResolveEvent {surface:"desktop";component:string}
  export interface EngineBuildNext<Owner extends string=string> {
    (event:{plugins:string[]}):Promise<Omit<SDK<Owner>,"plugin">>
  }
  export type SDK<Owner extends string=string> = SDKBase<Owner> & EngineInterface
  export interface UiPlaceArgs {id:string}
  export type UiPlaceResult = {isPlaced:true;requestId:string}|{isPlaced:false;requestId?:string;reason:string}
  export interface PlacedProps {readonly id:string;readonly plugin:string}
  export interface Next<E,R> { (event:E):Promise<R>;to(event:E,tier:"append"|"builtin"|"core"):Promise<R>;readonly signal:AbortSignal;readonly event:string }
  export interface NextStream<E> { (event:E):Stream<ProcessChunk,ProcessResult>;to(event:E,tier:"append"|"builtin"|"core"):Stream<ProcessChunk,ProcessResult>;readonly signal:AbortSignal;readonly event:string }
  export interface CommandEvent {command:string;args:string;origin?:Json;presentation?:Json}
  export interface CommandResult {text?:string;kind?:"complete"|"turn"}
  export interface ProcessEvent {argv:string[];cwd?:string;env?:Record<string,string>;input?:string}
  export interface On<Owner extends string=string> {
    (event:"plugin.register",handler:($:SDK<Owner>,event:PluginRegisterEvent,next:Next<PluginRegisterEvent,PluginRegisterResult>)=>PluginRegisterResult|Promise<PluginRegisterResult>):HookHandle<PluginRegisterEvent,PluginRegisterResult,Owner>
    (event:"plugin.register",matcher:{name?:string;tier?:PluginRegisterEvent["tier"];provenance?:string},handler:($:SDK<Owner>,event:PluginRegisterEvent,next:Next<PluginRegisterEvent,PluginRegisterResult>)=>PluginRegisterResult|Promise<PluginRegisterResult>):HookHandle<PluginRegisterEvent,PluginRegisterResult,Owner>
    (event:"session.attach",handler:($:SDK<Owner>,event:DesktopAttachEvent,next:Next<DesktopAttachEvent,{clientId:string}>)=>{clientId:string}|Promise<{clientId:string}>):void
    (event:"session.attach",matcher:{surface?:"desktop";clientId?:string},handler:($:SDK<Owner>,event:DesktopAttachEvent,next:Next<DesktopAttachEvent,{clientId:string}>)=>{clientId:string}|Promise<{clientId:string}>):void
    (event:"session.detach",handler:($:SDK<Owner>,event:DesktopDetachEvent,next:Next<DesktopDetachEvent,{clientId:string}>)=>{clientId:string}|Promise<{clientId:string}>):void
    (event:"session.detach",matcher:{surface?:"desktop";clientId?:string;reason?:"detach"|"end"},handler:($:SDK<Owner>,event:DesktopDetachEvent,next:Next<DesktopDetachEvent,{clientId:string}>)=>{clientId:string}|Promise<{clientId:string}>):void
    (event:"classic.WorktreeRemove",handler:($:WorktreeObserverSDK<Owner>,event:ClassicWorktreeRemoveEvent,next:Next<ClassicWorktreeRemoveEvent,Record<string,never>>)=>Record<string,never>|Promise<Record<string,never>>):void
    (event:"classic.WorktreeRemove",matcher:{worktree_path?:string},handler:($:WorktreeObserverSDK<Owner>,event:ClassicWorktreeRemoveEvent,next:Next<ClassicWorktreeRemoveEvent,Record<string,never>>)=>Record<string,never>|Promise<Record<string,never>>):void
    (event:"engine.create",handler:($:Record<string,never>,event:{plugins:string[]},next:EngineBuildNext<Owner>)=>Record<string,unknown>|Promise<Record<string,unknown>>):void
    (event:"ui.resolve",handler:($:SDK<Owner>,event:UiResolveEvent,next:Next<UiResolveEvent,UiResolveConstructors>)=>UiResolveConstructors|Promise<UiResolveConstructors>):void
    (event:"ui.resolve",matcher:{component:string},handler:($:SDK<Owner>,event:UiResolveEvent,next:Next<UiResolveEvent,UiResolveConstructors>)=>UiResolveConstructors|Promise<UiResolveConstructors>):void
    // __CUSTOM_EVENT_HOOK__
    (event:"classic.PreSkillUse"|"classic.PostSkillUse",handler:($:SDK<Owner>,event:ClassicSkillUseEvent,next:Next<ClassicSkillUseEvent,ClassicSkillUseResult>)=>ClassicSkillUseResult|Promise<ClassicSkillUseResult>):void
    (event:"classic.PreSkillUse"|"classic.PostSkillUse",filter:{skill_name:string},handler:($:SDK<Owner>,event:ClassicSkillUseEvent,next:Next<ClassicSkillUseEvent,ClassicSkillUseResult>)=>ClassicSkillUseResult|Promise<ClassicSkillUseResult>):void
    capability(descriptor:PlatformDescriptor,handlers:{act:($:SDK<Owner>,event:{action:string;input:JsonObject;
      target:{kind:"current"};requestKey:string;capability:PlatformRef},next:Next<JsonObject,Json>)=>JsonObject|Promise<JsonObject>}):void
    (event:"ui.render",filter:{component:string;requestId?:string},handler:($:SDK<Owner>,event:UiEvent,next:Next<UiEvent,UiTree>)=>UiTree|Promise<UiTree>):void
    (event:"tool.call",handler:($:SDK<Owner>,event:ToolEvent,next:Next<ToolEvent,Json>)=>Json|Promise<Json>):void
    (event:"tool.call",filter:{tool:string},handler:($:SDK<Owner>,event:ToolEvent,next:Next<ToolEvent,Json>)=>Json|Promise<Json>):void
    (event:"prompt.submit",handler:($:SDK<Owner>,event:{text:string},next:Next<{text:string},Json>)=>Json|Promise<Json>):void
    (event:"prompt.compose",handler:($:SDK<Owner>,event:JsonObject,next:Next<JsonObject,PromptComposition>)=>PromptComposition|Promise<PromptComposition>):void
    (event:"prompt.section",handler:($:SDK<Owner>,event:{name:string;text:string},next:Next<{name:string;text:string},{text:string}>)=>{text:string}|Promise<{text:string}>):void
    (event:"prompt.section",filter:{name:string},handler:($:SDK<Owner>,event:{name:string;text:string},next:Next<{name:string;text:string},{text:string}>)=>{text:string}|Promise<{text:string}>):void
    // __MODEL_PROTOCOL_HOOKS__
    (event:"command.run",handler:($:SDK<Owner>,event:CommandEvent,next:Next<CommandEvent,CommandResult>)=>CommandResult|Promise<CommandResult>):{catch(handler:($:SDK<Owner>,event:CommandEvent,next:Next<CommandEvent,CommandResult>)=>CommandResult|Promise<CommandResult>):void}
    (event:"command.run",matcher:{command:string},handler:($:SDK<Owner>,event:CommandEvent,next:Next<CommandEvent,CommandResult>)=>CommandResult|Promise<CommandResult>):void
    (event:"session.start",handler:($:SDK<Owner>,event:{cwd:string;surface:"desktop";isInteractive:boolean},next:Next<{cwd:string;surface:"desktop";isInteractive:boolean},Json>)=>Json|Promise<Json>):void
    (event:"turn.complete",handler:($:SDK<Owner>,event:TurnCompleteEvent,next:Next<TurnCompleteEvent,Json>)=>unknown):void
    (event:"agent.register",handler:($:SDK<Owner>,event:AgentSpec,next:Next<AgentSpec,OperationResult<{agent:string}>>)=>OperationResult<{agent:string}>|Promise<OperationResult<{agent:string}>>):void
    (event:"agent.spawn",handler:($:SDK<Owner>,event:AgentSpawnEvent,next:Next<AgentSpawnEvent,AgentSpawnResult>)=>AgentSpawnResult|Promise<AgentSpawnResult>):void
    (event:"process.spawn",handler:($:SDK<Owner>,event:ProcessEvent,next:NextStream<ProcessEvent>)=>AsyncGenerator<ProcessChunk,ProcessResult,unknown>):void
    (event:"env.set",handler:($:SDK<Owner>,event:{name:string;value?:string},next:Next<{name:string;value?:string},OperationResult<{deny?:string}>>)=>OperationResult<{deny?:string}>|Promise<OperationResult<{deny?:string}>>):void
    (event:"env.set",matcher:{name?:string},handler:($:SDK<Owner>,event:{name:string;value?:string},next:Next<{name:string;value?:string},OperationResult<{deny?:string}>>)=>OperationResult<{deny?:string}>|Promise<OperationResult<{deny?:string}>>):void
    (event:"ui.notify",handler:($:SDK<Owner>,event:{text:string;title?:string;surface?:"desktop"},next:Next<{text:string;title?:string;surface?:"desktop"},OperationResult<NotifyResult>>)=>OperationResult<NotifyResult>|Promise<OperationResult<NotifyResult>>):void
    (event:"ui.notify",matcher:{title?:string;surface?:"desktop"},handler:($:SDK<Owner>,event:{text:string;title?:string;surface?:"desktop"},next:Next<{text:string;title?:string;surface?:"desktop"},OperationResult<NotifyResult>>)=>OperationResult<NotifyResult>|Promise<OperationResult<NotifyResult>>):void
    (event:"telemetry.log",handler:($:SDK<Owner>,event:TelemetryLog&{to:"anthropic"|"collector"},next:Next<TelemetryLog,OperationResult<undefined>>)=>OperationResult<undefined>|Promise<OperationResult<undefined>>):void
    (event:"telemetry.log",matcher:{to?:"anthropic"|"collector";event?:string},handler:($:SDK<Owner>,event:TelemetryLog&{to:"anthropic"|"collector"},next:Next<TelemetryLog,OperationResult<undefined>>)=>OperationResult<undefined>|Promise<OperationResult<undefined>>):void
    (event:"telemetry.mark",handler:($:SDK<Owner>,event:TelemetryMark,next:Next<TelemetryMark,OperationResult<undefined>>)=>OperationResult<undefined>|Promise<OperationResult<undefined>>):void
    (event:"telemetry.mark",matcher:{feature?:string;kind?:"ok"|"sad"|"bad"},handler:($:SDK<Owner>,event:TelemetryMark,next:Next<TelemetryMark,OperationResult<undefined>>)=>OperationResult<undefined>|Promise<OperationResult<undefined>>):void
    // __OTHER_EVENT_HOOKS__
  }
  export type Register<Owner extends string=string> = (on:On<Owner>,options:JsonObject)=>void
}
declare module "devclaw-mods" { export = DevClawMods }
declare module "claude-code" { export = DevClawMods }
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
    FUNCTION_AUTHORING_DECLARATIONS.replace("// __OTHER_EVENT_HOOKS__", otherEventHooks())
      .replace(
        "// __CUSTOM_EVENT_HOOK__",
        "(event:`${Extract<keyof EngineInterface,string>}.${string}`,handler:($:SDK<Owner>,event:JsonObject,next:Next<JsonObject,OperationResult<Json>>)=>OperationResult<Json>|Promise<OperationResult<Json>>):void"
      )
      .replace("// __MODEL_PROTOCOL_METHODS__", methods)
      .replace("// __MODEL_PROTOCOL_HOOKS__", hooks)
  )
}

/** Queryable one-event fragments; full types stay in the compiler, never injected each model turn. */
function otherEventHooks(): string {
  const already = new Set([
    "plugin.register",
    "session.attach",
    "session.detach",
    "classic.WorktreeRemove",
    "classic.PreSkillUse",
    "classic.PostSkillUse",
    "platform.action",
    "ui.render",
    "tool.call",
    "prompt.submit",
    "prompt.compose",
    "prompt.section",
    "command.run",
    "session.start",
    "turn.complete",
    "agent.register",
    "agent.spawn",
    "process.spawn",
    "env.set",
    "ui.notify",
    "telemetry.log",
    "telemetry.mark",
    "model.complete",
    "model.fork",
    "model.classify",
    "engine.create",
    "ui.resolve"
  ])
  return FUNCTION_COMPATIBILITY_EVENT_NAMES.filter(
    (name) => !already.has(name) && getFunctionEventSupport(name)?.availability === "bounded"
  )
    .map(
      (name) =>
        `(event:${JSON.stringify(name)},handler:($:SDK<Owner>,event:JsonObject,next:Next<JsonObject,Json>)=>Json|Promise<Json>):void\n` +
        `(event:${JSON.stringify(name)},matcher:JsonObject,handler:($:SDK<Owner>,event:JsonObject,next:Next<JsonObject,Json>)=>Json|Promise<Json>):void`
    )
    .join("\n")
}
