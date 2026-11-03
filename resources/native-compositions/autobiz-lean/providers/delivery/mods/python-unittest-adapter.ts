import type { SDK } from "devclaw-mods"
// Native JSON fields remain subject to the existing field-by-field runtime checks.
type EvidenceRecord = Record<string, any>
import { parseAdapterResult } from "./runner"

/** Fixed unittest reporter. Test output is redirected at the OS descriptor boundary. */
const pythonReporter = String.raw`
import os,sys,json,unittest,importlib.util
report_fd=os.dup(1)
null_fd=os.open(os.devnull,os.O_WRONLY)
os.dup2(null_fd,1)
os.dup2(null_fd,2)
os.close(null_fd)
write_report=os.write
encode=json.dumps
request=json.loads(sys.argv[1])
class Result(unittest.TestResult):
 def __init__(self):
  super().__init__()
  self.rows={}
  self.completed=0
 def startTest(self,test):
  super().startTest(test)
  if id(test) in self.rows: raise RuntimeError('TEST_DUPLICATE_CASE')
  self.rows[id(test)]='pending'
 def addSuccess(self,test):
  if self.rows[id(test)]=='pending': self.rows[id(test)]='passed'
 def addFailure(self,test,error): self.rows[id(test)]='failed'
 def addError(self,test,error): self.rows[id(test)]='failed'
 def addSkip(self,test,reason): self.rows[id(test)]='skipped'
 def addExpectedFailure(self,test,error): self.rows[id(test)]='skipped'
 def addUnexpectedSuccess(self,test): self.rows[id(test)]='failed'
 def addSubTest(self,test,subtest,error):
  if error is not None: self.rows[id(test)]='failed'
 def stopTest(self,test):
  super().stopTest(test)
  self.completed+=1
try:
 suite=unittest.TestSuite()
 for index,name in enumerate(request['files']):
  spec=importlib.util.spec_from_file_location('lean_test_'+str(index),os.path.abspath(name))
  module=importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
 expected=suite.countTestCases()
 if expected<1 or expected>100000: raise RuntimeError('TEST_CASE_LIMIT')
 result=Result()
 suite.run(result)
 states=list(result.rows.values())
 counts={'total':len(states),'passed':states.count('passed'),'failed':states.count('failed')+states.count('pending'),'skipped':states.count('skipped')}
 complete=result.completed==expected and counts['total']==expected
 passed=complete and counts['passed']==expected and counts['failed']==0 and counts['skipped']==0
 output={'passed':passed,'completed':complete,'counts':counts}
except BaseException:
 output={'passed':False,'completed':False,'errors':[{'code':'TEST_EXECUTION_UNAVAILABLE'}]}
write_report(report_fd,encode(output,separators=(',',':')).encode())
os.close(report_fd)
sys.exit(0 if output['passed'] else 1)
`

/** Parent process owns fingerprints and consumes only the fixed reporter's dedicated descriptor. */
const bootstrap = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const {spawnSync}=require('node:child_process')
const request=JSON.parse(process.argv[2])
const hash=value=>crypto.createHash('sha256').update(value).digest('hex')
const fail=code=>{throw Error(code)}
const identity=s=>[s.dev,s.ino,s.size,s.mtimeMs,process.platform==='win32'?0:s.ctimeMs].join(':')
const root=process.cwd(),observed=new Map()
function ordinary(p,directory=false){
 const s=fs.lstatSync(p)
 if(s.isSymbolicLink()||!(directory?s.isDirectory():s.isFile())||(!directory&&s.nlink!==1))fail('TEST_FILE_TYPE_INVALID')
 return s
}
const rootIdentity=identity(ordinary(root,true))
function read(name){
 if(typeof name!=='string'||!name||name.length>160||name.includes('\\')||name.includes(':')||
 name.split('/').some(p=>!p||p==='.'||p==='..'||/[<>"|?*\x00-\x1f]|[. ]$/.test(p)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)))fail('TEST_PATH_INVALID')
 let target=root
 for(const part of name.split('/').slice(0,-1)){
  target=path.join(target,part)
  observed.set(target,identity(ordinary(target,true)))
 }
 target=path.join(root,name)
 const before=ordinary(target)
 if(before.size>262144)fail('TEST_FILE_LIMIT')
 const fd=fs.openSync(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0))
 let raw
 try{
  if(identity(fs.fstatSync(fd))!==identity(before))fail('TEST_FILE_CHANGED')
  raw=Buffer.alloc(before.size+1)
  const length=fs.readSync(fd,raw,0,raw.length,0)
  raw=raw.subarray(0,length)
  if(length!==before.size||identity(fs.fstatSync(fd))!==identity(before)||identity(ordinary(target))!==identity(before))fail('TEST_FILE_CHANGED')
 }finally{fs.closeSync(fd)}
 observed.set(target,identity(before))
 return {path:name,bytes:raw.length,sha256:hash(raw)}
}
function fingerprint(files){
 const rows=files.map(read)
 if(rows.reduce((sum,row)=>sum+row.bytes,0)>1048576)fail('TEST_FILE_LIMIT')
 return hash(JSON.stringify(rows))
}
function unchanged(){
 if(identity(ordinary(root,true))!==rootIdentity)fail('TEST_FILE_CHANGED')
 for(const [name,before]of observed)if(identity(fs.lstatSync(name))!==before)fail('TEST_FILE_CHANGED')
}
try{
 const testsFingerprint=fingerprint(request.files),subjectFingerprint=fingerprint(request.subjects)
 if(request.mode==='fingerprint'){
  unchanged()
  process.stdout.write(JSON.stringify({passed:true,subjectFingerprint,files:request.subjects}))
  process.exit(0)
 }
 const child=spawnSync('python',['-I','-B','-c',${JSON.stringify(pythonReporter)},JSON.stringify(request)],{
  cwd:root,encoding:'utf8',windowsHide:true,timeout:request.timeoutMs,maxBuffer:1048576,
  env:{...process.env,PYTHONPATH:'',PYTHONSTARTUP:'',PYTHONINSPECT:''}
 })
 unchanged()
 if(fingerprint(request.files)!==testsFingerprint||fingerprint(request.subjects)!==subjectFingerprint)fail('TEST_FILE_CHANGED')
 unchanged()
 if(child.error||![0,1].includes(child.status))fail('TEST_EXECUTION_UNAVAILABLE')
 let report
 try{report=JSON.parse(child.stdout)}catch{fail('TEST_REPORT_INVALID')}
 if(typeof report.passed!=='boolean'||(child.status===0)!==report.passed)fail('TEST_REPORT_INVALID')
 const output={...report,runner:'python-unittest/v1',sourceFingerprint:hash('[]'),testsFingerprint,subjectFingerprint}
 process.stdout.write(JSON.stringify(output))
 process.exitCode=output.passed?0:1
}catch(error){
 const code=/^TEST_[A-Z_]+$/.test(error.message)?error.message:'TEST_EXECUTION_UNAVAILABLE'
 process.stdout.write(JSON.stringify({passed:false,errors:[{code}]}))
 process.exitCode=1
}
`

/** Internal compiler snapshot; it cannot be prepared as a test command. */
export async function fingerprintJavaSources($: Pick<SDK, "process">, subjects: string[]) {
  const result = await $.process.run(
    [
      "node",
      "-",
      JSON.stringify({
        mode: "fingerprint",
        files: [],
        subjects
      })
    ],
    {
      integrity: "native",
      stdin: bootstrap,
      timeoutMs: 30000,
      env: { NODE_OPTIONS: "", NODE_PATH: "" }
    }
  )
  const { value } = parseAdapterResult<any>(result)
  if (
    value.passed !== true ||
    !/^[a-f0-9]{64}$/.test(value.subjectFingerprint) ||
    JSON.stringify(value.files) !== JSON.stringify(subjects)
  )
    throw Error("LEAN_JAVA_SOURCE_FINGERPRINT_INVALID")
  return value.subjectFingerprint
}

export function preparePythonTest(input: EvidenceRecord) {
  const paths = (value: unknown, tests: boolean) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= (tests ? 4 : 64) &&
    new Set(value.map((path) => String(path).toLowerCase())).size === value.length &&
    value.every(
      (path) =>
        typeof path === "string" &&
        path.length <= 160 &&
        /^(?!\.)(?!.*(?:^|\/)\.\.?\/)[a-zA-Z0-9_./-]+$/.test(path) &&
        !path
          .split("/")
          .some(
            (part) => !part || [".", "..", ".git", ".devclaw", ".cmbcoworkagent"].includes(part)
          ) &&
        (!tests || /(?:^|\/)test_[a-zA-Z0-9_]+\.py$/.test(path))
    )
  if (
    !input ||
    Object.keys(input).sort().join("|") !== "files|subjects|timeoutMs" ||
    !paths(input.files, true) ||
    !paths(input.subjects, false) ||
    input.files.some((path: string) => input.subjects.includes(path)) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1000 ||
    input.timeoutMs > 295000
  )
    throw Error("LEAN_PYTHON_TEST_INPUT_INVALID")
  const request = { adapter: "python-unittest/v1", ...input }
  const argv = ["node", "-", JSON.stringify(request)]
  if (argv[2]!.length > 1024) throw Error("LEAN_TEST_COMMAND_LIMIT")
  return {
    argv,
    init: {
      integrity: "native" as const,
      stdin: bootstrap,
      timeoutMs: input.timeoutMs + 5000,
      env: { NODE_OPTIONS: "", NODE_PATH: "" }
    }
  }
}

export function executePythonTests(argv: string[]) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv[0] !== "node" || argv[1] !== "-")
    throw Error("LEAN_PYTHON_TEST_COMMAND_REQUIRED")
  const request = JSON.parse(argv[2]!)
  const invocation = preparePythonTest({
    files: request.files,
    subjects: request.subjects,
    timeoutMs: request.timeoutMs
  })
  if (JSON.stringify(argv) !== JSON.stringify(invocation.argv))
    throw Error("LEAN_TEST_COMMAND_CHANGED")
  return {
    ...invocation,
    parse(result: { stdout: string; exitCode: number }) {
      const { value } = parseAdapterResult<any>(result)
      const counts = value.counts
      if (
        value.passed &&
        (value.completed !== true ||
          !counts ||
          !["total", "passed", "failed", "skipped"].every(
            (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0
          ) ||
          counts.total < 1 ||
          counts.passed !== counts.total ||
          counts.failed !== 0 ||
          counts.skipped !== 0 ||
          ![value.testsFingerprint, value.subjectFingerprint].every((hash) =>
            /^[a-f0-9]{64}$/.test(hash)
          ))
      )
        throw Error("LEAN_TEST_STATISTICS_REQUIRED")
      return {
        ...value,
        protocol: "autobiz.test-execution/v1",
        files: request.files,
        subjects: request.subjects,
        timeoutMs: request.timeoutMs
      }
    }
  }
}
