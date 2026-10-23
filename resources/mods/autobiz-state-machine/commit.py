# Plugin-side prepared two-file commit. Original validators and Windows NTFS locks retained.
import base64, ctypes, hashlib, importlib.util, json, os, shutil, sys, tempfile
from pathlib import Path
from ctypes import wintypes as w
sys.path.insert(0, str(Path(__file__).parent))
from journal import write_record, policy_digest, linked
from compiled_contract import assert_contract, assert_verified_inputs

MAX_BYTES = 262144
PROTOCOL_STDOUT = sys.stdout
# This isolated child reserves stdout for prepared/commit protocol messages.
# Original validators and serializers retain their diagnostics on stderr.
sys.stdout = sys.stderr
source, workspace, feature, old, new, expected, operation, receipt_json, journal_root, policy, approved_checks, workflow_digest, verified_candidate_json = sys.argv[1:]
handles = []
acknowledged = False
def sha(data): return hashlib.sha256(data).hexdigest()
def fail(message): raise RuntimeError(message)
def emit(value): print(json.dumps(value, ensure_ascii=False), file=PROTOCOL_STDOUT, flush=True)
def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec); sys.modules[name] = mod; spec.loader.exec_module(mod); return mod

try:
    if os.name != 'nt': fail('AUTOBIZ_COMMIT_PLATFORM_UNSUPPORTED')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    def api(name, args, result=w.BOOL):
        fn = getattr(kernel, name); fn.argtypes = args; fn.restype = result; return fn
    create = api('CreateFileW', [w.LPCWSTR,w.DWORD,w.DWORD,ctypes.c_void_p,w.DWORD,w.DWORD,w.HANDLE], w.HANDLE)
    close = api('CloseHandle', [w.HANDLE])
    read = api('ReadFile', [w.HANDLE,ctypes.c_void_p,w.DWORD,ctypes.POINTER(w.DWORD),ctypes.c_void_p])
    write = api('WriteFile', [w.HANDLE,ctypes.c_void_p,w.DWORD,ctypes.POINTER(w.DWORD),ctypes.c_void_p])
    seek = api('SetFilePointerEx', [w.HANDLE,ctypes.c_longlong,ctypes.c_void_p,w.DWORD])
    truncate = api('SetEndOfFile', [w.HANDLE])
    flush = api('FlushFileBuffers', [w.HANDLE])
    drive_type = api('GetDriveTypeW', [w.LPCWSTR], w.UINT)
    volume = api('GetVolumeInformationW', [w.LPCWSTR,w.LPWSTR,w.DWORD,ctypes.POINTER(w.DWORD),ctypes.POINTER(w.DWORD),ctypes.POINTER(w.DWORD),w.LPWSTR,w.DWORD])
    class Info(ctypes.Structure):
        _fields_ = [('attributes',w.DWORD),('creation',w.FILETIME),('access',w.FILETIME),('write',w.FILETIME),('volume',w.DWORD),('size_high',w.DWORD),('size_low',w.DWORD),('links',w.DWORD),('index_high',w.DWORD),('index_low',w.DWORD)]
    info_api = api('GetFileInformationByHandle', [w.HANDLE,ctypes.POINTER(Info)])
    def info(handle):
        value = Info()
        if not info_api(handle, ctypes.byref(value)): fail('AUTOBIZ_HANDLE_FAILED')
        return value
    def checked_path(value):
        path = Path(os.path.abspath(value))
        if not path.drive or str(path).startswith('\\\\') or ':' in str(path)[2:]: fail('AUTOBIZ_COMMIT_FILESYSTEM_UNSUPPORTED')
        root = path.anchor
        filesystem = ctypes.create_unicode_buffer(32)
        if drive_type(root) != 3 or not volume(root,None,0,None,None,None,filesystem,32) or filesystem.value != 'NTFS':
            fail('AUTOBIZ_COMMIT_FILESYSTEM_UNSUPPORTED')
        return path
    workspace = checked_path(workspace)
    journal_root = checked_path(journal_root)
    def acquire(path, directory=False):
        # Deny DELETE throughout the complete ancestry. State handles also deny
        # WRITE, including writers opened before this call. Readers stay allowed.
        access = 0x80 if directory else 0xC0000000
        sharing = 3 if directory else 1
        flags = 0x00200000 | (0x02000000 if directory else 0x80000000)
        handle = create(str(path),access,sharing,None,3,flags,None)
        if handle == ctypes.c_void_p(-1).value:
            fail('AUTOBIZ_STATE_LOCKED:'+str(ctypes.get_last_error()))
        handles.append(handle)
        value = info(handle)
        if value.attributes & 0x400: fail('AUTOBIZ_REPARSE_UNSUPPORTED')
        if bool(value.attributes & 0x10) != directory: fail('AUTOBIZ_STATE_TYPE_INVALID')
        if not directory and (value.links != 1 or value.size_high or value.size_low > MAX_BYTES): fail('AUTOBIZ_STATE_LIMIT')
        return handle
    pinned = set()
    for leaf in [workspace / '.autobizdevops', journal_root]:
        for path in reversed([leaf, *leaf.parents]):
            key = str(path).lower()
            if key not in pinned:
                acquire(path, True); pinned.add(key)
    state_paths = [workspace / '.autobizdevops' / 'state.json', workspace / '.autobizdevops' / 'STATE.md']
    state_handles = [acquire(path) for path in state_paths]
    def identity(handle):
        value = info(handle)
        return '%08x:%08x%08x' % (value.volume,value.index_high,value.index_low)
    def read_handle(handle):
        value = info(handle)
        if value.links != 1 or value.attributes & 0x400: fail('AUTOBIZ_STATE_CHANGED')
        if value.size_high or value.size_low > MAX_BYTES: fail('AUTOBIZ_STATE_LIMIT')
        if not seek(handle,0,None,0): fail('AUTOBIZ_HANDLE_FAILED')
        data = ctypes.create_string_buffer(value.size_low)
        count = w.DWORD()
        if not read(handle,data,value.size_low,ctypes.byref(count),None) or count.value != value.size_low: fail('AUTOBIZ_STATE_READ_FAILED')
        return data.raw[:count.value]
    before = [read_handle(handle) for handle in state_handles]
    identities = [identity(handle) for handle in state_handles]
    before_hashes = [sha(data) for data in before]
    receipt = json.loads(receipt_json)
    if receipt is not None:
        if receipt.get('after') != before_hashes or receipt.get('identities') != identities: fail('AUTOBIZ_STATE_CHANGED')
        emit({'applied':False,'duplicate':True,'status':'committed','operationId':operation,'feature':feature,'from':old,'to':new,'stateFingerprint':before_hashes[0],'markdownFingerprint':before_hashes[1]})
    else:
        sys.path.insert(0,source)
        sys.path.insert(0,os.path.join(source,'skills','autodev','hooks'))
        bridge = load(os.path.join(Path(__file__).parent,'stage_checks.py'),'mod_stage_checks')
        observer, stage_checks = bridge.install_original_postcheck(Path(source))
        update = load(os.path.join(source,'hooks','update_checkpoint.py'),'mods_update')
        state_store = load(os.path.join(source,'board_core','state_store.py'),'mods_state_store')
        sync = update.check_or_fix_state_sync
        # The upstream prepare function normally uses fix=True. The host only
        # permits the same validator's read-only mode before authorization.
        update.check_or_fix_state_sync = lambda workspace, **kwargs: sync(workspace,fix=False)
        current = sync(workspace,fix=False)
        if not current.state_exists or current.errors: fail('AUTOBIZ_STATE_NOT_CANONICAL')
        actual = (current.records.get(feature) or {}).get('checkpoint')
        if before_hashes[0] != expected: fail('AUTOBIZ_STATE_CHANGED')
        if actual == new: fail('AUTOBIZ_CHECKPOINT_UNATTRIBUTED')
        if actual != old: fail('AUTOBIZ_CHECKPOINT_CHANGED:'+str(actual))
        assert_contract(Path(source),workspace,current.records[feature],workflow_digest)
        if policy_digest(Path(source)) != policy: fail('AUTOBIZ_OPERATION_SOURCE_CHANGED')
        assert_verified_inputs(Path(source),workspace,feature,current.records[feature],new)
        bridge.validate_added_completion(Path(source),workspace,feature,current.records[feature],new,observer)
        bridge.validate_completed_biz(Path(source),workspace,feature,current.records[feature],stage_checks,target_checkpoint=new)
        hook_rules = load(Path(__file__).with_name('hook_checks.py'),'mod_transition_hooks')
        verified_candidate = json.loads(verified_candidate_json)
        if not isinstance(verified_candidate,dict): fail('AUTOBIZ_VERIFIED_CANDIDATE_RECEIPT_REQUIRED')
        hook_rules.validate_verified_candidate(Path(source),workspace,feature,old,new,expected=verified_candidate)
        transition_hooks = hook_rules.validate_transition_hooks(Path(source),workspace,feature,new)
        if transition_hooks['errors']: fail('; '.join(transition_hooks['errors']))
        result = update.prepare_checkpoint_update(workspace=workspace,feature=feature,checkpoint=new)
        if not result.ok: fail('; '.join(result.errors))
        if stage_checks.evidence_errors: fail('AUTOBIZ_STAGE_EVIDENCE_UNAVAILABLE')
        checks_digest = sha(json.dumps(stage_checks,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8'))
        strict_nodes = bridge.strict_handoff_nodes(
            bridge.compiled(Path(source),workspace,current.records[feature]),stage_checks)
        strict_digest = sha(bridge.canonical({'stageChecks':stage_checks,
            'strictHandoffNodes':strict_nodes}).encode('utf-8'))
        if new == 'design_done' and (not approved_checks or approved_checks != checks_digest):
            fail('AUTOBIZ_DESIGN_APPROVED_INPUT_CHANGED')
        hook_rules.validate_verified_candidate(Path(source),workspace,feature,old,new,expected=verified_candidate)
        # Run the real writer only in a private host snapshot. This preserves
        # upstream serialization without replacing either locked live path.
        with tempfile.TemporaryDirectory(prefix='prepared-',dir=journal_root) as temporary:
            stage = Path(temporary)
            (stage / '.autobizdevops').mkdir()
            overlay = workspace / '.autobizdevops' / 'workflow.d'
            if overlay.exists():
                count = 0; size = 0
                for path in [overlay,*overlay.rglob('*')]:
                    if linked(path): fail('AUTOBIZ_WORKFLOW_LINK_UNSUPPORTED')
                    if path.is_file():
                        count += 1; size += path.stat().st_size
                    if count > 512 or size > 8*1024*1024: fail('AUTOBIZ_WORKFLOW_LIMIT')
                shutil.copytree(overlay,stage / '.autobizdevops' / 'workflow.d')
            state_store.write_state_records_preserving_raw(stage,result.records,raw_records=result.raw_records)
            after = [(stage / '.autobizdevops' / path.name).read_bytes() for path in state_paths]
            # Match the pinned writer's text-mode newline translation on Windows.
            expected_output = [text.replace('\n',os.linesep).encode('utf-8') for text in [result.state_json_content,result.content]]
            if after != expected_output: fail('AUTOBIZ_PREPARED_OUTPUT_CHANGED')
            if any(len(data) > MAX_BYTES for data in after): fail('AUTOBIZ_STATE_LIMIT')
        evidence = {'before':before_hashes,'after':[sha(data) for data in after],'identities':identities,
            'beforeContent':[base64.b64encode(data).decode('ascii') for data in before],
            'afterContent':[base64.b64encode(data).decode('ascii') for data in after]}
        emit({'ready':True,'operationId':operation,'evidence':evidence,'stageChecks':stage_checks,
              'stageChecksDigest':checks_digest,'verifiedCandidate':verified_candidate,
              'transitionHooks':[*transition_hooks['receipts'],verified_candidate]})
        if sys.stdin.readline().strip() != 'commit:'+operation: fail('AUTOBIZ_COMMIT_NOT_AUTHORIZED')
        assert_contract(Path(source),workspace,current.records[feature],workflow_digest)
        if policy_digest(Path(source)) != policy: fail('AUTOBIZ_OPERATION_SOURCE_CHANGED')
        assert_verified_inputs(Path(source),workspace,feature,current.records[feature],new)
        hook_rules.validate_verified_candidate(Path(source),workspace,feature,old,new,expected=verified_candidate)
        acknowledged = True
        if [read_handle(handle) for handle in state_handles] != before: fail('AUTOBIZ_STATE_CHANGED')
        for handle,data in zip(state_handles,after):
            if not seek(handle,0,None,0): fail('AUTOBIZ_STATE_WRITE_FAILED')
            count = w.DWORD()
            if not write(handle,data,len(data),ctypes.byref(count),None) or count.value != len(data): fail('AUTOBIZ_STATE_WRITE_FAILED')
            if not truncate(handle) or not flush(handle): fail('AUTOBIZ_STATE_FLUSH_FAILED')
        if [read_handle(handle) for handle in state_handles] != after: fail('AUTOBIZ_STATE_COMMIT_VERIFY_FAILED')
        verify = sync(workspace,fix=False)
        if verify.errors or (verify.records.get(feature) or {}).get('checkpoint') != new: fail('AUTOBIZ_STATE_COMMIT_VERIFY_FAILED')
        # Record actual verified writes while both live state handles are still pinned.
        # This is a plugin-owned receipt, not a native human approval or a platform grant.
        write_record(Path(journal_root) / (operation + '.physical.json'),
            {'operationId':operation,'policyDigest':policy,'after':evidence['after'],
             'identities':identities,'stageChecksDigest':checks_digest,
             'strictHandoffNodes':strict_nodes,'strictHandoffDigest':strict_digest,
             'verifiedCandidate':verified_candidate}, exclusive=True)
        emit({'written':True,'operationId':operation,'stateFingerprint':evidence['after'][0],'markdownFingerprint':evidence['after'][1]})
        if sys.stdin.readline().strip() != 'release:'+operation: fail('AUTOBIZ_COMMIT_UNKNOWN')
        emit({'applied':True,'duplicate':False,'status':'committed','operationId':operation,'feature':feature,'from':old,'to':new,'stateFingerprint':evidence['after'][0],'markdownFingerprint':evidence['after'][1]})
except Exception as error:
    emit({'applied':False,'duplicate':False,'status':'unknown' if acknowledged else 'not-applied','operationId':operation,'feature':feature,'from':old,'to':new,'stateFingerprint':'','reason':('AUTOBIZ_COMMIT_UNKNOWN:' if acknowledged else '')+str(error)[:4000]})
finally:
    for handle in reversed(handles): close(handle)
