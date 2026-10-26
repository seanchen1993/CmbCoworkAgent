import { rules } from "./rules-bundle"

// The Host authenticates this reference against its original operation and provider.
// This adapter only verifies the bytes it reads; a guest-created hash grants no authority.
export const referenceBootstrap = String.raw`import sys,json,tempfile,os,stat,hashlib,re
from pathlib import Path

class ReferenceError(ValueError):
    pass

def reject(code):
    raise ReferenceError(code)

def record(value, keys):
    if not isinstance(value,dict) or set(value)!=set(keys):
        reject("ARTIFACT_REFERENCE_INVALID")

def integer(value):
    return isinstance(value,int) and not isinstance(value,bool)

def identity(value):
    # Windows Python lstat/fstat may expose birth/change time through different ctime semantics.
    return (value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,
            None if os.name=="nt" else value.st_ctime_ns)

def ordinary(value, directory=False):
    if stat.S_ISLNK(value.st_mode) or getattr(value,"st_file_attributes",0)&0x400:
        reject("ARTIFACT_REFERENCE_LINK")
    if not (stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode)):
        reject("ARTIFACT_REFERENCE_FILE_TYPE")
    if not directory and value.st_nlink!=1:
        reject("ARTIFACT_REFERENCE_LINK")

def references(reference):
    record(reference,["protocol","projectId","stageId","version","pluginDigest","workspaceIdentity","current","sources"])
    if (reference["protocol"]!="devclaw.artifact-input/v1"
            or not all(isinstance(reference[k],str) and 0<len(reference[k])<=256 for k in ["projectId","stageId"])
            or not integer(reference["version"]) or reference["version"]<1
            or not all(isinstance(reference[k],str) and re.fullmatch(r"[a-f0-9]{64}",reference[k]) for k in ["pluginDigest","workspaceIdentity"])
            or not isinstance(reference["sources"],list) or len(reference["sources"])>7
            or len(json.dumps(reference,ensure_ascii=False,separators=(",",":")).encode())>8192):
        reject("ARTIFACT_REFERENCE_INVALID")
    rows=[reference["current"]]+reference["sources"]
    paths=set()
    ids=set()
    total=0
    for row in rows:
        record(row,["artifactId","path","bytes","sha256","maxBytes"])
        name=row["path"]
        if (not isinstance(row["artifactId"],str) or not re.fullmatch(r"[a-zA-Z0-9][\w.-]{0,99}",row["artifactId"])
                or row["artifactId"] in ids or not isinstance(name,str) or not name or len(name)>240
                or "\\" in name or ":" in name
                or any(p in {"",".",".."} or re.search(r'[<>"|?*\x00-\x1f]|[. ]$',p)
                    or re.match(r'^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)',p,re.I) for p in name.split("/"))
                or name.casefold() in paths):
            reject("ARTIFACT_REFERENCE_PATH")
        limit=524288 if name=="ARCHIVE.bundle.json" else 28000
        if (not integer(row["maxBytes"]) or row["maxBytes"]!=limit
                or not integer(row["bytes"]) or row["bytes"]<0 or row["bytes"]>limit
                or not isinstance(row["sha256"],str) or not re.fullmatch(r"[a-f0-9]{64}",row["sha256"])):
            reject("ARTIFACT_REFERENCE_LIMIT")
        total+=row["bytes"]
        ids.add(row["artifactId"])
        paths.add(name.casefold())
    if total>1048576:
        reject("ARTIFACT_REFERENCE_LIMIT")
    return rows

def load(reference, stage):
    stages=["convert","prd","specs","design","plan","code","cicd","archive"]
    names=["NORMALIZED_REQUIREMENTS.json","PRD.bundle.json","SPECS.bundle.json","DESIGN.bundle.json","PLAN.bundle.json","CODE_RESULT.json","CICD.bundle.json","ARCHIVE.bundle.json"]
    if stage not in stages:
        reject("ARTIFACT_REFERENCE_STAGE")
    rows=references(reference)
    index=stages.index(stage)
    if (reference["current"]["path"]!=names[index]
            or {row["path"] for row in reference["sources"]}!=set(names[:index])):
        reject("ARTIFACT_REFERENCE_STAGE")
    root=Path.cwd().resolve(strict=True)
    root_stat=root.lstat()
    ordinary(root_stat,True)
    observed={root:identity(root_stat)}
    texts={}
    for row in rows:
        target=root
        for component in row["path"].split("/")[:-1]:
            target=target/component
            parent=target.lstat()
            ordinary(parent,True)
            observed[target]=identity(parent)
        target=target/row["path"].split("/")[-1]
        before=target.lstat()
        ordinary(before)
        if before.st_size!=row["bytes"]:
            reject("ARTIFACT_REFERENCE_CHANGED")
        flags=os.O_RDONLY|getattr(os,"O_BINARY",0)|getattr(os,"O_NOFOLLOW",0)|getattr(os,"O_NONBLOCK",0)
        fd=os.open(target,flags)
        with os.fdopen(fd,"rb") as handle:
            opened=os.fstat(handle.fileno())
            ordinary(opened)
            if identity(opened)!=identity(before):
                reject("ARTIFACT_REFERENCE_CHANGED")
            raw=handle.read(row["maxBytes"]+1)
            after=os.fstat(handle.fileno())
            if (len(raw)!=row["bytes"] or identity(after)!=identity(before)
                    or identity(target.lstat())!=identity(before)
                    or hashlib.sha256(raw).hexdigest()!=row["sha256"]):
                reject("ARTIFACT_REFERENCE_CHANGED")
        observed[target]=identity(before)
        texts[row["path"]]=raw.decode("utf-8",errors="strict")
    for name, expected in observed.items():
        actual=name.lstat()
        ordinary(actual,name==root or name.is_dir())
        if identity(actual)!=expected:
            reject("ARTIFACT_REFERENCE_CHANGED")
    return texts,names,index

def build_request(texts,names,index,stage):
    request={"stage":stage,"current":json.loads(texts[names[index]])}
    if stage in {"cicd","archive"}:
        request["sources"]={name:texts[name] for name in names[:index]}
    else:
        for number,key in enumerate(["normalized","prd","specs","design"][:index]):
            request[key]=json.loads(texts[names[number]])
    return request

payload=json.loads(sys.stdin.read(524289))
try:
    texts,names,index=load(payload["reference"],payload["stage"])
    mode=payload.get("mode","check")
    if mode=="code-selection":
        if payload["stage"] not in {"code","cicd","archive"}:
            reject("ARTIFACT_REFERENCE_STAGE")
        result={"selection":json.loads(texts["CODE_RESULT.json"])}
        success=True
    else:
        if mode not in {"check","plan-check"}:
            reject("ARTIFACT_REFERENCE_MODE")
        stage="plan" if mode=="plan-check" else payload["stage"]
        if stage=="code" or (mode=="plan-check" and payload["stage"] not in {"code","cicd","archive"}):
            reject("ARTIFACT_REFERENCE_STAGE")
        request=build_request(texts,names,4 if mode=="plan-check" else index,stage)
        with tempfile.TemporaryDirectory(prefix="autobiz-pinned-rules-") as directory:
            root=Path(directory)
            for name,source in payload["rules"].items():
                path=root/name
                path.parent.mkdir(parents=True,exist_ok=True)
                path.write_text(source,encoding="utf-8")
            sys.path.insert(0,str(root))
            from check import run
            try:
                result=run(request)
            except ValueError as error:
                # Only exact, fixed business codes from the pinned checker may escape.
                # Do not forward arbitrary exception text, subclasses, paths or payloads.
                safe_codes={"ARTIFACT_BUNDLE_PATH_INVALID","NORMALIZED_REQUIREMENTS_INVALID",
                    "ARTIFACT_BUNDLE_INVALID","ARTIFACT_BUNDLE_OWNERSHIP",
                    "ARTIFACT_BUNDLE_CONTENT_INVALID","ARTIFACT_BUNDLE_PATH_COLLISION",
                    "CODE_COMMAND_INVALID","CODE_CHANGED_PATHS_INVALID",
                    "STAGE_UNSUPPORTED","ARTIFACT_BUNDLE_LIMIT"}
                if type(error) is ValueError and str(error) in safe_codes:
                    reject(str(error))
                raise
            success=result["passed"] is True
except Exception as error:
    code=str(error) if isinstance(error,ReferenceError) else "ARTIFACT_REFERENCE_READ_OR_CHECK_FAILED"
    result={"passed":False,"errors":[{"code":code}],"warnings":[]}
    success=False
print(json.dumps(result,ensure_ascii=False))
sys.exit(0 if success else 1)
`

export function isArtifactReference(value) {
  return value?.protocol === "devclaw.artifact-input/v1"
}

// Scan the large ASCII rule payload once, then count only its non-ASCII spans.
export function referenceUtf8Bytes(text) {
  const spans = text.match(/[\u0080-\uffff]+/g)
  if (!spans) return text.length
  // Keep ASCII gaps so separated lone surrogates cannot form a new pair.
  const nonAscii = spans.join(" ")
  return text.length + nonAscii.length - (spans.length - 1) +
    (nonAscii.match(/[\u0800-\uffff]/g)?.length ?? 0) -
    2 * (nonAscii.match(/[\ud800-\udbff][\udc00-\udfff]/g)?.length ?? 0)
}

export async function runReferencedCheck($, reference, stage, mode = "check") {
  const stdin = JSON.stringify({ reference, stage, mode, rules })
  if (referenceUtf8Bytes(stdin) > 512 * 1024)
    throw Error("ARTIFACT_REFERENCE_STDIN_LIMIT")
  const argv = ["python", "-I", "-B", "-X", "utf8", "-c", referenceBootstrap]
  const init = {
    stdin,
    timeoutMs: 30000,
    env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" }
  }
  if (referenceUtf8Bytes(JSON.stringify([argv, init])) > 1024 * 1024)
    throw Error("ARTIFACT_REFERENCE_RPC_LIMIT")
  return $.process.run(argv, init)
}

export async function readReferencedCodeSelection($, reference, stage) {
  const result = await runReferencedCheck($, reference, stage, "code-selection")
  let value
  try { value = JSON.parse(result.stdout) } catch { throw Error("ARTIFACT_REFERENCE_CODE_INVALID") }
  if (result.exitCode !== 0 || !value?.selection || typeof value.selection !== "object")
    throw Error("ARTIFACT_REFERENCE_CODE_INVALID")
  return value.selection
}
