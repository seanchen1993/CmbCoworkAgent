import type { SDK } from "devclaw-mods"
const program = String.raw`import sys,json,tempfile,hashlib,os,stat,re
from pathlib import Path

def require(ok, code):
    if not ok:
        raise ValueError(code)

def identity(value):
    return (value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns)

def ordinary(value):
    require(stat.S_ISREG(value.st_mode) and value.st_nlink == 1
            and not getattr(value,"st_file_attributes",0)&0x400, "LEAN_REFERENCE_FILE_TYPE")

def read_reference(reference, action, roles):
    required={"inspect":["baseline","definition","solution"],
              "code.verify":["baseline","definition","solution","code"],
              "delivery.verify":["baseline","definition","solution","code","delivery"]}[action]
    names={"baseline":"RequestBaseline.json","definition":"Definition.json","solution":"Solution.json",
           "code":"Code.json","delivery":"Delivery.json"}
    require(isinstance(reference,dict) and reference.get("protocol")=="devclaw.artifact-input/v1",
            "LEAN_HOST_ARTIFACT_REFERENCE_REQUIRED")
    current=reference.get("current",{})
    sources=reference.get("sources",[])
    require(isinstance(sources,list) and len(sources)<8 and isinstance(roles,dict)
            and set(required)<=set(roles) and set(roles)<=set(names)
            and all(isinstance(value,str) and value for value in roles.values())
            and len(set(roles.values()))==len(roles),"LEAN_REFERENCE_COVERAGE")
    rows=sources+[current]
    require(all(isinstance(row,dict) for row in rows)
            and len({row.get("artifactId") for row in rows})==len(rows)
            and len({row.get("path") for row in rows})==len(rows),"LEAN_REFERENCE_COVERAGE")
    by_id={row.get("artifactId"):row for row in rows}
    require(set(roles.values())<=set(by_id)
            and current.get("artifactId")==roles[required[-1]],"LEAN_REFERENCE_COVERAGE")
    texts={}
    for row in rows:
        path=row.get("path")
        limit=row.get("maxBytes")
        require(isinstance(path,str) and 0<len(path)<=256
                and re.fullmatch(r"[a-zA-Z0-9_./-]+",path)
                and all(part not in {"",".","..",".git",".devclaw",".cmbcoworkagent"} for part in path.split("/"))
                and not Path(path).is_absolute()
                and type(limit) is int and 0<limit<=524288
                and isinstance(row.get("bytes"),int) and not isinstance(row["bytes"],bool)
                and 0<row["bytes"]<=limit and re.fullmatch(r"[a-f0-9]{64}",row.get("sha256","")),
                "LEAN_REFERENCE_INVALID")
        for parent in Path(path).parents:
            info=os.lstat(parent)
            require(stat.S_ISDIR(info.st_mode) and not getattr(info,"st_file_attributes",0)&0x400,
                    "LEAN_REFERENCE_DIRECTORY_TYPE")
        before=os.lstat(path)
        ordinary(before)
        require(before.st_size==row["bytes"],"LEAN_REFERENCE_CHANGED")
        fd=os.open(path,os.O_RDONLY|getattr(os,"O_BINARY",0)|getattr(os,"O_NOFOLLOW",0))
        with os.fdopen(fd,"rb") as handle:
            ordinary(os.fstat(handle.fileno()))
            require(identity(os.fstat(handle.fileno()))==identity(before),"LEAN_REFERENCE_CHANGED")
            raw=handle.read(limit+1)
            require(identity(os.fstat(handle.fileno()))==identity(before),"LEAN_REFERENCE_CHANGED")
        require(identity(os.lstat(path))==identity(before) and len(raw)==row["bytes"]
                and hashlib.sha256(raw).hexdigest()==row["sha256"],"LEAN_REFERENCE_CHANGED")
        texts[path]=raw.decode("utf-8",errors="strict")
    paths={names[role]:by_id[roles[role]]["path"] for role in required}
    return texts,paths

payload=json.loads(sys.stdin.read())
reference=payload.get("reference")
if reference is None:
    # Direct workflow calls inspect fixed ordinary files, never supplied model text.
    rows=[]
    paths=payload.get("artifactPaths") or {"baseline":"RequestBaseline.json","definition":"Definition.json","solution":"Solution.json"}
    require(isinstance(paths,dict) and set(paths)=={"baseline","definition","solution"}
            and len(set(paths.values()))==3,"LEAN_REFERENCE_COVERAGE")
    for role in ["baseline","definition","solution"]:
        name=paths[role]
        require(isinstance(name,str) and 0<len(name)<=256 and re.fullmatch(r"[a-zA-Z0-9_./-]+",name)
                and all(part not in {"",".","..",".git",".devclaw",".cmbcoworkagent"}
                        for part in name.split("/")),"LEAN_REFERENCE_INVALID")
        for parent in Path(name).parents:
            info=os.lstat(parent)
            require(stat.S_ISDIR(info.st_mode) and not getattr(info,"st_file_attributes",0)&0x400,
                    "LEAN_REFERENCE_DIRECTORY_TYPE")
        before=os.lstat(name)
        ordinary(before)
        require(0<before.st_size<=131072,"LEAN_REFERENCE_INVALID")
        with open(name,"rb") as handle:
            raw=handle.read(131073)
        rows.append({"artifactId":role,
                     "path":name,"maxBytes":131072,"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest()})
    reference={"protocol":"devclaw.artifact-input/v1","current":rows[-1],"sources":rows[:-1]}
    action="inspect"
else:
    action=payload["action"]
roles=payload.get("roles") if action!="inspect" else {role:role for role in ["baseline","definition","solution"]}
texts,paths=read_reference(reference,action,roles)
print(json.dumps({"documents":{name:json.loads(texts[path]) for name,path in paths.items()},
    "paths":paths,"texts":{name:texts[path] for name,path in paths.items()},
    "inputDigests":{name:hashlib.sha256(text.encode("utf-8")).hexdigest() for name,text in texts.items()}}))
`

export async function readInputs($: Pick<SDK, "process" | "platform">, reference?: any, action?: any, roles?: any, artifactPaths?: any) {
  const result = await $.process.run(["python", "-I", "-B", "-X", "utf8", "-c", program], {
    stdin: JSON.stringify({ reference, action, roles, artifactPaths }), timeoutMs: 30000
  })
  if (result.exitCode !== 0) throw Error("LEAN_INPUT_REFERENCE_REJECTED")
  return JSON.parse(result.stdout)
}
