#!/usr/bin/python3
"""Opt-in local Linux/systemd verifier. Never target production with this script.

Uses existing noninteractive identities (daemon and nobody), ephemeral /run fixtures,
and transient units. Creates no accounts and changes no installed configuration.
"""
import concurrent.futures
import importlib.util
import json
import os
import pathlib
import pwd
import shutil
import sys
import tempfile
import threading
import time
import uuid

spec = importlib.util.spec_from_file_location("build_launcher", pathlib.Path(__file__).with_name("launcher.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def main():
    assert os.geteuid() == 0 and pathlib.Path('/run/systemd/system').is_dir()
    worker = pwd.getpwnam('daemon')
    builder = pwd.getpwnam('nobody')
    base = pathlib.Path(tempfile.mkdtemp(prefix='releasedeck-boundary-verify-', dir='/run'))
    base.chmod(0o711)
    for name, uid, gid, mode in [('checkout', worker.pw_uid, worker.pw_gid, 0o700),
                                 ('jobs', 0, 0, 0o711), ('state', 0, 0, 0o700)]:
        p = base / name
        p.mkdir(mode=mode)
        os.chown(p, uid, gid)
    config = dict(workerUser=worker.pw_name, buildUser=builder.pw_name,
                  checkoutRoot=str(base/'checkout'), buildRoot=str(base/'jobs'),
                  stateRoot=str(base/'state'), runtimePaths=[],
                  toolPath='/usr/local/bin:/usr/bin:/bin',
                  commands=dict(npm='/usr/bin/python3', pnpm='/usr/bin/python3'))
    launcher = module.Launcher(config)
    os.environ.update(MONGODB_URI='worker-mongo-canary', REDIS_URL='worker-redis-canary',
                      GITHUB_APP_PRIVATE_KEY='worker-signing-key-canary', GITHUB_TOKEN='checkout-token-canary',
                      GITHUB_APP_ID='123', GITHUB_APP_INSTALLATION_ID='456',
                      GITHUB_APP_PRIVATE_KEY_PATH=str(base/'worker-private'/'signing-key'),
                      GITHUB_APP_JWT='app-jwt-canary', RELEASEDECK_CHECKOUT_TOKEN='installation-token-canary',
                      RELEASEDECK_CHECKOUT_PATH='owner/repository.git', GIT_ASKPASS='helper-path-canary')
    execute = launcher.execute
    def fixture_execute(*args):
        result, timed_out = execute(*args)
        if result['exitCode'] != 0 and result['stderr']:
            # Only this verifier's synthetic, credential-free fixtures run here.
            print('Linux fixture diagnostics: '+result['stderr'], flush=True)
        return result, timed_out
    launcher.execute = fixture_execute
    active_id = None
    try:
        for request in [dict(op='arbitrary-root-command'), dict(op='probe', env={'SECRET':'canary'}),
                        dict(op='open', jobId=str(uuid.uuid4()), workspacePath='/etc')]:
            try:
                launcher.handle(request)
            except (RuntimeError,ValueError):
                pass
            else:
                raise AssertionError('invalid privileged request was admitted')
        print('PASS: arbitrary commands, caller environment and out-of-root workspaces rejected',flush=True)
        launcher.handle(dict(op='probe'))
        print('PASS: actual filesystem/proc isolation and kernel network filtering probe', flush=True)
        # A disconnected/timed-out client can request close while root is still
        # copying. Close must wait; it cannot delete a tree another helper recreates.
        copy_started, release_copy = threading.Event(), threading.Event()
        original_copy = module.shutil.copytree
        def paused_copy(*args, **kwargs):
            module.shutil.copytree = original_copy
            copy_started.set()
            assert release_copy.wait(10)
            return original_copy(*args, **kwargs)
        source = base/'checkout'/('releasedeck-'+str(uuid.uuid4()))
        source.mkdir(mode=0o700)
        os.chown(source,worker.pw_uid,worker.pw_gid)
        race_id=str(uuid.uuid4())
        active_id=race_id
        module.shutil.copytree=paused_copy
        try:
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                opening=pool.submit(launcher.handle,dict(op='open',jobId=race_id,workspacePath=str(source)))
                assert copy_started.wait(10)
                closing=pool.submit(launcher.handle,dict(op='close',jobId=race_id))
                time.sleep(.1)
                assert not closing.done()
                release_copy.set()
                opening.result(timeout=10)
                closing.result(timeout=10)
            active_id=None
            assert not launcher.active.exists() and not (launcher.root/race_id).exists()
            print('PASS: teardown cannot race an in-flight root workspace copy',flush=True)
        finally:
            release_copy.set()
            module.shutil.copytree=original_copy
        for mode in ['success', 'INSTALL', 'TEST', 'BUILD', 'timeout', 'cancel', 'exception']:
            job_id = str(uuid.uuid4())
            source = base/'checkout'/('releasedeck-'+job_id)
            source.mkdir(mode=0o700)
            (source/'.git').mkdir()
            (source/'.git'/'config').write_text('nonsecret checkout-only marker')
            private = base/'worker-private'
            private.mkdir(mode=0o700,exist_ok=True)
            (private/'signing-key').write_text('nonsecret filesystem canary')
            os.chown(private,worker.pw_uid,worker.pw_gid)
            os.chown(private/'signing-key',worker.pw_uid,worker.pw_gid)
            (private/'signing-key').chmod(0o600)
            (source/'credential-link').symlink_to(private/'signing-key')
            program = """import os,pathlib,subprocess,sys,time
assert not pathlib.Path('/workspace/.git').exists()
assert not pathlib.Path('/workspace/credential-link').exists()
assert not pathlib.Path('/etc/releasedeck').exists()
assert not pathlib.Path(FIXTURE_CHECKOUT_ROOT).exists()
assert not pathlib.Path('/proc/'+WORKER_PID+'/environ').exists()
assert not any(k in os.environ for k in ['MONGODB_URI','REDIS_URL','GITHUB_APP_PRIVATE_KEY','GITHUB_TOKEN','SSH_AUTH_SOCK','GITHUB_APP_ID','GITHUB_APP_INSTALLATION_ID','GITHUB_APP_PRIVATE_KEY_PATH','GITHUB_APP_JWT','RELEASEDECK_CHECKOUT_TOKEN','RELEASEDECK_CHECKOUT_PATH','GIT_ASKPASS'])
p=subprocess.Popen(['/bin/sleep','9999'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
pathlib.Path('/workspace/background-pid').write_text(str(p.pid))
if MODE in ['timeout','cancel']:time.sleep(300)
if pathlib.Path(sys.argv[0]).name==FAIL_FILE:sys.exit(7)
print('repository command completed')
""".replace('FIXTURE_CHECKOUT_ROOT', repr(str(base/'checkout'))).replace('WORKER_PID', repr(str(os.getpid()))).replace('MODE', repr(mode)).replace('FAIL_FILE', repr({'INSTALL':'ci','TEST':'test','BUILD':'run'}.get(mode,'')))
            for name in ['ci','test','run']:
                (source/name).write_text(program)
            launcher.own_tree(source, worker.pw_uid, worker.pw_gid)
            reply = launcher.handle(dict(op='open', jobId=job_id, workspacePath=str(source)))
            active_id = job_id
            workspace = pathlib.Path(reply['workspacePath'])
            try:
                # The host-wide mutex must reject another worker/job as well.
                try:
                    launcher.handle(dict(op='open', jobId=str(uuid.uuid4()), workspacePath=str(source)))
                except FileExistsError:
                    pass
                else:
                    raise AssertionError('concurrent job was admitted')
                for stage in ['INSTALL','TEST','BUILD']:
                    request = dict(op='run',jobId=job_id,stage=stage,manager='npm',
                                   workingDirectory='.', timeoutMs=1000 if mode=='timeout' else 10000,outputLimitBytes=1024)
                    if mode=='cancel':
                        with concurrent.futures.ThreadPoolExecutor(1) as pool:
                            future=pool.submit(launcher.handle,request)
                            deadline=time.monotonic()+10
                            while not (workspace/'background-pid').exists():
                                assert time.monotonic()<deadline
                                time.sleep(.05)
                            launcher.handle(dict(op='cancel',jobId=job_id))
                            future.result(timeout=30)
                        break
                    response=launcher.handle(request)
                    launcher.no_processes()
                    if mode=='timeout':
                        assert response['timedOut'] and response['result']['exitCode']!=0
                        break
                    if mode==stage:
                        assert response['result']['exitCode']==7
                        break
                    assert response['result']['exitCode']==0, json.dumps(response)
                    if mode=='exception':
                        # Simulate a trusted runner exception between stages.
                        break
                launcher.no_processes()
                if mode=='success':
                    try:
                        launcher.handle(dict(op='completeBuild',jobId=job_id,stage='BUILD',manager='npm',workingDirectory='.'))
                    except RuntimeError:
                        pass
                    else:
                        raise AssertionError('successful BUILD was completed again')
                    launcher.handle(dict(op='collect',jobId=job_id,manager='npm',workingDirectory='.'))
                    assert workspace.stat().st_uid==worker.pw_uid
                    assert workspace.stat().st_mode & 0o777 == 0o700
                    assert not (workspace/'.git').exists()
                if mode=='INSTALL':
                    try:
                        launcher.handle(dict(op='run',jobId=job_id,stage='INSTALL',manager='pnpm',
                                             workingDirectory='.',timeoutMs=10000,outputLimitBytes=1024))
                    except RuntimeError:
                        pass
                    else:
                        raise AssertionError('package manager changed after a failed stage')
                if mode=='BUILD':
                    for invalid in [
                        dict(op='completeBuild',jobId=job_id,stage='BUILD',manager='npm',workingDirectory='.'),
                        dict(op='collect',jobId=job_id,manager='npm',workingDirectory='.'),
                    ]:
                        try:
                            launcher.handle(invalid)
                        except RuntimeError:
                            pass
                        else:
                            raise AssertionError('failed BUILD was converted to success or collected')
            finally:
                launcher.handle(dict(op='close',jobId=job_id))
                active_id=None
            launcher.no_processes()
            assert not workspace.exists() and not launcher.active.exists()
            print('PASS: '+mode+' kills detached background child, revokes workspace, and unlocks only after cleanup',flush=True)
        job_id = str(uuid.uuid4())
        source = base/'checkout'/('releasedeck-'+job_id)
        application = source/'server'
        application.mkdir(parents=True, mode=0o700)
        unicode_directory = '服务/应用'
        boundary_directory = 'é'*100 + '/' + 'é'*100 + '/' + 'é'*55
        (source/unicode_directory).mkdir(parents=True)
        (source/boundary_directory).mkdir(parents=True)
        program = "print('nested application command completed')\n"
        for name in ['ci', 'test', 'run']:
            (application/name).write_text(program)
        launcher.own_tree(source, worker.pw_uid, worker.pw_gid)
        reply = launcher.handle(dict(op='open',jobId=job_id,workspacePath=str(source)))
        active_id = job_id
        workspace = pathlib.Path(reply['workspacePath'])
        try:
            for invalid in [
                dict(op='completeBuild',jobId=job_id,stage='BUILD',manager='npm',workingDirectory='server'),
                dict(op='completeBuild',jobId=job_id,stage='INSTALL',manager='npm',workingDirectory='server'),
                dict(op='run',jobId=job_id,stage='INSTALL',manager='npm',workingDirectory='../server',timeoutMs=10000,outputLimitBytes=1024),
                dict(op='run',jobId=job_id,stage='INSTALL',manager='npm',workingDirectory='C:/server',timeoutMs=10000,outputLimitBytes=1024),
                dict(op='run',jobId=job_id,stage='INSTALL',manager='npm',workingDirectory='server\\nested',timeoutMs=10000,outputLimitBytes=1024),
                dict(op='run',jobId=job_id,stage='INSTALL',manager='npm',workingDirectory='x'*513,timeoutMs=10000,outputLimitBytes=1024),
                dict(op='run',jobId=job_id,stage='INSTALL',manager='npm',workingDirectory='\ud800',timeoutMs=10000,outputLimitBytes=1024),
                dict(op='run',jobId=job_id,stage='INSTALL',manager='npm',workingDirectory='\udc00',timeoutMs=10000,outputLimitBytes=1024),
                dict(op='run',jobId=job_id,stage='INSTALL',manager='npm',workingDirectory='é'*257,timeoutMs=10000,outputLimitBytes=1024),
            ]:
                try:
                    launcher.handle(invalid)
                except RuntimeError:
                    pass
                else:
                    raise AssertionError('invalid stage completion or working directory was admitted')
            assert launcher.validate_working_directory(launcher.root/job_id, unicode_directory) == '/workspace/'+unicode_directory
            assert len(boundary_directory.encode('utf-8')) == module.MAX_WORKING_DIRECTORY_BYTES
            assert launcher.validate_working_directory(launcher.root/job_id, boundary_directory) == '/workspace/'+boundary_directory
            install = launcher.handle(dict(op='run',jobId=job_id,stage='INSTALL',manager='npm',
                                            workingDirectory='server',timeoutMs=10000,outputLimitBytes=1024))
            assert install['result']['exitCode'] == 0
            try:
                launcher.handle(dict(op='run',jobId=job_id,stage='TEST',manager='pnpm',
                                     workingDirectory='server',timeoutMs=10000,outputLimitBytes=1024))
            except RuntimeError:
                pass
            else:
                raise AssertionError('package manager changed between stages')
            try:
                launcher.handle(dict(op='run',jobId=job_id,stage='TEST',manager='npm',
                                     workingDirectory='.',timeoutMs=10000,outputLimitBytes=1024))
            except RuntimeError:
                pass
            else:
                raise AssertionError('working directory changed between stages')
            shutil.rmtree(workspace/'server')
            (workspace/'server').symlink_to(base)
            try:
                launcher.handle(dict(op='run',jobId=job_id,stage='TEST',manager='npm',
                                     workingDirectory='server',timeoutMs=10000,outputLimitBytes=1024))
            except RuntimeError:
                pass
            else:
                raise AssertionError('symlinked working directory was admitted')
            (workspace/'server').unlink()
            (workspace/'server').mkdir()
            for name in ['test', 'run']:
                (workspace/'server'/name).write_text(program)
            launcher.own_tree(workspace, builder.pw_uid, builder.pw_gid)
            tested = launcher.handle(dict(op='run',jobId=job_id,stage='TEST',manager='npm',
                                          workingDirectory='server',timeoutMs=10000,outputLimitBytes=1024))
            assert tested['result']['exitCode'] == 0
            completed = launcher.handle(dict(op='completeBuild',jobId=job_id,stage='BUILD',
                                             manager='npm',workingDirectory='server'))
            assert completed['result']['command'] == 'releasedeck'
            assert completed['result']['args'] == ['build', 'none']
            try:
                launcher.handle(dict(op='completeBuild',jobId=job_id,stage='BUILD',
                                     manager='npm',workingDirectory='server'))
            except RuntimeError:
                pass
            else:
                raise AssertionError('BUILD was completed twice')
            shutil.rmtree(workspace/'server')
            (workspace/'server').symlink_to(base)
            try:
                launcher.handle(dict(op='collect',jobId=job_id,manager='npm',workingDirectory='server'))
            except RuntimeError:
                pass
            else:
                raise AssertionError('collection admitted a symlinked application root')
            (workspace/'server').unlink()
            (workspace/'server').mkdir()
            launcher.own_tree(workspace, builder.pw_uid, builder.pw_gid)
            launcher.handle(dict(op='collect',jobId=job_id,manager='npm',workingDirectory='server'))
            assert workspace.stat().st_uid == worker.pw_uid
        finally:
            launcher.handle(dict(op='close',jobId=job_id))
            active_id = None
        print('PASS: nested working directory, manager pinning, Unicode validation, symlink revalidation, and BUILD-none sequence enforced', flush=True)
        job_id = str(uuid.uuid4())
        source = base/'checkout'/('releasedeck-'+job_id)
        source.mkdir(mode=0o700)
        for name in ['install', 'test', 'run']:
            (source/name).write_text("print('pnpm stage completed')\n")
        launcher.own_tree(source, worker.pw_uid, worker.pw_gid)
        reply = launcher.handle(dict(op='open',jobId=job_id,workspacePath=str(source)))
        active_id = job_id
        workspace = pathlib.Path(reply['workspacePath'])
        try:
            installed = launcher.handle(dict(op='run',jobId=job_id,stage='INSTALL',manager='pnpm',
                                              workingDirectory='.',timeoutMs=10000,outputLimitBytes=1024))
            assert installed['result']['exitCode'] == 0
            try:
                launcher.handle(dict(op='run',jobId=job_id,stage='TEST',manager='npm',
                                     workingDirectory='.',timeoutMs=10000,outputLimitBytes=1024))
            except RuntimeError:
                pass
            else:
                raise AssertionError('pnpm session admitted npm')
            for stage in ['TEST', 'BUILD']:
                response = launcher.handle(dict(op='run',jobId=job_id,stage=stage,manager='pnpm',
                                                workingDirectory='.',timeoutMs=10000,outputLimitBytes=1024))
                assert response['result']['exitCode'] == 0
            try:
                launcher.handle(dict(op='completeBuild',jobId=job_id,stage='BUILD',manager='pnpm',workingDirectory='.'))
            except RuntimeError:
                pass
            else:
                raise AssertionError('successful pnpm BUILD was completed again')
            launcher.handle(dict(op='collect',jobId=job_id,manager='pnpm',workingDirectory='.'))
            assert workspace.stat().st_uid == worker.pw_uid
        finally:
            launcher.handle(dict(op='close',jobId=job_id))
            active_id = None
        print('PASS: pnpm is pinned across all required stages and cannot change to npm', flush=True)
        print('PASS: REAL LINUX SYSTEMD BUILD BOUNDARY VERIFIER',flush=True)
    finally:
        if active_id:
            launcher.handle(dict(op='close',jobId=active_id))
        shutil.rmtree(base)


if __name__=='__main__':
    main()
