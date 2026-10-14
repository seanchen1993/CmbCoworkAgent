import { createHash } from "node:crypto"
import { Worker } from "node:worker_threads"

export const NATIVE_POLICY_MIRROR_VERSION = "cmb.native-baseline/v1"
export const NATIVE_POLICY_MAX_EXPANDED_NODES = 1_000_000

/** Application source only. No plugin, workspace path or executable request is interpolated. */
export const NATIVE_POLICY_WORKER_SOURCE = String.raw`
const {parentPort}=require("node:worker_threads");
const version="cmb.native-baseline/v1";
const maxExpandedNodes=${NATIVE_POLICY_MAX_EXPANDED_NODES};
const mask="[REDACTED]";
const tokens=/\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g;
const bearer=/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const preKey=/^(?:authorization|password|secret|access_token|refresh_token|api[-_]?key|accountNumber)$/i;
const policyKey=/^(authorization|password|secret|access_token|refresh_token|api[-_]?key|accountNumber|base64|dataUrl)$/i;
function pass(root,policy,literals,rules){
  let remainingNodes=maxExpandedNodes-1;
  function reserveChildren(count){
    if(!Number.isSafeInteger(count)||count<0||count>remainingNodes)
      throw Error("MODS_NATIVE_CAPTURE_EXPANSION");
    remainingNodes-=count;
  }
  const result={value:null},stack=[{input:root,parent:result,key:"value"}];
  while(stack.length){
    const {input,parent,key,field}=stack.pop();
    if(field&&(policy?policyKey.test(key):(preKey.test(key)||key==="base64"||key==="dataUrl"))){
      if(policy)rules.add("credential-field");parent[key]=mask;continue;
    }
    if(input==null){parent[key]=null;continue}
    if(typeof input==="string"){
      let text=input.replace(tokens,()=>{if(policy)rules.add("credential-token");return mask})
        .replace(bearer,()=>{if(policy)rules.add("bearer");return "Bearer "+mask});
      if(policy)for(const literal of literals)if(text.includes(literal)){
        rules.add("deployment-literal");text=text.split(literal).join(mask);
      }
      parent[key]=text;continue;
    }
    if(typeof input==="number"){parent[key]=Number.isFinite(input)?input:null;continue}
    if(typeof input==="boolean"){parent[key]=input;continue}
    if(typeof input!=="object")throw Error("MODS_NATIVE_POLICY_DATA");
    if(Array.isArray(input)){
      reserveChildren(input.length);
      const out=new Array(input.length);parent[key]=out;
      for(let i=input.length-1;i>=0;i--)stack.push({input:input[i],parent:out,key:i});
      continue;
    }
    const keys=Object.keys(input);reserveChildren(keys.length);
    const out=Object.create(null);parent[key]=out;
    const children=[];
    for(const name of keys){
      if(!policy&&["__proto__","constructor","prototype"].includes(name))continue;
      const value=input[name];if(value===undefined)continue;
      out[name]=null;children.push({input:value,parent:out,key:name,field:true});
    }
    for(let i=children.length-1;i>=0;i--)stack.push(children[i]);
  }
  return result.value;
}
parentPort.once("message",request=>{
  try{
    if(!request||request.version!==version||typeof request.id!=="string"||
      !Array.isArray(request.literals)||request.literals.length>64||
      request.literals.some(x=>typeof x!=="string"||x.length<1||x.length>256))
      throw Error("MODS_NATIVE_POLICY_REQUEST");
    const rules=new Set();
    const pre=pass(request.value,false,request.literals,rules);
    const value=pass(pre,true,request.literals,rules);
    parentPort.postMessage({id:request.id,version,ok:true,value,
      ruleIds:["baseline-v1",...rules]});
  }catch(error){
    parentPort.postMessage({id:request&&request.id,version,ok:false,
      code:error instanceof Error&&error.message==="MODS_NATIVE_CAPTURE_EXPANSION"
        ?"MODS_NATIVE_CAPTURE_EXPANSION":"MODS_NATIVE_POLICY_FAILURE"});
  }finally{parentPort.close()}
});`

export const NATIVE_POLICY_MIRROR_DIGEST = createHash("sha256")
  .update(NATIVE_POLICY_WORKER_SOURCE)
  .digest("hex")

export function createNativePolicyWorker(): Worker {
  return new Worker(NATIVE_POLICY_WORKER_SOURCE, {
    eval: true,
    name: "cmb-native-policy"
  })
}
