// Application-owned pure policy. Its source is part of the release digest; ordinary
// plugins cannot replace it, call next, invoke capabilities, or alter execution facts.
export const MANAGED_POLICY_SOURCE = String.raw`
var __cmbMod={default:{register(on){
  on.command({id:"admit",command:"policy:admit"},async($,e)=>{
    if(e.deployment.denyTools.includes(e.toolId))return {allow:false,code:"TOOL_DENIED"};
    return {allow:true};
  });
  on.command({id:"filter",command:"policy:filter"},async($,e)=>{
    const rules=new Set();
    const visit=(v)=>{
      if(typeof v==="string"){
        let text=v.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g,()=>{rules.add("credential-token");return "[REDACTED]"})
          .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,()=>{rules.add("bearer");return "Bearer [REDACTED]"});
        for(const literal of e.deployment.redactLiterals){
          if(text.includes(literal)){rules.add("deployment-literal");text=text.split(literal).join("[REDACTED]")}
        }
        return text;
      }
      if(Array.isArray(v))return v.map(visit);
      if(v&&typeof v==="object"){
        const out={};
        for(const key of Object.keys(v)){
          if(/^(authorization|password|secret|access_token|refresh_token|api[-_]?key|accountNumber|base64|dataUrl)$/i.test(key)){
            rules.add("credential-field");out[key]="[REDACTED]";
          }else out[key]=visit(v[key]);
        }
        return out;
      }
      return v;
    };
    return {allow:true,value:visit(e.value),ruleIds:[...rules]};
  });
}}};`
