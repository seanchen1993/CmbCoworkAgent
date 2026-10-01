// Synthetic, shared literals only. No credential, URL, local path, network or I/O.
export const now = '2026-10-01T12:00:00Z'
export const expiry = '2026-10-02T12:00:00Z'
export const digest = 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
export const prd = {artifactId:'artifact-prd',versionId:'prd-v1',digest}
export const assessment = {artifactId:'artifact-assessment',versionId:'assessment-v1',digest}
export const inputs = [prd, assessment]
export const budget = {maxTokens:10000,maxDurationSeconds:3600,maxToolCalls:100}
export const config = {description:'Synthetic requirement partner',instructions:'Analyze approved inputs only.',knowledgeRefs:['knowledge-1'],repositoryRefs:['repo-1'],skillAllowlist:['skill-1'],capabilityCeiling:['requirements.analyze','repository.read'],memoryPolicy:'explicit_only'}
const meta = id => ({id,spaceId:'space-1',version:1,createdAt:now,updatedAt:now})
export const bot = {...meta('bot-1'),name:'Analyst',status:'active',currentBotVersionId:'bot-v1',maintainerIds:['principal-1']}
export const botVersion = {id:'bot-v1',botId:bot.id,spaceId:bot.spaceId,number:1,config,createdAt:now}
export const groupBots = [{botId:bot.id,botVersionId:botVersion.id,role:'coordinator'}]
export const groupMembers = [{principalId:'principal-1',role:'admin'},{principalId:'business-1',role:'business_owner'},{principalId:'technical-1',role:'technical_owner'}]
export const limits = {maxHandoffs:10,maxRuns:20,maxTokens:100000}
export const group = {...meta('group-1'),name:'Independent team',bots:groupBots,members:groupMembers,limits}
export const task = {...meta('task-1'),groupId:group.id,taskNumber:'T-1024',title:'Synthetic requirement',goal:'Produce versioned handoff',status:'active',currentStageId:'stage-requirement',stages:['requirement','assessment','prototype','scope_confirmation','development'].map(kind => ({id:`stage-${kind}`,kind,status:kind === 'requirement' ? 'active' : 'pending',inputArtifactVersions:[],outputArtifactVersions:[]})),inputArtifactVersions:[]}
export const message = {id:'message-1',spaceId:'space-1',taskId:task.id,authorPrincipalId:'principal-1',text:'Clarify acceptance criteria.',artifactVersions:[],createdAt:now}
export const upload = {id:'upload-1',spaceId:'space-1',taskId:task.id,version:1,purpose:'prd',fileName:'requirement.txt',mediaType:'text/plain',sizeBytes:3,digest,status:'created',expiresAt:expiry}
export const artifact = {...meta(prd.artifactId),taskId:task.id,kind:'prd',currentVersionId:prd.versionId}
export const artifactVersion = {id:prd.versionId,artifactId:artifact.id,spaceId:'space-1',taskId:task.id,number:1,digest,mediaType:'text/plain',sizeBytes:3,blobRef:'blob-1',createdAt:now,createdBy:'principal-1'}
export const action = {capability:'command.execute',resourceRefs:['repo-1'],inputDigest:digest}
export const approval = {...meta('approval-business'),taskId:task.id,kind:'business_scope',inputArtifactVersions:inputs,approverIds:['business-1'],status:'pending',expiresAt:expiry}
export const technicalApproval = {...approval,id:'approval-technical',kind:'technical_handoff',approverIds:['technical-1']}
export const toolApproval = {...approval,id:'approval-tool',kind:'tool_action',requestedAction:action,approverIds:['principal-1']}
export const decision = {id:'decision-1',approvalId:approval.id,spaceId:'space-1',principalId:'business-1',decision:'approve',inputArtifactVersions:inputs,createdAt:now}
export const handoff = {...meta('handoff-1'),taskId:task.id,fromBotId:bot.id,toBotId:'bot-2',inputArtifactVersions:inputs,expectedOutput:'Versioned technical assessment',status:'pending',budget,deadline:expiry}
export const developmentHandoff = {id:'dev-handoff-1',spaceId:'space-1',taskId:task.id,commandId:'command-development',prd,assessment,repositoryRef:'repo-1',repositoryRevision:'revision-1',acceptanceCriteria:['Contract tests pass.'],exclusions:['Production deployment'],openQuestions:[],businessApprovalId:approval.id,technicalApprovalId:technicalApproval.id,createdAt:now}
export const capabilities = {modes:[{id:'requirement',version:1},{id:'assessment',version:1},{id:'prototype',version:1},{id:'project',version:1}],capabilities:['requirements.analyze','repository.read','prototype.generate','workspace.write','command.execute','requirements.publish'],recovery:'same_node_checkpoint',maxConcurrentRuns:2}
export const node = {...meta('node-1'),provider:'desktop',status:'online',capabilities,lastSeenAt:now}
export const workspace = {workspaceRef:'workspace-1',isolation:'task',access:'read',repositoryRef:'repo-1',repositoryRevision:'revision-1',inputArtifactVersions:inputs}
export const lease = {leaseId:'lease-1',fence:1,expiresAt:expiry,authorizationVersion:1}
export const run = {...meta('run-1'),taskId:task.id,stageId:'stage-assessment',botVersionId:botVersion.id,mode:{id:'assessment',version:1},inputArtifactVersions:inputs,status:'queued',requesterPrincipalId:'principal-1',budget,deadline:expiry}
export const attempt = {id:'attempt-1',spaceId:'space-1',runId:run.id,number:1,runtimeNodeId:node.id,status:'dispatched',lease}
export const runSpec = {schemaVersion:1,runId:run.id,attemptId:attempt.id,taskId:task.id,stageId:run.stageId,botVersionId:botVersion.id,mode:run.mode,contextManifestRef:'context-1',inputArtifactVersions:inputs,workspace,grant:{grantId:'grant-1',version:1},credentialBindings:[{credentialRef:'credential-1',purpose:'repository_read'}],approvalIds:[],budget,deadline:expiry}
export const delivery = {id:'delivery-1',spaceId:'space-1',runId:run.id,attemptId:attempt.id,eventId:'business-event-1',destinationRef:'destination-1',status:'pending',attempts:0}
export const event = {eventId:'business-event-1',spaceId:'space-1',seq:1,occurredAt:now,kind:'task_updated',taskId:task.id,entityRef:{kind:'task',id:task.id,version:2}}
const command = commandId => ({commandId})
const cas = commandId => ({commandId,expectedVersion:1})
export const requests = {
  createBot:{...command('command-bot'),name:bot.name,config,maintainerIds:bot.maintainerIds},
  createBotVersion:{...cas('command-bot-version'),config},
  createGroup:{...command('command-group'),name:group.name,bots:groupBots,members:groupMembers,limits},
  updateGroupMembers:{...cas('command-members'),bots:groupBots,members:groupMembers},
  createTask:{...command('command-task'),groupId:group.id,title:task.title,goal:task.goal,inputArtifactVersions:[]},
  createTaskMessage:{...cas('command-message'),text:message.text,artifactVersions:[]},
  transitionStage:{...cas('command-stage'),toStage:'assessment',inputArtifactVersions:inputs,approvalIds:[]},
  createUpload:{...command('command-upload'),taskId:task.id,purpose:upload.purpose,fileName:upload.fileName,mediaType:upload.mediaType,sizeBytes:3,digest},
  completeUpload:{...cas('command-complete'),digest,sizeBytes:3},
  createArtifact:{...cas('command-artifact'),uploadId:upload.id,kind:artifact.kind},
  createArtifactVersion:{...cas('command-artifact-version'),baseVersionId:artifactVersion.id,uploadId:'upload-2',changeDescription:'New immutable version.'},
  createApproval:{...cas('command-approval'),kind:approval.kind,inputArtifactVersions:inputs,approverIds:approval.approverIds,expiresAt:expiry},
  decideApproval:{...cas('command-decision'),decision:'approve',inputArtifactVersions:inputs},
  createHandoff:{...cas('command-handoff'),fromBotId:handoff.fromBotId,toBotId:handoff.toBotId,inputArtifactVersions:inputs,expectedOutput:handoff.expectedOutput,budget,deadline:expiry},
  createDevelopmentHandoff:{...cas('command-development'),prd,assessment,repositoryRef:'repo-1',repositoryRevision:'revision-1',acceptanceCriteria:developmentHandoff.acceptanceCriteria,exclusions:developmentHandoff.exclusions,openQuestions:[],businessApprovalId:approval.id,technicalApprovalId:technicalApproval.id},
  createRun:{...cas('command-run'),taskId:task.id,stageId:run.stageId,botId:bot.id,mode:run.mode,inputArtifactVersions:inputs,workspaceRef:workspace.workspaceRef,requestedCapabilities:['repository.read'],approvalIds:[],budget,deadline:expiry},
  cancelRun:{...cas('command-cancel'),reason:'User requested cancellation.'}
}
const operation = (operationId, path = {}, body, responses = []) => ({operationId,request:{path,headers:{'X-DevClaw-Space':'space-1'},...(body === undefined ? {} : {body})},responses})
const response = (status, body) => ({status,body})
export const operations = [
  operation('createBot',{},requests.createBot,[response(201,{bot,botVersion})]),
  operation('getBot',{botId:bot.id},undefined,[response(200,{bot,botVersion})]),
  operation('createBotVersion',{botId:bot.id},requests.createBotVersion,[response(201,{bot:{...bot,version:2,currentBotVersionId:'bot-v2'},botVersion:{...botVersion,id:'bot-v2',number:2}})]),
  operation('createGroup',{},requests.createGroup,[response(201,{group})]),
  operation('getGroup',{groupId:group.id},undefined,[response(200,{group})]),
  operation('updateGroupMembers',{groupId:group.id},requests.updateGroupMembers,[response(200,{group:{...group,version:2}})]),
  operation('createTask',{},requests.createTask,[response(201,{task})]),
  operation('getTask',{taskId:task.id},undefined,[response(200,{task,snapshotCursor:'cursor-0'})]),
  operation('createTaskMessage',{taskId:task.id},requests.createTaskMessage,[response(201,{message,taskVersion:2})]),
  operation('transitionStage',{taskId:task.id},requests.transitionStage,[response(200,{task:{...task,version:2,currentStageId:'stage-assessment',stages:task.stages.map(s => ({...s,status:s.kind === 'requirement' ? 'completed' : s.kind === 'assessment' ? 'active' : 'pending'}))}})]),
  operation('createUpload',{},requests.createUpload,[response(201,{upload})]),
  {...operation('putUploadContent',{uploadId:upload.id},'abc',[response(200,{upload:{...upload,version:2,status:'uploading'}})]),request:{path:{uploadId:upload.id},headers:{'X-DevClaw-Space':'space-1','X-Command-Id':'command-content','If-Match':'"1"'},body:'abc'}},
  operation('completeUpload',{uploadId:upload.id},{...requests.completeUpload,expectedVersion:2},[response(202,{upload:{...upload,version:3,status:'verifying'}}),response(200,{upload:{...upload,version:4,status:'committed'}})]),
  operation('createArtifact',{taskId:task.id},requests.createArtifact,[response(201,{artifact,artifactVersion})]),
  operation('createArtifactVersion',{artifactId:artifact.id},requests.createArtifactVersion,[response(201,{artifact:{...artifact,version:2,currentVersionId:'prd-v2'},artifactVersion:{...artifactVersion,id:'prd-v2',number:2,blobRef:'blob-2'}})]),
  operation('getArtifactVersion',{artifactId:artifact.id,versionId:artifactVersion.id},undefined,[response(200,{artifactVersion})]),
  operation('getArtifactContent',{artifactId:artifact.id,versionId:artifactVersion.id},undefined,[response(200,'abc')]),
  operation('createApproval',{taskId:task.id},requests.createApproval,[response(201,{approval})]),
  operation('decideApproval',{approvalId:approval.id},requests.decideApproval,[response(200,{approval:{...approval,version:2,status:'approved'},decision})]),
  operation('createHandoff',{taskId:task.id},requests.createHandoff,[response(202,{handoff})]),
  operation('createDevelopmentHandoff',{taskId:task.id},requests.createDevelopmentHandoff,[response(201,{handoff:developmentHandoff})]),
  operation('createRun',{},requests.createRun,[response(202,{run})]),
  operation('getRun',{runId:run.id},undefined,[response(200,{run,attempts:[]}),response(200,{run:{...run,status:'starting',activeAttemptId:attempt.id},attempts:[attempt]})]),
  operation('cancelRun',{runId:run.id},requests.cancelRun,[response(202,{run:{...run,version:2,status:'cancel_requested'}})]),
  {...operation('getEvents',{},undefined,[response(200,{events:[event],nextCursor:'cursor-1',hasMore:false})]),request:{path:{},headers:{'X-DevClaw-Space':'space-1'},query:{after:'cursor-0',limit:200}}},
  {operationId:'connectRuntime',request:{path:{},headers:{}},responses:[{status:101}]}
]
export const errorFixtures = [
  ...['INVALID_PAYLOAD','SCHEMA_VERSION_UNSUPPORTED','UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','VERSION_CONFLICT','COMMAND_CONFLICT','COMMAND_EXPIRED','INPUT_CHANGED','APPROVAL_REQUIRED','APPROVAL_EXPIRED','NODE_OFFLINE','CAPABILITY_UNAVAILABLE','OUTCOME_UNKNOWN','CURSOR_EXPIRED','PAYLOAD_TOO_LARGE','RATE_LIMITED','DEPENDENCY_UNAVAILABLE'].map(code => ({requestId:'request-1',error:{code,message:'Synthetic safe error.',retryable:code === 'RATE_LIMITED' || code === 'DEPENDENCY_UNAVAILABLE',...(code === 'VERSION_CONFLICT' ? {currentVersion:2} : {}),...(code === 'RATE_LIMITED' ? {retryAfterSeconds:30} : {})}}))
]
const runtimeBase = {runId:run.id,attemptId:attempt.id}
export const runtimeEvent = {...runtimeBase,eventId:'event-1',nodeId:node.id,eventSeq:1,leaseId:lease.leaseId,fence:lease.fence,authorizationVersion:lease.authorizationVersion,occurredAt:now,eventType:'progress',data:{summary:'Preparing verified workspace.'}}
const envelope = (type, body, suffix = type) => ({protocol:'devclaw.bot.runtime',schemaVersion:1,messageId:`runtime-${suffix}`,type,body})
export const runtime = [
  envelope('register',{nodeId:node.id,provider:node.provider,capabilities}),
  envelope('registered',{nodeId:node.id,connectionId:'connection-1',heartbeatIntervalSeconds:30,serverTime:now}),
  envelope('heartbeat',{nodeId:node.id,connectionId:'connection-1',activeAttempts:[{...runtimeBase,fence:1}],sentAt:now}),
  envelope('prepare_workspace',{requestId:'request-1',...runtimeBase,workspace,grant:runSpec.grant,lease}),
  envelope('workspace_prepared',{requestId:'request-1',...runtimeBase,workspaceRef:workspace.workspaceRef,inputDigest:digest}),
  envelope('start',{run:runSpec,lease}),
  envelope('accepted',{...runtimeBase,leaseId:lease.leaseId,fence:1}),
  envelope('cancel',{...runtimeBase,leaseId:lease.leaseId,fence:1,reason:'User cancellation.'}),
  envelope('inspect',{requestId:'request-1',...runtimeBase}),
  envelope('inspection',{requestId:'request-1',...runtimeBase,status:'accepted',lastEventSeq:0,fence:1}),
  envelope('inspection',{requestId:'request-1',...runtimeBase,status:'running',lastEventSeq:1,fence:1,checkpointRef:'checkpoint-1'},'inspection-with-event'),
  envelope('resume',{run:{...runSpec,attemptId:'attempt-2'},lease:{...lease,leaseId:'lease-2',fence:2},checkpointRef:'checkpoint-1'}),
  envelope('event',runtimeEvent,'event-progress'),
  envelope('event',{...runtimeEvent,eventType:'waiting_approval',data:{approvalId:approval.id}},'event-waiting-approval'),
  envelope('event',{...runtimeEvent,eventType:'artifact_committed',data:{artifact:prd}},'event-artifact'),
  ...['succeeded','failed','cancelled','outcome_unknown'].map(outcome => envelope('event',{...runtimeEvent,eventType:'completed',data:{outcome,artifactVersions:inputs,...(outcome === 'outcome_unknown' ? {errorCode:'OUTCOME_UNKNOWN'} : {})}},`event-completed-${outcome}`)),
  envelope('ack',{eventId:runtimeEvent.eventId,...runtimeBase,eventSeq:1}),
  envelope('error',{requestId:'request-1',code:'OUTCOME_UNKNOWN',message:'Inspect and reconcile before further execution.',retryable:false})
]
export const dtoFixtures = [
  ['EntityMeta',meta('entity-1')],['CredentialBinding',runSpec.credentialBindings[0]],['ThreadBinding',{spaceId:'space-1',taskId:task.id,stageId:run.stageId,runtimeNodeId:node.id,provider:'adapter-desktop',localThreadId:'thread-1'}],
  ['ProjectBinding',{handoffId:developmentHandoff.id,provider:'adapter-project',projectId:'project-1',featureRef:'feature-1',localThreadId:'thread-2',createdAt:now}],
  ['RuntimeNode',node],['Delivery',delivery],['Approval',technicalApproval],['Approval',toolApproval],
  ['CreateApprovalRequest',{...requests.createApproval,kind:'technical_handoff',approverIds:['technical-1']}],
  ['CreateApprovalRequest',{...requests.createApproval,kind:'tool_action',requestedAction:action,approverIds:['principal-1']}],
  ['WorkspaceSpec',{workspaceRef:'workspace-material',isolation:'task',access:'write',inputArtifactVersions:inputs}],
  ['EventsResult',{events:[],nextCursor:'cursor-0',hasMore:false}],
  ['DevelopmentHandoff',{...developmentHandoff,prototype:{artifactId:'artifact-prototype',versionId:'prototype-v1',digest}}]
]
