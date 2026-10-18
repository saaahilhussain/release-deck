#!/usr/bin/python3 -I
"""Root-owned, no-argument sudo entrypoint. No repository code executes here.

JSON stdin operations only; configuration/commands/properties are root-controlled.
All errors deliberately omit paths, command output, and request/environment values.
"""
import grp
import fcntl
from contextlib import contextmanager
import json
import os
import pathlib
import pwd
import re
import selectors
import shutil
import socket
import stat
import subprocess
import sys
import time
import uuid

CONFIG = "/etc/releasedeck/build-executor.json"
STAGES = ["INSTALL", "TEST", "BUILD"]
SYSTEM_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}


def require(value):
    if not value:
        raise RuntimeError("build boundary rejected operation")


def protected(path, owner=0, directory=False):
    path = pathlib.Path(path)
    require(path.is_absolute() and not path.is_symlink() and path.resolve() == path)
    require(re.fullmatch(r"/[A-Za-z0-9_./-]+", str(path)))
    info = path.stat()
    require(info.st_uid == owner and not info.st_mode & 0o022)
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
    # A safe leaf is insufficient when an ancestor is writable or replaceable.
    for parent in path.parents:
        p = parent.stat()
        require(p.st_uid == 0 and not p.st_mode & 0o022 and not parent.is_symlink())
    return path


def checked(args, allowed=(0,), timeout=30):
    result = subprocess.run(args, env=SYSTEM_ENV, capture_output=True, timeout=timeout)
    require(result.returncode in allowed)
    return result


def build_environment(tool_path):
    # The Linux form of createCiEnvironment: no caller-supplied environment.
    return {
        "CI": "true", "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null", "PATH": tool_path, "HOME": "/workspace",
        "TEMP": "/workspace/.tmp", "TMP": "/workspace/.tmp", "TMPDIR": "/workspace/.tmp",
        "NPM_CONFIG_CACHE": "/workspace/.npm-cache", "NPM_CONFIG_USERCONFIG": "/dev/null",
        "NPM_CONFIG_GLOBAL": "false", "COREPACK_HOME": "/workspace/.corepack-cache",
    }


class Launcher:
    def __init__(self, config):
        require(os.geteuid() == 0 and sys.platform == "linux")
        self.worker = pwd.getpwnam(config["workerUser"])
        self.builder = pwd.getpwnam(config["buildUser"])
        require(self.worker.pw_uid != self.builder.pw_uid and self.builder.pw_uid != 0 and self.worker.pw_uid != 0)
        require(self.worker.pw_gid != 0 and self.builder.pw_gid not in [0, self.worker.pw_gid])
        require(self.builder.pw_shell in ["/usr/sbin/nologin", "/sbin/nologin", "/bin/false"])
        require(self.worker.pw_shell in ["/usr/sbin/nologin", "/sbin/nologin", "/bin/false"])
        require(not [g for g in grp.getgrall() if self.builder.pw_name in g.gr_mem or self.worker.pw_name in g.gr_mem])
        # Direct root invocation is reserved for operators/verifiers. sudo always
        # supplies SUDO_UID; the build account is never authorized by sudoers.
        require("SUDO_UID" not in os.environ or int(os.environ["SUDO_UID"]) == self.worker.pw_uid)
        self.checkout = protected(config["checkoutRoot"], self.worker.pw_uid, True)
        require(stat.S_IMODE(self.checkout.stat().st_mode) == 0o700)
        self.root = protected(config["buildRoot"], directory=True)
        self.state = protected(config["stateRoot"], directory=True)
        require(stat.S_IMODE(self.root.stat().st_mode) == 0o711)
        require(stat.S_IMODE(self.state.stat().st_mode) == 0o700)
        require(self.checkout != self.root and not self.root.is_relative_to(self.checkout))
        self.active = self.state / "active"
        self.config = config
        require(pathlib.Path("/sys/fs/cgroup/cgroup.controllers").is_file())
        require(pathlib.Path("/proc/sys/fs/protected_hardlinks").read_text().strip() == "1")
        for name in ["npm", "pnpm"]:
            # Config is privileged. Executables and their parents must be immutable
            # to both worker and builder; symlink targets are checked canonically.
            protected(pathlib.Path(config["commands"][name]).resolve())
        for path in config["runtimePaths"]:
            p = protected(path, directory=True)
            require(str(p) == "/opt/releasedeck-build-tools" or re.fullmatch(r"/opt/node-v[0-9.]+-linux-[a-z0-9_]+", str(p)))
        for entry in config["toolPath"].split(":"):
            protected(pathlib.Path(entry).resolve(), directory=True)

    def no_processes(self):
        for path in pathlib.Path("/proc").iterdir():
            if not path.name.isdecimal():
                continue
            try:
                match = re.search(r"^Uid:\s+(\d+)", (path / "status").read_text(), re.M)
                require(match and int(match[1]) != self.builder.pw_uid)
            except (FileNotFoundError, ProcessLookupError):
                pass

    @contextmanager
    def lifecycle(self):
        # A timed-out client may leave a root-side copy/collection in progress.
        # Never let close/delete race that operation, or let a new run race close.
        fd = os.open(self.state / 'operation.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def job(self, request):
        job_id = request["jobId"]
        require(str(uuid.UUID(job_id)) == job_id)
        data = json.loads((self.active / "job.json").read_text())
        require(data["jobId"] == job_id)
        return data, self.root / job_id

    def save(self, data):
        # Root-private state never contains credentials or child output.
        temp = self.active / "state.new"
        temp.write_text(json.dumps(data))
        os.replace(temp, self.active / "job.json")

    def unit(self, job_id):
        return "releasedeck-build-" + job_id + ".service"

    def stop(self, job_id):
        unit = self.unit(job_id)
        # Stopping an already collected transient unit is idempotent. Do not infer
        # safety from the client's exit status: inspect the cgroup and UID below.
        subprocess.run(["/usr/bin/systemctl", "stop", unit], env=SYSTEM_ENV,
                       capture_output=True, timeout=25)
        result = checked(["/usr/bin/systemctl", "show", unit, "--property=ActiveState", "--value"])
        require(result.stdout.strip() in [b"inactive", b"failed", b""])
        self.no_processes()

    def properties(self, job_id, base, timeout_ms):
        workspace = base / "workspace"
        rootfs = base / "rootfs"
        # Only operating-system/runtime paths and this job's workspace are mounted.
        # /etc/releasedeck, host homes, checkout trees, artifacts, /run sockets,
        # other jobs, and the control-plane source do not exist in this view.
        readonly = ["/usr", "/bin", "/lib"]
        if pathlib.Path("/lib64").exists():
            readonly.append("/lib64")
        for name in ["/etc/ssl", "/etc/alternatives", "/etc/hosts", "/etc/passwd",
                     "/etc/group", "/etc/nsswitch.conf", "/etc/ld.so.cache", "/etc/resolv.conf"]:
            if pathlib.Path(name).exists():
                readonly.append(str(pathlib.Path(name).resolve()) + ":" + name)
        readonly += self.config["runtimePaths"]
        props = {
            "User": self.builder.pw_name, "Group": str(self.builder.pw_gid),
            "WorkingDirectory": "/workspace", "RootDirectory": str(rootfs),
            "BindPaths": str(workspace) + ":/workspace",
            "BindReadOnlyPaths": " ".join(readonly), "MountAPIVFS": "yes",
            "KillMode": "control-group", "SendSIGKILL": "yes", "TimeoutStopSec": "5s",
            "RuntimeMaxSec": str(timeout_ms / 1000) + "s", "UMask": "0077",
            "NoNewPrivileges": "yes", "CapabilityBoundingSet": "", "AmbientCapabilities": "",
            "ProtectSystem": "strict", "ReadWritePaths": "/workspace",
            "ProtectHome": "yes", "ProtectProc": "invisible", "ProcSubset": "pid",
            "ProtectControlGroups": "yes", "ProtectKernelTunables": "yes",
            "ProtectKernelModules": "yes", "ProtectKernelLogs": "yes",
            "PrivateDevices": "yes", "PrivateIPC": "yes", "RestrictNamespaces": "yes",
            "RestrictSUIDSGID": "yes", "LockPersonality": "yes", "Delegate": "no",
            "RestrictAddressFamilies": "AF_UNIX AF_INET AF_INET6",
            "TemporaryFileSystem": "/tmp:rw,nodev,nosuid /var/tmp:rw,nodev,nosuid /dev/shm:rw,nodev,nosuid /run:ro",
            "IPAddressDeny": "127.0.0.1/32 ::1/128 169.254.0.0/16 fd00:ec2::254/128",
        }
        return ["--property=" + key + "=" + value for key, value in props.items()]

    def execute(self, job_id, base, command, timeout_ms, limit):
        args = ["/usr/bin/systemd-run", "--quiet", "--wait", "--pipe", "--collect",
                "--service-type=exec", "--unit=" + self.unit(job_id)]
        args += self.properties(job_id, base, timeout_ms)
        # env -i also excludes any administrator-set systemd DefaultEnvironment;
        # only these nonsecret, derived values become the repository environment.
        args += ["--", "/usr/bin/env", "-i"]
        args += [key + "=" + value for key, value in build_environment(self.config["toolPath"]).items()]
        args += command
        started = time.monotonic()
        child = subprocess.Popen(args, env=SYSTEM_ENV, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        output = {"stdout": bytearray(), "stderr": bytearray()}
        truncated = {"stdout": False, "stderr": False}
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ, "stdout")
        selector.register(child.stderr, selectors.EVENT_READ, "stderr")
        timed_out = False
        try:
            while selector.get_map():
                if time.monotonic() - started > timeout_ms / 1000 + 10:
                    timed_out = True
                    self.stop(job_id)
                    child.kill()
                for key, _ in selector.select(0.1):
                    chunk = os.read(key.fileobj.fileno(), 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    buf = output[key.data]
                    available = max(0, limit - len(buf))
                    truncated[key.data] |= len(chunk) > available
                    buf.extend(chunk[:available])
            code = child.wait(timeout=10)
            # systemd's RuntimeMaxSec can fire before our outer watchdog.
            timed_out |= time.monotonic() - started >= timeout_ms / 1000 and code != 0
        finally:
            selector.close()
            self.stop(job_id)
            if child.poll() is None:
                child.kill()
            child.wait(timeout=10)
            child.stdout.close()
            child.stderr.close()
        return {
            "command": command[0], "args": command[1:], "exitCode": code, "signal": None,
            "stdout": bytes(output["stdout"]).decode("utf-8", "ignore"),
            "stderr": bytes(output["stderr"]).decode("utf-8", "ignore"),
            "stdoutTruncated": truncated["stdout"], "stderrTruncated": truncated["stderr"],
            "durationMs": round((time.monotonic() - started) * 1000),
        }, timed_out

    def own_tree(self, root, uid, gid):
        # Call only after stop()+no_processes(). Never follow repository symlinks.
        for directory, dirs, files in os.walk(root, followlinks=False):
            os.chown(directory, uid, gid, follow_symlinks=False)
            os.chmod(directory, 0o700)
            for name in dirs + files:
                path = pathlib.Path(directory) / name
                info = path.lstat()
                require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode))
                os.chown(path, uid, gid, follow_symlinks=False)
                if stat.S_ISREG(info.st_mode):
                    os.chmod(path, 0o700 if info.st_mode & 0o111 else 0o600)

    def open(self, request):
        self.no_processes()
        job_id = request["jobId"]
        require(str(uuid.UUID(job_id)) == job_id)
        source = pathlib.Path(request["workspacePath"])
        require(source.parent == self.checkout and source.name.startswith("releasedeck-"))
        require(source.resolve() == source and not source.is_symlink())
        require(source.stat().st_uid == self.worker.pw_uid)
        self.active.mkdir(mode=0o700)  # Cross-process, host-wide fail-closed mutex.
        base = self.root / job_id
        try:
            self.save({"jobId": job_id, "nextStage": 0, "collected": False})
            base.mkdir(mode=0o711)
            (base / "rootfs").mkdir(mode=0o755)
            # Checkout is never executed with the build UID. Its .git/config and
            # credential mechanisms are deliberately absent from the handoff.
            shutil.copytree(source, base / "workspace", symlinks=True,
                            ignore=lambda directory, names: [".git", ".tmp", ".npm-cache", ".corepack-cache"] if pathlib.Path(directory) == source else [])
            self.own_tree(base / "workspace", self.builder.pw_uid, self.builder.pw_gid)
            (base / "workspace" / ".tmp").mkdir(exist_ok=True)
            os.chown(base / "workspace" / ".tmp", self.builder.pw_uid, self.builder.pw_gid)
            return {"workspacePath": str(base / "workspace")}
        except BaseException:
            self.no_processes()
            if base.exists():
                shutil.rmtree(base)
            shutil.rmtree(self.active)
            raise

    def probe(self):
        require(not self.active.exists())
        self.no_processes()
        checked(["/usr/bin/systemctl", "is-system-running"], allowed=(0, 1))
        job_id = str(uuid.uuid4())
        self.active.mkdir(mode=0o700)
        base = self.root / job_id
        listener = socket.socket()
        try:
            self.save({"jobId": job_id})
            base.mkdir(mode=0o711)
            (base / "rootfs").mkdir(mode=0o755)
            (base / "workspace").mkdir(mode=0o700)
            os.chown(base / "workspace", self.builder.pw_uid, self.builder.pw_gid)
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            with socket.create_connection(listener.getsockname(), timeout=2):
                peer, _ = listener.accept()
                peer.close()
            # Reject kernels/systemd installations that silently ignore address
            # filtering or filesystem isolation. No credentials enter this probe.
            program = """import os,pathlib,socket,sys
assert not pathlib.Path('/etc/releasedeck').exists()
assert not pathlib.Path(sys.argv[1]).exists()
assert not pathlib.Path('/proc/'+sys.argv[2]+'/environ').exists()
assert os.access(sys.argv[4],os.X_OK) and os.access(sys.argv[5],os.X_OK)
pathlib.Path('/workspace/probe').write_text('nonsecret')
s=socket.socket();s.settimeout(2)
try:s.connect(('127.0.0.1',int(sys.argv[3])))
except OSError as e:assert isinstance(e,TimeoutError) or e.errno in (1,13)
else:raise RuntimeError('network filter missing')
"""
            result, _ = self.execute(job_id, base, ["/usr/bin/python3", "-I", "-c", program,
                str(self.checkout), str(os.getpid()), str(listener.getsockname()[1]),
                self.config["commands"]["npm"], self.config["commands"]["pnpm"]], 10_000, 1024)
            require(result["exitCode"] == 0)
        finally:
            listener.close()
            self.stop(job_id)
            if base.exists():
                shutil.rmtree(base)
            shutil.rmtree(self.active)

    def cancel(self, request):
        data, _ = self.job(request)
        (self.active / "cancelled").touch(mode=0o600)
        deadline = time.monotonic() + 40
        # Serialize cancellation with systemd unit creation, not just the client's
        # PID: repeat stop until the in-flight launcher has acknowledged teardown.
        while True:
            self.stop(data["jobId"])
            if not (self.active / "running").exists():
                break
            require(time.monotonic() < deadline)
            time.sleep(0.05)

    def handle(self, request):
        require(isinstance(request, dict))
        op = request.get("op")
        expected = {
            "probe": {"op"}, "open": {"op", "jobId", "workspacePath"},
            "run": {"op", "jobId", "stage", "manager", "timeoutMs", "outputLimitBytes"},
            "cancel": {"op", "jobId"}, "collect": {"op", "jobId"}, "close": {"op", "jobId"},
        }
        require(op in expected and set(request) == expected[op])
        if op == "cancel":
            self.cancel(request)
            return {}
        with self.lifecycle():
            if op == "probe":
                self.probe()
                return {}
            if op == "open":
                return self.open(request)
            if op == "close" and not self.active.exists():
                self.no_processes()
                return {}
            data, base = self.job(request)
            if op == "close":
                self.cancel(request)
                shutil.rmtree(base)
                shutil.rmtree(self.active)  # Unlock only after workspace revocation.
                return {}
            if op == "collect":
                require(data["nextStage"] == 3 and not (self.active / "running").exists())
                require(not (self.active / "cancelled").exists())
                self.stop(data["jobId"])
                self.own_tree(base / "workspace", self.worker.pw_uid, self.worker.pw_gid)
                data["collected"] = True
                self.save(data)
                return {}
            require(op == "run" and not data["collected"])
            require(not (self.active / "cancelled").exists())
            stage = request["stage"]
            require(data["nextStage"] < 3 and stage == STAGES[data["nextStage"]])
            manager = request["manager"]
            require(manager in ["npm", "pnpm"])
            timeout = request["timeoutMs"]
            limit = request["outputLimitBytes"]
            require(type(timeout) is int and 1 <= timeout <= 86_400_000)
            require(type(limit) is int and 1 <= limit <= 1_048_576)
            marker = self.active / "running"
            fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(fd)
        try:
            require(not (self.active / "cancelled").exists())
            args = (["ci"] if manager == "npm" else ["install", "--frozen-lockfile"]) if stage == "INSTALL" else (["test"] if stage == "TEST" else ["run", "build"])
            result, timed_out = self.execute(data["jobId"], base,
                                             [self.config["commands"][manager]] + args, timeout, limit)
            if result["exitCode"] == 0:
                data["nextStage"] += 1
                self.save(data)
            return {"result": result, "timedOut": timed_out}
        finally:
            self.stop(data["jobId"])
            marker.unlink(missing_ok=True)


def main():
    try:
        require(len(sys.argv) == 1)
        config_path = protected(CONFIG)
        launcher = Launcher(json.loads(config_path.read_text()))
        raw = sys.stdin.buffer.read(8193)
        require(len(raw) <= 8192)
        result = launcher.handle(json.loads(raw))
        print(json.dumps({"ok": True, **result}))
    except BaseException:
        print('{"ok":false}')
        sys.exit(1)


if __name__ == "__main__":
    main()
