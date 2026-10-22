// Shared by staging, deployment, promotion, and both rollback activation paths.
export const RELEASE_APPLICATION_FUNCTION = String.raw`
release_application_root() {
  node -e '
    try {
      const fs = require("node:fs"), path = require("node:path");
      const release = fs.realpathSync(process.argv[1]);
      const metadata = path.join(release, ".releasedeck-release");
      const rootFile = path.join(metadata, "application-root");
      const buildFile = path.join(metadata, "build");
      const optionalInfo = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return; throw error; } };
      const rootInfo = optionalInfo(rootFile), buildInfo = optionalInfo(buildFile);
      if (Boolean(rootInfo) !== Boolean(buildInfo)) throw new Error();
      let applicationRoot = ".", build = "required";
      if (rootInfo) {
        for (const info of [rootInfo, buildInfo]) {
          if (!info.isFile() || info.isSymbolicLink()) throw new Error();
        }
        applicationRoot = fs.readFileSync(rootFile, "utf8");
        build = fs.readFileSync(buildFile, "utf8");
      }
      if (build !== "required" && build !== "none") throw new Error();
      if (!applicationRoot || Buffer.byteLength(applicationRoot, "utf8") > 512 ||
          /[\u0000-\u001f\u007f]/u.test(applicationRoot) || applicationRoot.includes("\\") ||
          applicationRoot.startsWith("/") || /^[A-Za-z]:/u.test(applicationRoot)) throw new Error();
      const parts = applicationRoot === "." ? [] : applicationRoot.split("/");
      if (applicationRoot !== "." && parts.some(p => !p || p === "." || p === "..")) throw new Error();
      let application = release;
      for (const part of parts) {
        application = path.join(application, part);
        const info = fs.lstatSync(application);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
      }
      application = fs.realpathSync(application);
      const relative = path.relative(release, application);
      if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error();
      const ecosystem = path.join(application, "ecosystem.config.cjs");
      const ecosystemInfo = fs.lstatSync(ecosystem);
      if (!ecosystemInfo.isFile() || ecosystemInfo.isSymbolicLink() || fs.realpathSync(ecosystem) !== ecosystem) throw new Error();
      process.stdout.write(applicationRoot);
    } catch { process.exit(1); }
  ' "$1"
}
release_application_directory() {
  _rd_root=$(release_application_root "$1") || return 1
  if test "$_rd_root" = .; then printf '%s\n' "$1"; else printf '%s/%s\n' "$1" "$_rd_root"; fi
}
release_env_link_valid() {
  _rd_directory=$(release_application_directory "$1") || return 1
  test -L "$_rd_directory/.env" && test "$(readlink "$_rd_directory/.env")" = "$2"
}
link_release_env() {
  _rd_directory=$(release_application_directory "$1") || return 1
  ln -sfn "$2" "$_rd_directory/.env"
}
`;

export const PM2_ACTIVATION_FUNCTION = String.raw`
${RELEASE_APPLICATION_FUNCTION}
activate_pm2() {
  _rd_application_root=$(release_application_root "$1") || return 1
  _rd_application="$1"
  test "$_rd_application_root" = . || _rd_application="$1/$_rd_application_root"
  pm2_state=$(pm2 jlist --silent) || return 1
  pm2_exists=$(printf '%s' "$pm2_state" | node -e '
    try {
      const list = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      if (!Array.isArray(list)) throw new Error();
      process.stdout.write(list.some(p => p.name === process.argv[1]) ? "yes" : "no");
    } catch { process.exit(1); }
  ' "$2") || return 1
  if test "$pm2_exists" = yes; then
    pm2 delete "$2" >&2 || return 1
  fi
  # Reload/restart retains PM2's old resolved script and cwd for the same name.
  pm2 start "$_rd_application/ecosystem.config.cjs" --only "$2" >&2 || return 1
  pm2_state=$(pm2 jlist --silent) || return 1
  pm2_pid=$(printf '%s' "$pm2_state" | node -e '
    try {
      const fs = require("node:fs"), path = require("node:path");
      const release = fs.realpathSync(process.argv[1]);
      const application = fs.realpathSync(process.argv[2]);
      const name = process.argv[3];
      const applicationRelative = path.relative(release, application);
      if (applicationRelative === ".." || applicationRelative.startsWith("../") || path.isAbsolute(applicationRelative)) throw new Error();
      const ecosystem = path.join(application, "ecosystem.config.cjs");
      const ecosystemInfo = fs.lstatSync(ecosystem);
      if (!ecosystemInfo.isFile() || ecosystemInfo.isSymbolicLink() || fs.realpathSync(ecosystem) !== ecosystem) throw new Error();
      const list = JSON.parse(fs.readFileSync(0, "utf8"));
      const matches = list.filter(p => p.name === name);
      if (matches.length !== 1) throw new Error();
      const proc = matches[0], env = proc.pm2_env;
      if (!Number.isSafeInteger(proc.pid) || proc.pid <= 0 || env.status !== "online") throw new Error();
      const apps = require(ecosystem).apps;
      const definitions = apps.filter(app => app.name === name);
      if (definitions.length !== 1 || typeof definitions[0].script !== "string") throw new Error();
      const app = definitions[0];
      const cwd = fs.realpathSync(path.resolve(application, app.cwd ?? "."));
      const script = fs.realpathSync(path.resolve(cwd, app.script));
      const relative = path.relative(application, script);
      if (cwd !== application || !relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error();
      if (!fs.statSync(script).isFile() || fs.realpathSync(env.pm_exec_path) !== script || fs.realpathSync(env.pm_cwd) !== application) throw new Error();
      process.stdout.write(String(proc.pid));
    } catch {
      console.error("PM2 release path proof failed");
      process.exit(1);
    }
  ' "$1" "$_rd_application" "$2") || return 1
  case "$pm2_pid" in ''|*[!0-9]*) return 1 ;; esac
  test "$pm2_pid" -gt 0 || return 1
  printf '%s\n' "$pm2_pid"
}
`;
