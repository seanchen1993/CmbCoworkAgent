// Versioned pure argv/ownership policy. Test success is decided only by the actual runner receipt.
export const executionPolicy = String.raw`import json,re
from pathlib import Path
from hooks.command_executable import executable
from hooks.compile_command_policy import _production_compile_argv
from hooks.plan_write_ownership import is_test_asset_path

def test_adapter_argv(argv, adapter="node-test/v1"):
    if len(argv)!=3 or argv[:2]!=["node","-"]:
        return False
    try:
        value=json.loads(argv[2])
    except (ValueError,TypeError):
        return False
    keys={"adapter","files","subjects","timeoutMs"} if adapter=="python-unittest/v1" else {"mode","files","subjects","sources","timeoutMs"}
    if not isinstance(value,dict) or set(value)!=keys:
        return False
    def paths(values, maximum, tests):
        return (isinstance(values,list) and 0<len(values)<=maximum
            and all(isinstance(name,str) and 0<len(name)<=160
                and re.fullmatch(r"[a-zA-Z0-9_./-]+",name)
                and not name.startswith(".")
                and all(part not in {"",".","..",".git",".devclaw",".cmbcoworkagent"} for part in name.split("/"))
                and (not tests or (re.search(r"(^|/)test_[a-zA-Z0-9_]+\.py$",name) if adapter=="python-unittest/v1" else re.search(r"\.(test|spec)\.(cjs|mjs|js)$",name))) for name in values)
            and len(set(values))==len(values))
    return ((value["adapter"]==adapter if adapter=="python-unittest/v1" else value["mode"]=="execute" and value["sources"]==[])
        and paths(value["files"],4,True) and paths(value["subjects"],64 if adapter=="python-unittest/v1" else 8,False)
        and not set(value["files"])&set(value["subjects"])
        and type(value["timeoutMs"]) is int and 1000<=value["timeoutMs"]<=295000)

def production_compile(argv, tracked):
    if executable(argv[0])!="node":
        return _production_compile_argv(argv)
    modules=[name for name in tracked if re.search(r"\.(cjs|mjs|js)$",name)
        and not re.search(r"(^|/)(tests?|__tests__)/",name) and not re.search(r"\.(test|spec)\.",name)]
    return (len(argv)==3 and argv[1]=="--check" and 0<len(modules)<=8 and argv[2] in modules
        and not Path(argv[2]).is_absolute() and ".." not in Path(argv[2]).parts)

def repair_command_validator(request):
    output=request.get("receipt",{}).get("output",{})
    argv=output.get("argv",[])
    test=output.get("test",{})
    adapter=output.get("executionAdapter","node-test/v1")
    if adapter not in {"node-test/v1","python-unittest/v1"} or not test_adapter_argv(argv,adapter) or not isinstance(test,dict):
        raise ValueError("LEAN_REPAIR_ADAPTER_RECEIPT_INVALID")
    binding=json.loads(argv[2])
    counts=test.get("counts",{})
    if (test.get("protocol")!="autobiz.test-execution/v1" or test.get("runner")!=adapter
        or adapter=="python-unittest/v1" and test.get("completed") is not True
        or test.get("passed") is not False or test.get("files")!=binding["files"]
        or output.get("testFiles")!=binding["files"] or test.get("subjects")!=binding["subjects"]
        or test.get("timeoutMs")!=binding["timeoutMs"]
        or any(not isinstance(test.get(key),str) or not re.fullmatch(r"[a-f0-9]{64}",test[key])
            for key in ["sourceFingerprint","testsFingerprint","subjectFingerprint"])
        or not isinstance(counts,dict) or set(counts)!={"total","passed","failed","skipped"}
        or any(type(value) is not int or value<0 for value in counts.values())
        or counts["total"]<=0 or counts["failed"]<=0 or counts["skipped"]!=0
        or counts["total"]!=counts["passed"]+counts["failed"]+counts["skipped"]):
        raise ValueError("LEAN_REPAIR_ADAPTER_RECEIPT_INVALID")
    # The caller reads the original immutable workflow receipt. Only that exact
    # invocation is admitted into the retained task/spec/AC/evidence validator.
    return lambda command: command.get("argv")==argv and command.get("testFiles")==binding["files"]

def run(request):
    if request.get("stage")=="repair-evidence":
        from repair import check
        return check(request, command_validator=repair_command_validator(request))
    if request.get("stage")=="performance":
        from performance import check
        return check(request["current"])
    if request.get("stage")!="command-policy":
        raise ValueError("LEAN_EXECUTION_ACTION_UNSUPPORTED")
    command=request.get("current",{})
    argv=command.get("argv")
    if not isinstance(argv,list) or not 0<len(argv)<=64 or any(not isinstance(arg,str) or not 0<len(arg)<=1024 for arg in argv):
        raise ValueError("CODE_COMMAND_INVALID")
    changed=command.get("changedPaths",[])
    tracked=command.get("trackedPaths",[])
    protected_paths=command.get("protectedArtifactPaths",[])
    if (not isinstance(protected_paths,list) or len(protected_paths)>8
            or any(not isinstance(path,str) or not re.fullmatch(r"[a-zA-Z0-9_./-]{1,256}",path)
                or any(part in {"",".",".."} for part in path.split("/")) for path in protected_paths)):
        raise ValueError("LEAN_PROTECTED_ARTIFACT_PATH_INVALID")
    if any(not isinstance(values,list) or any(not isinstance(path,str) for path in values) for values in [changed,tracked]):
        raise ValueError("CODE_CHANGED_PATHS_INVALID")
    phase=command.get("phase")
    adapter=command.get("executionAdapter","node-test/v1")
    compile_ok=(production_compile(argv,tracked) and executable(argv[0])=="node" if adapter=="node-test/v1"
        else executable(argv[0]) in {"mvn","mvnw"} and _production_compile_argv(argv) and argv[-1]=="compile"
        and all(arg in {"-q","--quiet","-o","--offline","-B","--batch-mode","-ntp","--no-transfer-progress"} for arg in argv[1:-1]) and len(set(argv[1:-1]))==len(argv[1:-1]) if adapter=="python-unittest/v1" else False)
    accepted=(compile_ok if phase=="compile"
        else adapter in {"node-test/v1","python-unittest/v1"} and test_adapter_argv(argv,adapter) if phase in {"test","e2e"} else False)
    ownership=all(not is_test_asset_path(path) for path in changed) if phase=="compile" else all(is_test_asset_path(path) for path in changed)
    protected=any(path in protected_paths or path.startswith((".devclaw/",".cmbcoworkagent/",".git/")) or path in {
        "RequestBaseline.json","Definition.json","Solution.json","Code.json","Delivery.json",
        "NORMALIZED_REQUIREMENTS.json","PRD.bundle.json","SPECS.bundle.json","DESIGN.bundle.json",
        "PLAN.bundle.json","CODE_RESULT.json","CICD.bundle.json","ARCHIVE.bundle.json"} for path in changed)
    return {"passed":accepted and ownership and not protected,
        "testFiles":[path for path in tracked if is_test_asset_path(path)],
        "errors":([] if accepted else [{"code":"CODE_COMMAND_POLICY_DENIED"}])
            +([] if ownership else [{"code":"CODE_PRODUCTION_TEST_WRITE_BOUNDARY"}])
            +([{"code":"CODE_HOST_ARTIFACT_WRITE_DENIED"}] if protected else []),"warnings":[]}
`
