# Production build execution contract

This is a provisioning contract and an opt-in local verifier. Nothing here installs
accounts, sudo rules, or services automatically. Do not run provisioning against
production as part of a source review.

## Boundary

The trusted worker checks out and verifies the exact SHA under its private checkout
root. It asks the root-owned launcher to copy source into one restricted build
workspace. The copy excludes `.git` and CI temporary/cache directories; checkout
helpers and future signing credentials must live outside the copied source tree.
Build scripts do not receive Git metadata. Projects depending on `.git` during CI
need a separately reviewed metadata contract.

Only install/test/build use this executor, including all package-manager lifecycle
scripts and their descendants. Fixed npm/pnpm commands execute as `releasedeck-build`
inside per-stage transient systemd units. A root-owned per-job filesystem view binds
read-only OS/runtime paths and the current writable `/workspace`. Host homes,
control-plane source, secrets, checkout roots, other jobs, artifacts, and host `/run`
sockets are absent. Proc visibility hides other users. Capabilities, privilege
escalation, namespaces, cgroup delegation, and host filesystem writes are denied.
Loopback control-plane and link-local metadata endpoints are blocked; DNS through
127.0.0.53 and ordinary external package traffic remain possible. This is not a
general-purpose hostile-code container platform or a network exfiltration solution.

`KillMode=control-group`, a stop deadline, forced SIGKILL and `RuntimeMaxSec` bound
each stage. Success also stops the unit and verifies zero processes for the dedicated
build UID. Session detachment does not escape a cgroup. Cancellation is a separate
privileged operation which waits across unit creation/teardown races. Before artifact
collection, the stopped workspace is returned to worker ownership and mode 700.
Existing artifact packaging runs in the trusted worker without dereferencing symlinks.
Close removes the build workspace before releasing the host-wide job lock. Failure
to confirm termination or cleanup retains the lock and fails closed.
Root-side lifecycle operations are also serialized, so a disconnected client cannot
race workspace deletion against an unfinished source copy or ownership handoff.

The reusable identity requires **CI_CONCURRENCY=1**. Runtime validation and worker
startup enforce it, and the launcher also refuses overlapping jobs across worker
processes. Local development keeps the existing same-user runner on Windows/Linux;
it makes no production security claim. `NODE_ENV=production` requires
`CI_EXECUTION_MODE=systemd`. Missing sudo access, launcher, kernel features, tools,
or a failed isolation probe prevent worker startup; there is no local fallback.

## Later EC2 provisioning checklist

1. Create locked noninteractive `releasedeck-worker` and `releasedeck-build` accounts
   with separate primary groups, no supplementary/admin groups, no passwords, and no
   general sudo access. The build UID must be dedicated and have no other services,
   cron jobs, persistent user manager, or login sessions.
2. Install `launcher.py` as `/usr/local/libexec/releasedeck-build-launcher`, root:root
   755, with immutable-to-worker parent directories. Its isolated Python shebang is
   required. It accepts **no command-line arguments** and bounded JSON stdin only.
3. Install reviewed `config.example.json` at `/etc/releasedeck/build-executor.json`,
   root:root 600. All ancestors and runtime executables must be root-owned and not
   group/world-writable. Include only credential-free runtime directories in
   `runtimePaths`, never application/configuration/credential trees. Do not mount
   `/etc`, `/home`, `/root`, `/var`, `/opt`, or a checkout/artifact root wholesale.
4. Create the checkout root worker:worker 700 beneath root-owned parents. Create
   buildRoot root:root **711**, stateRoot root:root **700**. Provision stateRoot at
   boot with a root-owned tmpfiles rule. Workspace and artifact roots must be
   disjoint; all worker environment/key files remain worker-readable only and
   outside build-visible runtime paths. Protect the control-plane code from writes
   by both identities. Runtime binaries and every required npm/pnpm module must be
   readable/executable by the build user (the earlier root-only pnpm layout must
   be corrected separately during provisioning).
5. Require Linux cgroup v2, systemd with the properties used by the launcher, Python
   3.12+, `/usr/bin/sudo`, protected hardlinks enabled, and functional systemd IP
   address filtering. Startup runs an actual restricted-unit probe, including a
   listening loopback endpoint: unsupported/ignored filtering fails closed.
6. Grant only this sudoers command, with the explicit empty argument restriction:

   ```sudoers
   releasedeck-worker ALL=(root) NOPASSWD: /usr/local/libexec/releasedeck-build-launcher ""
   ```

   Do not grant sudo to the build user or grant the worker direct systemd-run,
   systemctl, shell, Python, chown, or general root commands. No polkit grant or
   privileged daemon is needed. Keep worker service capability restrictions
   compatible with this specific sudo transition; do not apply NoNewPrivileges to
   the trusted worker service itself because sudo then cannot elevate. Each build
   unit always has NoNewPrivileges enabled.

7. Configure worker `NODE_ENV=production`, `CI_EXECUTION_MODE=systemd`,
   `CI_CONCURRENCY=1`, `CI_WORKSPACE_ROOT` equal to configured checkoutRoot, and
   `CI_BUILD_LAUNCHER_PATH=/usr/local/libexec/releasedeck-build-launcher`.
8. Verify on a separate Linux test host before provisioning production. The local
   root verifier uses existing `daemon` and `nobody`, only if the build UID is otherwise
   unused. It creates transient units and ephemeral `/run` fixtures, never accounts
   or installed configuration:

   ```sh
   sudo python3 -B ops/build-executor/verify_linux.py
   ```

If a worker is forcibly killed or the host crashes, systemd still bounds an active
stage by RuntimeMaxSec. An unfinished job lock deliberately prevents reuse after
restart. An operator must stop the recorded unit, verify the build UID has no
processes, remove that job's workspace, then remove its lock. Never clear a lock
before those checks; ordinary runner errors execute this cleanup automatically.
Disk/memory/CPU quotas, external package availability, general network policy,
parallel identities, and full malicious-artifact validation remain separate work.

GitHub App authentication is intentionally the following milestone. This change
adds no GitHub App settings, token requests, signing keys, PATs, or live GitHub calls.
