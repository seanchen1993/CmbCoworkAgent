/** Installed unchanged by the packaged journey; also exercised by the real Guest contract test. */
export const NATIVE_WORKFLOW_OBSERVER_SOURCE = `export function register(on){
  const query={ref:{provider:"native.workflow",id:"runs",version:"1.0.0"},target:{kind:"current"}};
  on("session.start",async($,e,next)=>{
    await $.tool.register({name:"observe",description:"Read original native workflow facts",isDeferred:false,
      inputSchema:{type:"object",additionalProperties:false,required:["stage"],properties:{stage:{type:"string"},subscriptionId:{type:"string"},runId:{type:"string"},afterRevision:{type:"integer",minimum:0}}}});
    return next(e);
  });
  on("tool.call",{tool:"mcp__native_workflow_reader__observe"},async($,e)=>{
    const capabilities=await $.platform.list();
    const state=await $.platform.read(query);
    if(e.stage==="LIVE"){
      const subscription=await $.platform.subscribe(query);
      const pages=[];
      for(let i=0;i<2;i++)pages.push(await $.platform.act({...query,action:"inspect",requestKey:"live-page-"+i,input:{runId:state.value.run.runId,agentOffset:i,worktreeOffset:i,limit:1}}));
      return {result:{fixture:"WF_OBSERVER_LIVE",capabilities,state,subscription,pages}};
    }
    if(e.stage==="ISOLATION"){
      const foreign=await $.platform.act({...query,action:"inspect",requestKey:"foreign-run",input:{runId:e.runId,limit:1}});
      let rejection="";try{await $.platform.poll({subscriptionId:e.subscriptionId,afterRevision:e.afterRevision})}catch(error){rejection=error.message}
      return {result:{fixture:"WF_OBSERVER_ISOLATION",state,foreign,rejection}};
    }
    const events=await $.platform.poll({subscriptionId:e.subscriptionId,afterRevision:e.afterRevision});
    await $.platform.unsubscribe({subscriptionId:e.subscriptionId});
    let releasedReason="";try{await $.platform.poll({subscriptionId:e.subscriptionId,afterRevision:e.afterRevision})}catch(error){releasedReason=error.message}
    return {result:{fixture:"WF_OBSERVER_TERMINAL",state,events,releasedReason}};
  });
}`
