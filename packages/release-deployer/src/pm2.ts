// Shared by deployment, promotion, and both rollback activation paths.
export const PM2_ACTIVATION_FUNCTION = String.raw`
activate_pm2() {
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
  pm2 start "$1/ecosystem.config.cjs" --only "$2" >&2 || return 1
  pm2_state=$(pm2 jlist --silent) || return 1
  pm2_pid=$(printf '%s' "$pm2_state" | node -e '
    try {
      const fs = require("node:fs"), path = require("node:path");
      const release = fs.realpathSync(process.argv[1]), name = process.argv[2];
      const list = JSON.parse(fs.readFileSync(0, "utf8"));
      const matches = list.filter(p => p.name === name);
      if (matches.length !== 1) throw new Error();
      const proc = matches[0], env = proc.pm2_env;
      if (!Number.isSafeInteger(proc.pid) || proc.pid <= 0 || env.status !== "online") throw new Error();
      const apps = require(path.join(release, "ecosystem.config.cjs")).apps;
      const definitions = apps.filter(app => app.name === name);
      if (definitions.length !== 1 || typeof definitions[0].script !== "string") throw new Error();
      const app = definitions[0];
      const cwd = fs.realpathSync(path.resolve(release, app.cwd ?? "."));
      const script = fs.realpathSync(path.resolve(cwd, app.script));
      const relative = path.relative(release, script);
      if (cwd !== release || !relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error();
      if (!fs.statSync(script).isFile() || fs.realpathSync(env.pm_exec_path) !== script || fs.realpathSync(env.pm_cwd) !== release) throw new Error();
      process.stdout.write(String(proc.pid));
    } catch {
      console.error("PM2 release path proof failed");
      process.exit(1);
    }
  ' "$1" "$2") || return 1
  case "$pm2_pid" in ''|*[!0-9]*) return 1 ;; esac
  test "$pm2_pid" -gt 0 || return 1
  printf '%s\n' "$pm2_pid"
}
`;
