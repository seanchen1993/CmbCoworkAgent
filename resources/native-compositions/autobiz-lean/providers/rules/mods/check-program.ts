// The public Host authenticates references; this program additionally checks the actual bytes.
// Retained pure business algorithms run only in private scratch, with no legacy state writer.
export const program = String.raw`import sys,json,tempfile,hashlib,os,stat,re
from pathlib import Path

def require(ok, code):
    if not ok:
        raise ValueError(code)

def identity(value):
    return (value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns)

def ordinary(value):
    require(stat.S_ISREG(value.st_mode) and value.st_nlink == 1
            and not getattr(value,"st_file_attributes",0)&0x400, "LEAN_REFERENCE_FILE_TYPE")

ROLES={"baseline.verify":["baseline"], "definition.verify":["baseline","definition"],
       "solution.verify":["baseline","definition","solution"],
       "delivery.documents":["baseline","definition","solution","code","delivery"]}

def safe_path(path):
    require(isinstance(path,str) and 0<len(path)<=240 and "\\" not in path and ":" not in path
            and all(part not in {"",".",".."} and not part.startswith(".")
                and not re.search(r'[<>"|?*\x00-\x1f]|[. ]$',part)
                and not re.match(r'^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)',part,re.I)
                and not re.match(r'^(credentials?|secrets?|id_rsa)(?:\.|$)',part,re.I)
                for part in path.split("/")),"LEAN_REFERENCE_PATH_INVALID")
    parent=Path(".")
    for part in path.split("/")[:-1]:
        parent=parent/part
        value=os.lstat(parent)
        require(stat.S_ISDIR(value.st_mode) and not getattr(value,"st_file_attributes",0)&0x400,
                "LEAN_REFERENCE_FILE_TYPE")
    return path

def read_bytes(path,limit):
    safe_path(path)
    before=os.lstat(path)
    ordinary(before)
    require(0<before.st_size<=limit,"LEAN_REFERENCE_INVALID")
    fd=os.open(path,os.O_RDONLY|getattr(os,"O_BINARY",0)|getattr(os,"O_NOFOLLOW",0))
    with os.fdopen(fd,"rb") as handle:
        ordinary(os.fstat(handle.fileno()))
        require(identity(os.fstat(handle.fileno()))==identity(before),"LEAN_REFERENCE_CHANGED")
        raw=handle.read(limit+1)
        require(identity(os.fstat(handle.fileno()))==identity(before),"LEAN_REFERENCE_CHANGED")
    require(identity(os.lstat(path))==identity(before) and len(raw)==before.st_size,
            "LEAN_REFERENCE_CHANGED")
    return raw

def read_reference(reference, action, config):
    roles=config.get("artifactRoles")
    require(isinstance(roles,dict) and set(roles)==set(ROLES[action])
            and all(isinstance(value,str) and value for value in roles.values())
            and len(set(roles.values()))==len(roles),"LEAN_ARTIFACT_ROLES_INVALID")
    require(isinstance(reference,dict) and reference.get("protocol")=="devclaw.artifact-input/v1",
            "LEAN_HOST_ARTIFACT_REFERENCE_REQUIRED")
    current=reference.get("current",{})
    sources=reference.get("sources",[])
    require(isinstance(current,dict) and isinstance(sources,list)
            and len(sources)<8
            and current.get("artifactId")==roles[ROLES[action][-1]],"LEAN_REFERENCE_COVERAGE")
    texts={}
    ids={}
    for row in sources+[current]:
        path=row.get("path")
        limit=row.get("maxBytes")
        artifact_id=row.get("artifactId")
        require(isinstance(artifact_id,str) and artifact_id and artifact_id not in ids
                and isinstance(limit,int) and not isinstance(limit,bool) and 0<limit<=524288
                and isinstance(path,str) and path.lower() not in {name.lower() for name in texts}
                and isinstance(row.get("bytes"),int) and not isinstance(row["bytes"],bool)
                and 0<row["bytes"]<=limit and re.fullmatch(r"[a-f0-9]{64}",row.get("sha256","")),
                "LEAN_REFERENCE_INVALID")
        raw=read_bytes(path,limit)
        require(len(raw)==row["bytes"]
                and hashlib.sha256(raw).hexdigest()==row["sha256"],"LEAN_REFERENCE_CHANGED")
        texts[path]=raw.decode("utf-8",errors="strict")
        ids[artifact_id]=path
    require(all(value in ids for value in roles.values()),"LEAN_REFERENCE_COVERAGE")
    for role,artifact_id in roles.items():
        limit=524288 if role=="delivery" else 28000 if role=="code" else 131072
        require(len(texts[ids[artifact_id]].encode("utf-8"))<=limit,"LEAN_REFERENCE_LIMIT")
    require(sum(len(text.encode("utf-8")) for text in texts.values())<=1048576,
            "LEAN_REFERENCE_LIMIT")
    return texts,{role:ids[artifact_id] for role,artifact_id in roles.items()}

def record(value, required, optional=()):
    require(isinstance(value,dict) and set(required)<=set(value)
            and set(value)<=set(required)|set(optional),"LEAN_DOCUMENT_FIELDS_INVALID")

def baseline(value, provenance=None, project_id=None):
    record(value,["feature","request","requirements","decisions"])
    require(isinstance(value["feature"],str) and re.fullmatch(r"[a-zA-Z0-9][\w.-]{0,63}",value["feature"]),
            "LEAN_BASELINE_FEATURE_INVALID")
    request=value["request"]
    record(request,["protocol","projectId","text","bytes","sha256"])
    require(request["protocol"]=="devclaw.project-goal/v1"
            and isinstance(request["projectId"],str) and request["projectId"]
            and (project_id is None or request["projectId"]==project_id)
            and isinstance(request["text"],str) and request["text"].strip()
            and len(request["text"].encode("utf-8"))<=32768
            and type(request["bytes"]) is int
            and request["bytes"]==len(request["text"].encode("utf-8"))
            and request["sha256"]==hashlib.sha256(request["text"].encode("utf-8")).hexdigest(),
            "LEAN_BASELINE_REQUEST_INVALID")
    if provenance is not None:
        record(provenance,["protocol","projectId","bytes","sha256"])
        require(type(provenance["bytes"]) is int
                and all(request[key]==provenance[key] for key in provenance),"LEAN_REQUEST_PROVENANCE_CHANGED")
    requirements=value["requirements"]
    require(isinstance(requirements,list) and 0<len(requirements)<=128,"LEAN_BASELINE_REQUIREMENTS_INVALID")
    ids=set()
    for item in requirements:
        record(item,["id","text","sourceQuote"])
        require(isinstance(item["id"],str) and re.fullmatch(r"USR-\d{3}",item["id"])
                and item["id"] not in ids and isinstance(item["text"],str) and item["text"].strip()
                and len(item["text"].encode("utf-8"))<=4000
                and isinstance(item["sourceQuote"],str) and item["sourceQuote"].strip()
                and item["sourceQuote"] in request["text"],"LEAN_BASELINE_REQUIREMENT_INVALID")
        ids.add(item["id"])
    require(isinstance(value["decisions"],list) and len(value["decisions"])<=128,
            "LEAN_BASELINE_DECISIONS_INVALID")
    seen=set()
    for item in value["decisions"]:
        record(item,["id","text","requirementIds"])
        require(isinstance(item["id"],str) and re.fullmatch(r"DECISION-\d{3}",item["id"])
                and item["id"] not in seen and isinstance(item["text"],str) and item["text"].strip()
                and isinstance(item["requirementIds"],list) and item["requirementIds"]
                and all(isinstance(key,str) and key in ids for key in item["requirementIds"])
                and len(set(item["requirementIds"]))==len(item["requirementIds"]),
                "LEAN_BASELINE_DECISION_INVALID")
        seen.add(item["id"])
    return value

def definition(value, base, base_text, definition_path):
    record(value,["feature","baselineSha256","requirementIds","requirementCoverage",
                  "baselineDecisions","decisionCoverage",
                  "requirements","prd","scope","ui","proposal","specs"],
           ["sourceContext","sourceTexts"])
    require(value["feature"]==base["feature"]
            and value["baselineSha256"]==hashlib.sha256(base_text.encode("utf-8")).hexdigest()
            and value["requirementIds"]==[item["id"] for item in base["requirements"]]
            and value["requirements"]==[item["text"] for item in base["requirements"]],
            "LEAN_BASELINE_REQUIREMENTS_CHANGED")
    require(value["baselineDecisions"]==base["decisions"],"LEAN_BASELINE_DECISIONS_CHANGED")
    require(isinstance(value["specs"],dict) and value["specs"],"LEAN_SPECS_REQUIRED")
    coverage=value["requirementCoverage"]
    require(isinstance(coverage,dict) and set(coverage)==set(value["requirementIds"]),
            "LEAN_REQUIREMENT_COVERAGE_INVALID")
    for refs in coverage.values():
        require(isinstance(refs,list) and refs and all(isinstance(ref,str) for ref in refs)
                and len(set(refs))==len(refs),"LEAN_REQUIREMENT_COVERAGE_INVALID")
        kinds=set()
        for ref in refs:
            match=re.fullmatch(r"specs/([a-z0-9]+(?:-[a-z0-9]+)*)/spec.md#((REQ|SCN)-\d{3})",ref)
            require(match is not None and isinstance(value["specs"].get(match[1]),str),
                    "LEAN_REQUIREMENT_REFERENCE_MISSING")
            heading=r"^### Requirement " if match[3]=="REQ" else r"^#### Scenario "
            require(re.search(heading+re.escape(match[2])+r":",value["specs"][match[1]],re.M),
                    "LEAN_REQUIREMENT_REFERENCE_MISSING")
            kinds.add(match[3])
        require(kinds=={"REQ","SCN"},"LEAN_REQUIREMENT_COVERAGE_INVALID")
    decision_coverage=value["decisionCoverage"]
    require(isinstance(decision_coverage,dict)
            and set(decision_coverage)=={item["id"] for item in base["decisions"]},
            "LEAN_DECISION_COVERAGE_INVALID")
    for item in base["decisions"]:
        refs=decision_coverage[item["id"]]
        require(isinstance(refs,list) and refs and all(isinstance(ref,str) for ref in refs)
                and len(set(refs))==len(refs),"LEAN_DECISION_COVERAGE_INVALID")
        allowed={ref for key in item["requirementIds"] for ref in coverage[key]}
        require(set(refs)<=allowed,"LEAN_DECISION_REQUIREMENT_REFERENCE_INVALID")
        for key in item["requirementIds"]:
            linked=set(refs)&set(coverage[key])
            require(any("#REQ-" in ref for ref in linked) and any("#SCN-" in ref for ref in linked),
                    "LEAN_DECISION_REQUIREMENT_REFERENCE_INVALID")
    feature=value["feature"]
    lineage="来源："+definition_path+".requirements"
    require(isinstance(value["prd"],str) and lineage in value["prd"],
            "LEAN_REQUIREMENT_LINEAGE_REQUIRED")
    prd={"PRD.md":value["prd"].replace(lineage,"来源：NORMALIZED_REQUIREMENTS.json"),
         "IMPLEMENTATION_SCOPE.json":json.dumps(value["scope"],ensure_ascii=False),
         "UI_CONTEXT.json":json.dumps(value["ui"],ensure_ascii=False)}
    if "sourceContext" in value:
        prd["source-context.json"]=json.dumps(value["sourceContext"],ensure_ascii=False)
    sources=value.get("sourceTexts",{})
    require(isinstance(sources,dict) and all(re.fullmatch(r"sources/SRC-\d{3}/[a-zA-Z0-9_.-]+",key)
            for key in sources),"LEAN_SOURCE_PATH_INVALID")
    prd.update(sources)
    require(all(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*",key) for key in value["specs"]),
            "LEAN_CAPABILITY_ID_INVALID")
    specs={"proposal.md":value["proposal"],"UI_CONTEXT.json":json.dumps(value["ui"],ensure_ascii=False),
           **{"specs/"+key+"/spec.md":text for key,text in value["specs"].items()}}
    return {"normalized":{"feature":feature,"revision":2,"requirements":value["requirements"]},
            "prd":{"feature":feature,"stage":"prd","files":prd},
            "specs":{"feature":feature,"stage":"specs","files":specs}}

def solution(value, feature):
    record(value,["feature","design","designLock","plan","batches"])
    require(value["feature"]==feature and isinstance(value["batches"],dict)
            and all(re.fullmatch(r"B\d{3}",key) for key in value["batches"]),"LEAN_SOLUTION_IDENTITY_INVALID")
    return {"design":{"feature":feature,"stage":"design","files":{
                "design.md":value["design"],".design-contract.lock.json":json.dumps(value["designLock"],ensure_ascii=False)}},
            "plan":{"feature":feature,"stage":"plan","files":{
                "plan.json":json.dumps(value["plan"],ensure_ascii=False),
                **{"plans/"+key+"/plan.json":json.dumps(batch,ensure_ascii=False)
                   for key,batch in value["batches"].items()}}}}

def check(payload, texts, paths):
    from check import run
    action=payload["action"]
    provenance=payload["reference"].get("requestProvenance")
    if not payload.get("inspect"):
        require(isinstance(provenance,dict),"LEAN_REQUEST_PROVENANCE_REQUIRED")
    base_text=texts[paths["baseline"]]
    base=baseline(json.loads(base_text),provenance,payload["reference"].get("projectId"))
    if action=="baseline.verify":
        return {"passed":True,"errors":[],"warnings":[],"requestSha256":base["request"]["sha256"]}
    defined=json.loads(texts[paths["definition"]])
    request=definition(defined,base,base_text,paths["definition"])
    if action=="definition.verify":
        return run({**request,"stage":"specs","current":request["specs"]})
    solved=json.loads(texts[paths["solution"]])
    request.update(solution(solved,defined["feature"]))
    checked=run({**request,"stage":"plan","current":request["plan"]})
    if not checked["passed"] or action=="solution.verify":
        return checked
    delivered=json.loads(texts[paths["delivery"]])
    record(delivered,["feature","codeRunId","publication","checklist","prBody","archive"])
    code=json.loads(texts[paths["code"]])
    record(code,["feature","runId"])
    require(delivered["feature"]==defined["feature"]==code["feature"]
            and isinstance(code["runId"],str) and code["runId"]
            and delivered["codeRunId"]==code["runId"],"LEAN_DELIVERY_IDENTITY_INVALID")
    require(delivered["publication"]=={"mode":"not-requested","status":"prepared-only"},
            "LEAN_PUBLICATION_PROVIDER_REQUIRED")
    text=delivered["checklist"]
    require(isinstance(text,str) and isinstance(delivered["prBody"],str) and delivered["prBody"].strip()
            and all(marker in text for marker in ["## 交付范围","## 验证证据","## 发布状态",
              "## 已知阻断问题","## 回滚计划","未请求外部发布","prepared-only",code["runId"],
              *[paths[role] for role in ["baseline","definition","solution","code"]]]),
            "LEAN_DELIVERY_DOCUMENTS_INVALID")
    archive=delivered["archive"]
    require(isinstance(archive,dict) and set(archive)=={paths[role] for role in ["baseline","definition","solution","code"]},
            "LEAN_ARCHIVE_COVERAGE_INVALID")
    for name,row in archive.items():
        record(row,["text","sha256"])
        require(row["text"]==texts[name] and row["sha256"]==hashlib.sha256(texts[name].encode("utf-8")).hexdigest(),
                "LEAN_ARCHIVE_SOURCE_CHANGED:"+name)
    return {"passed":True,"errors":[],"warnings":[],"publicationStatus":"prepared-only"}

payload=json.load(sys.stdin)
try:
    if payload["action"]=="solution.inspect":
        record(payload["reference"],["artifactPaths"])
        paths=payload["reference"]["artifactPaths"]
        require(isinstance(paths,dict) and set(paths)=={"baseline","definition","solution"}
                and all(isinstance(path,str) for path in paths.values())
                and len({path.lower() for path in paths.values()})==len(paths),"LEAN_INSPECT_INPUT_INVALID")
        rows=[]
        for role in ["baseline","definition","solution"]:
            name=paths[role]
            raw=read_bytes(name,131072)
            rows.append({"artifactId":role,"path":name,"maxBytes":131072,
                         "bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest()})
        payload["reference"]={"protocol":"devclaw.artifact-input/v1","current":rows[2],"sources":rows[:2]}
        payload["config"]={"artifactRoles":{role:role for role in paths}}
        payload["inspect"]=True
        payload["action"]="solution.verify"
    texts,paths=read_reference(payload["reference"],payload["action"],payload.get("config",{}))
    with tempfile.TemporaryDirectory(prefix="autobiz-lean-rules-") as directory:
        scratch=Path(directory)
        for name,text in payload["rules"].items():
            path=scratch/name
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(text,encoding="utf-8")
        sys.path.insert(0,str(scratch))
        report=check(payload,texts,paths)
    # Validate the same captured files again after running the retained rules.
    after,after_paths=read_reference(payload["reference"],payload["action"],payload.get("config",{}))
    require(after==texts and after_paths==paths,"LEAN_REFERENCE_CHANGED")
    report["inputDigests"]={name:hashlib.sha256(text.encode("utf-8")).hexdigest() for name,text in texts.items()}
    report["artifactPaths"]=paths
    report["inputSha256"]=payload["reference"]["current"]["sha256"]
except Exception as error:
    report={"passed":False,"errors":[{"code":str(error)}],"warnings":[]}
print(json.dumps(report,ensure_ascii=False))
sys.exit(0 if report["passed"] else 1)
`
