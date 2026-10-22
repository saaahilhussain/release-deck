# CI runner contract

## Repository build plan

Without a root `.releasedeck.json`, CI preserves the original contract: the Node
application is the repository root and BUILD is required. A repository may instead
commit this strict, data-only version 1 manifest:

```json
{
  "schemaVersion": 1,
  "applicationRoot": "server",
  "build": "none"
}
```

Only `schemaVersion`, `applicationRoot`, and `build` are accepted. The application
root defaults to `.` and build defaults to `required`. It must be a bounded,
repository-relative POSIX directory with no link components. Exactly one
`package-lock.json` or `pnpm-lock.yaml` must exist in that directory. Install and
test remain mandatory fixed npm/pnpm operations. `build: "none"` records a trusted
successful BUILD result without running repository build code. All repository
commands run from the validated application root, which is revalidated after every
repository-controlled stage and before artifact collection.

## Private GitHub checkout

Public checkout remains credential-free and needs no GitHub App configuration.
Only a GitHub HTTPS fetch reporting an explicit authentication/prompt failure can
use the optional App provider. A plain repository-not-found error, invalid SHA,
transport failure, or unsupported host/protocol does not trigger authentication.
GitHub intentionally obscures private repository existence; a typo and an
unauthorized private repository cannot always be distinguished. Errors fail closed.

## Future production configuration

The user must create/install the App later, on **selected repositories only**, with
repository **Contents: Read-only** (GitHub's implicit Metadata: Read-only is allowed).
No organization, administration, write, webhook, or user permissions are needed by
this checkout provider. Existing webhook authentication remains separate.

Configure all three worker EnvironmentFile values, or omit all three:

```dotenv
GITHUB_APP_ID=<numeric-app-id>
GITHUB_APP_INSTALLATION_ID=<numeric-installation-id>
GITHUB_APP_PRIVATE_KEY_PATH=/etc/releasedeck/github-app.pem
```

Use the normal PEM downloaded for the App, unencrypted RSA (at least 2048 bits).
The path avoids multiline EnvironmentFile encoding. Store it outside checkout roots,
source, artifacts, and build-visible runtime mounts; make it worker-owned mode 600
under protected directories (root-owned mode 600 is also accepted when readable by
the worker). The provider rejects nonregular files, symlinks, other owners, and
group/world permissions on Linux. Missing/invalid keys fail before queue connections.
Never place a key in this repository. Windows filesystem ACL validation is not a
production contract; actual authenticated worker execution requires the Linux
systemd boundary, including `CI_EXECUTION_MODE=systemd` and `CI_CONCURRENCY=1`.
Same-user/local builds cannot be used with App configuration.

The trusted worker signs RS256 JWTs using Node crypto, with `iss` equal to App ID,
`iat` backdated 60 seconds, and `exp` five minutes ahead. Only the fixed
`https://api.github.com/app/installations/<id>/access_tokens` endpoint receives the
JWT, with redirects disabled. Each request narrows to one repository name and
`contents: read`. GitHub enforces installation authorization. API requests are
bounded to ten seconds and the remaining checkout budget; responses are bounded,
validated for expiry/permissions, and never logged.

After a failed public fetch, a token-free temporary Node credential helper is
created beside the checkout under the worker's private checkout root. Git receives
only the installation token and intended repository path in its fetch environment.
In-memory Git configuration resets helpers, enables `credential.useHttpPath`, and
disables redirects. The helper answers `get` only for HTTPS, exactly `github.com`,
and the intended owner/repository path. It never stores credentials. App signing
material/JWT never reaches Git. Credentials never enter argv, URLs, or Git config
files. Authenticated fetch disables hooks, recursive submodule fetch and automatic
GC/maintenance, so they cannot retain the checkout token in a background process.
Ambient credential managers, ASKPASS, SSH agents, tracing, and Git config
remain excluded by the existing process-environment allowlist.

Authenticated fetch output is discarded and failures expose fixed safe diagnostics.
The helper is removed and token references cleared before detached exact-SHA
checkout/verification and source handoff. No token cache or credential file is
created. GitHub installation tokens expire after about one hour; this implementation
does not cache or revoke them, and makes no JavaScript memory-zeroization claim.
The App provider retains its signing KeyObject only in the trusted worker.
Install/test/build use the established restricted identity and allowlisted
environment. General hostile-code sandboxing, network policy and resource quotas
remain subject to the build-execution provisioning contract.

Tests make no live GitHub API calls. App creation, production provisioning and
deployment are separate operator tasks.
