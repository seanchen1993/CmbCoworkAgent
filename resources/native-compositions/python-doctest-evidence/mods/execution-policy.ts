// Versioned pure argv/ownership policy. Test success is decided only by the actual runner receipt.
export const executionPolicy = String.raw`import json,re
from pathlib import Path
from hooks.command_executable import executable
from hooks.compile_command_policy import _production_compile_argv
from hooks.plan_write_ownership import is_test_asset_path

def test_adapter_argv(argv, adapter="python-doctest/v1"):
    if len(argv)!=3 or argv[:2]!=["node","-"]:
        return False
    try:
        value=json.loads(argv[2])
    except (ValueError,TypeError):
        return False
    if not isinstance(value,dict) or set(value)!={"adapter","files","subjects","timeoutMs"}:
        return False
    def paths(values, tests):
        pattern=r"tests/[a-zA-Z0-9_/-]+\.doctest" if tests else r"src/[a-zA-Z0-9_./-]+\.py"
        return (isinstance(values,list) and 0<len(values)<=(4 if tests else 64)
            and all(isinstance(name,str) and len(name)<=160 and re.fullmatch(pattern,name)
                and all(part not in {"",".",".."} for part in name.split("/")) for name in values)
            and len(set(name.lower() for name in values))==len(values))
    return (value["adapter"]==adapter=="python-doctest/v1" and paths(value["files"],True)
        and paths(value["subjects"],False) and value["subjects"]==sorted(value["subjects"])
        and type(value["timeoutMs"]) is int and 1000<=value["timeoutMs"]<=295000)


def repair_command_validator(request):
    output=request.get("receipt",{}).get("output",{})
    argv=output.get("argv",[])
    test=output.get("test",{})
    adapter=output.get("executionAdapter","python-doctest/v1")
    if adapter not in {"python-doctest/v1"} or not test_adapter_argv(argv,adapter) or not isinstance(test,dict):
        raise ValueError("LEAN_REPAIR_ADAPTER_RECEIPT_INVALID")
    binding=json.loads(argv[2])
    counts=test.get("counts",{})
    if (test.get("protocol")!="autobiz.test-execution/v1" or test.get("runner")!=adapter
        or adapter=="python-doctest/v1" and test.get("completed") is not True
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
    adapter=command.get("executionAdapter","python-doctest/v1")
    compile_ok=(adapter=="python-doctest/v1" and len(argv)==4 and argv[:3]==["python","-m","py_compile"]
        and argv[3] in tracked and re.fullmatch(r"src/[a-zA-Z0-9_./-]+\.py",argv[3])
        and all(part not in {"",".",".."} for part in argv[3].split("/")))
    accepted=(compile_ok if phase=="compile"
        else adapter in {"python-doctest/v1"} and test_adapter_argv(argv,adapter) if phase in {"test","e2e"} else False)
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
