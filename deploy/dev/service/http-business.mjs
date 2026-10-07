import { isDeepStrictEqual } from "node:util"
import { httpCall } from "./http-client.mjs"
import { httpSql } from "./http-sql.mjs"

const check=x=>{if(!x)throw Error("C2_BUSINESS_ASSERTION")},copy=x=>JSON.parse(JSON.stringify(x)),bytes=x=>Buffer.from(JSON.stringify(x))
export async function httpBusiness(server,runtime,entry,data,state,signal){
  const {create,append,group,members,reverse}=data,{first,bot,version,createdGroup,g,update,updated}=state
  let denials=0,replays=0;const facts=()=>httpSql(runtime,entry,"facts",{},signal)
  async function call(op,method,path,body,principal="p1",space="A",headers={}){return httpCall(server,op,method,path,{body,principal,space,headers,signal})}
  async function denied(op,method,path,body,status,code,principal="p1",space="A",headers={}){
    const before=await facts(),r=await call(op,method,path,body,principal,space,headers)
    check(r.status===status&&r.value.error.code===code&&isDeepStrictEqual(before,await facts()));denials++
  }
  async function replay(op,method,path,body,original,principal="p1"){
    const before=await facts(),r=await call(op,method,path,body,principal)
    check(r.status===original.status&&r.body.equals(original.body)&&isDeepStrictEqual(before,await facts()));replays++
  }
  const bp=`/api/bot/v1/bots/${bot.bot.id}`,gp=`/api/bot/v1/groups/${g.id}`
  // Actual number representations on four writes; object key order changes,
  // arrays retain their original order, old expectedVersion replays before CAS.
  for(const [op,method,path,body,original,principal] of [["createBot","POST","/api/bot/v1/bots",create("create"),first,"p1"],["createBotVersion","POST",bp+"/versions",append("append",1),version,"p1"],["createGroup","POST","/api/bot/v1/groups",group("group",bot),createdGroup,"p1"],["updateGroupMembers","PUT",gp+"/members",update,updated,"p4"]]){
    await replay(op,method,path,bytes(reverse(body)),original,principal)
    if(body.expectedVersion!==undefined)for(const number of ["1.0","1e0"])await replay(op,method,path,Buffer.from(JSON.stringify(body).replace('"expectedVersion":1',`"expectedVersion":${number}`)),original,principal)
    if(body.limits)for(const number of ["3.0","3e0"])await replay(op,method,path,Buffer.from(JSON.stringify(body).replace('"maxRuns":3',`"maxRuns":${number}`)),original,principal)
  }
  await denied("createBot","POST","/api/bot/v1/bots",{...create("create"),name:"different"},409,"COMMAND_CONFLICT")
  await denied("createBotVersion","POST",bp+"/versions",append("append",2),409,"COMMAND_CONFLICT")
  await denied("createBotVersion","POST",bp+"/versions",append("stale",1),409,"VERSION_CONFLICT")
  await denied("updateGroupMembers","PUT",gp+"/members",{...update,commandId:"stale"},409,"VERSION_CONFLICT","p4")
  await denied("getBot","GET",bp,{},400,"INVALID_PAYLOAD")
  await denied("getBot","GET",bp,null,403,"FORBIDDEN","p4")
  await denied("getGroup","GET",gp,null,403,"FORBIDDEN","p2")
  await denied("createBot","POST","/api/bot/v1/bots",create("no-create"),403,"FORBIDDEN","p3","A",{"X-DevClaw-Actor":"p1"})
  await denied("createGroup","POST","/api/bot/v1/groups",group("no-create",bot),403,"FORBIDDEN","p3")
  await denied("createBot","POST","/api/bot/v1/bots",create("inactive"),403,"FORBIDDEN","disabled")
  await denied("createBot","POST","/api/bot/v1/bots",create("foreign-actor"),403,"FORBIDDEN","foreign")
  await denied("createBot","POST","/api/bot/v1/bots",{...create("forged"),principalId:"p1"},400,"INVALID_PAYLOAD")
  const badMaintainer=create("foreign-maintainer");badMaintainer.maintainerIds=["p1","foreign"];await denied("createBot","POST","/api/bot/v1/bots",badMaintainer,403,"FORBIDDEN")
  badMaintainer.maintainerIds=["p1","p1"];await denied("createBot","POST","/api/bot/v1/bots",badMaintainer,400,"INVALID_PAYLOAD")
  const badRef=create("no-reference");badRef.config.repositoryRefs=["unknown"];await denied("createBot","POST","/api/bot/v1/bots",badRef,403,"FORBIDDEN")
  badRef.config.repositoryRefs=["allowed"];badRef.config.capabilityCeiling=["command.execute"];await denied("createBot","POST","/api/bot/v1/bots",badRef,403,"FORBIDDEN")
  const foreignGroup=group("foreign-member",bot);foreignGroup.members.push({principalId:"foreign",role:"participant"});await denied("createGroup","POST","/api/bot/v1/groups",foreignGroup,403,"FORBIDDEN")
  const duplicate=group("duplicate-member",bot);duplicate.members.push(duplicate.members[0]);await denied("createGroup","POST","/api/bot/v1/groups",duplicate,400,"INVALID_PAYLOAD")
  const coordinator=group("coordinator",bot);coordinator.bots[0].role="coordinator";await denied("createGroup","POST","/api/bot/v1/groups",coordinator,400,"INVALID_PAYLOAD")
  const missing=group("missing-bot",bot);missing.bots[0].botId="missing";await denied("createGroup","POST","/api/bot/v1/groups",missing,400,"INVALID_PAYLOAD")
  const noAdmin=group("no-admin",bot);noAdmin.members=[{principalId:"p1",role:"participant"}];await denied("createGroup","POST","/api/bot/v1/groups",noAdmin,400,"INVALID_PAYLOAD")
  const extraBot=await call("createBot","POST","/api/bot/v1/bots",create("other-bot"));check(extraBot.status===201)
  await denied("createBotVersion","POST",`/api/bot/v1/bots/${extraBot.value.bot.id}/versions`,append("append",1),409,"COMMAND_CONFLICT")
  const otherGroup=await call("createGroup","POST","/api/bot/v1/groups",group("other-group",bot));check(otherGroup.status===201)
  await denied("updateGroupMembers","PUT",`/api/bot/v1/groups/${otherGroup.value.group.id}/members`,update,409,"COMMAND_CONFLICT","p4")
  const wrongVersion=group("wrong-version",bot);wrongVersion.bots[0].botVersionId=extraBot.value.botVersion.id;await denied("createGroup","POST","/api/bot/v1/groups",wrongVersion,400,"INVALID_PAYLOAD")
  const foreignBot=await call("createBot","POST","/api/bot/v1/bots",create("create"),"p1","B");check(foreignBot.status===201&&foreignBot.value.bot.id!==bot.bot.id)
  const crossed=group("cross-space",foreignBot.value);await denied("createGroup","POST","/api/bot/v1/groups",crossed,400,"INVALID_PAYLOAD")
  const secondPrincipal=await call("createBot","POST","/api/bot/v1/bots",create("create"),"p2");check(secondPrincipal.status===201&&secondPrincipal.value.bot.id!==bot.bot.id)
  await denied("updateGroupMembers","PUT",gp+"/members",{...copy(update),commandId:"not-maintainer",expectedVersion:2,bots:[{...g.bots[0],botVersionId:version.value.botVersion.id}]},403,"FORBIDDEN","p4")
  await denied("updateGroupMembers","PUT",gp+"/members",{...copy(update),commandId:"new-not-maintainer",expectedVersion:2,bots:[{botId:extraBot.value.bot.id,botVersionId:extraBot.value.botVersion.id,role:"specialist"}]},403,"FORBIDDEN","p4")
  await denied("updateGroupMembers","PUT",gp+"/members",{...copy(update),commandId:"participant",expectedVersion:2},403,"FORBIDDEN","p3")
  await denied("getBot","GET",bp,null,404,"NOT_FOUND","p1","B")
  // Legal bytes and strict exact-number boundaries, not Ajv/JSON.parse rounding.
  for(const text of ["1.0000000000000001","0.99999999999999999","9007199254740990.5","9007199254740991.1","9007199254740992"]){
    await denied("createBotVersion","POST",bp+"/versions",Buffer.from(JSON.stringify(append("precision",1)).replace('"expectedVersion":1',`"expectedVersion":${text}`)),400,"INVALID_PAYLOAD")
  }
  await httpSql(runtime,entry,"pointer",{space:"A",target:bot.bot.id,version:bot.botVersion.id},signal)
  await denied("getBot","GET",bp,null,503,"DEPENDENCY_UNAVAILABLE")
  await httpSql(runtime,entry,"pointer",{space:"A",target:bot.bot.id,version:version.value.botVersion.id},signal)
  const receiptFixture={space:"A",principal:"p1",command:"create"},corrupt=copy(first.value);corrupt.bot.name="tampered"
  await httpSql(runtime,entry,"receipt-body",{...receiptFixture,body:bytes(corrupt).toString("base64")},signal)
  await denied("createBot","POST","/api/bot/v1/bots",create("create"),503,"DEPENDENCY_UNAVAILABLE")
  await httpSql(runtime,entry,"receipt-body",{...receiptFixture,body:first.body.toString("base64")},signal)
  await httpSql(runtime,entry,"disable-bot",{space:"A",target:bot.bot.id},signal)
  await replay("createBot","POST","/api/bot/v1/bots",create("create"),first)
  await denied("createBotVersion","POST",bp+"/versions",append("disabled",2),403,"FORBIDDEN")
  await denied("createGroup","POST","/api/bot/v1/groups",group("disabled-binding",bot),403,"FORBIDDEN")
  const unchanged={...copy(update),commandId:"unchanged-disabled",expectedVersion:2};const unchangedResult=await call("updateGroupMembers","PUT",gp+"/members",unchanged,"p4");check(unchangedResult.status===200&&unchangedResult.value.group.version===3)
  await httpSql(runtime,entry,"enable-bot",{space:"A",target:bot.bot.id},signal)
  await httpSql(runtime,entry,"revoke-bot",{space:"A",target:bot.bot.id},signal)
  await denied("createBot","POST","/api/bot/v1/bots",{...create("create"),name:"different"},403,"FORBIDDEN")
  await httpSql(runtime,entry,"restore-bot",{space:"A",target:bot.bot.id},signal)
  const downgrade={...copy(update),commandId:"downgrade",expectedVersion:3,members:members().map(m=>m.principalId==="p1"?{...m,role:"participant"}:m)}
  const down=await call("updateGroupMembers","PUT",gp+"/members",downgrade);check(down.status===200&&down.value.group.version===4)
  await denied("updateGroupMembers","PUT",gp+"/members",downgrade,403,"FORBIDDEN")
  await denied("createGroup","POST","/api/bot/v1/groups",group("group",bot),403,"FORBIDDEN")
  const restore={...copy(update),commandId:"restore-admin",expectedVersion:4};const restored=await call("updateGroupMembers","PUT",gp+"/members",restore,"p4");check(restored.status===200&&restored.value.group.version===5)
  await httpSql(runtime,entry,"expire",receiptFixture,signal)
  await denied("createBot","POST","/api/bot/v1/bots",{...create("create"),name:"different"},409,"COMMAND_EXPIRED")
  const maximum=create("maximum-text");maximum.config.description=maximum.config.instructions=maximum.config.persona="🚀".repeat(16384)
  const max=await call("createBot","POST","/api/bot/v1/bots",maximum);check(max.status===201&&max.value.botVersion.config.persona===maximum.config.persona)
  const maxRead=await call("getBot","GET",`/api/bot/v1/bots/${max.value.bot.id}`);check(maxRead.status===200&&isDeepStrictEqual(max.value.botVersion.config,maxRead.value.botVersion.config))
  check(version.value.botVersion.id!==bot.botVersion.id&&!isDeepStrictEqual(bot.botVersion.config,version.value.botVersion.config))
  console.log(JSON.stringify({stage:"http-business-proof",denials,replays,allNineFactsOnEveryDenial:true,maxTextCodepoints:16384,NULAndIsolatedSurrogate:true,currentAuthBeforeReceipt:true,expiredTombstone:true,noPhysicalFK:true}))
  return {denials,replays,groupVersion:5,maximumBotId:max.value.bot.id}
}
