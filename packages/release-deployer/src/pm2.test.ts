import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { PM2_ACTIVATION_FUNCTION } from './pm2.js';

async function linux(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === 'win32' ? 'wsl.exe' : 'sh',
      process.platform === 'win32' ? ['sh', '-s'] : ['-s'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
    child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`PM2 fixture failed (${String(code)}): ${stderr}`));
    });
    child.stdin.end(script);
  });
}

const setup = String.raw`set -eu
root=$(mktemp -d /tmp/releasedeck-pm2-XXXXXXXX)
export PM2_HOME="$root/pm2"
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root/A" "$root/B" "$root/B-other" "$root/bin"
name=releasedeck-isolated-test
for release in A B B-other; do
  printf 'setInterval(() => {}, 1000);\n' > "$root/$release/server.cjs"
  printf 'module.exports={apps:[{name:"%s",cwd:__dirname,script:"./server.cjs",exec_mode:"fork",instances:1}]};\n' "$name" > "$root/$release/ecosystem.config.cjs"
done
`;

test(
  'real isolated PM2 switches A -> B -> A without duplicates or touching unrelated apps',
  { skip: process.env.RELEASEDECK_TEST_REAL_PM2 !== '1' },
  async (t) => {
    const output = await linux(`${setup}
trap 'pm2 kill >/dev/null 2>&1; rm -rf -- "$root"' EXIT
command -v pm2 >/dev/null
${PM2_ACTIVATION_FUNCTION}
# Exercise first activation with neither a daemon nor a named process present.
first_pid=$(activate_pm2 "$root/A" "$name")
test "$first_pid" -gt 0
pm2 start "$root/A/server.cjs" --name unrelated >/dev/null
node --version
pm2 --version
unrelated_pid=$(pm2 pid unrelated)
for release in A B A; do
  pid=$(activate_pm2 "$root/$release" "$name")
  pm2 jlist | node -e '
    const assert = require("node:assert/strict"), fs = require("node:fs");
    const list = JSON.parse(fs.readFileSync(0,"utf8"));
    const app = list.filter(p => p.name === process.argv[1]);
    assert.equal(app.length,1);
    assert.equal(app[0].pid,Number(process.argv[3]));
    assert.equal(app[0].pm2_env.pm_exec_path,process.argv[2]+"/server.cjs");
    assert.equal(app[0].pm2_env.pm_cwd,process.argv[2]);
    assert.equal(fs.realpathSync("/proc/"+app[0].pid+"/cwd"),process.argv[2]);
    assert.equal(list.find(p => p.name === "unrelated").pid,Number(process.argv[4]));
    assert.equal(list.length,2);
  ' "$name" "$root/$release" "$pid" "$unrelated_pid"
  printf 'verified %s\n' "$release"
done
`);
    assert.match(output, /verified A\nverified B\nverified A/);
    t.diagnostic(output.trim());
  },
);

test('activation fails closed on deletion/start errors and mismatched authoritative PM2 proof', async () => {
  const output = await linux(`${setup}
cat > "$root/bin/pm2" <<'FAKE'
#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const state = process.env.PM2_HOME + '.json';
const args = process.argv.slice(2), mode = process.env.FAILURE;
let list = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state)) : [];
if (args[0] === 'jlist') { console.log(JSON.stringify(list)); process.exit(0); }
if (args[0] === 'delete') {
  if (args[1] !== 'releasedeck-isolated-test' || mode === 'delete') process.exit(1);
  list = list.filter(p => p.name !== args[1]);
} else if (args[0] === 'start') {
  if (mode === 'start') process.exit(1);
  const app = require(args[1]).apps[0], cwd = path.dirname(args[1]);
  list.push({name:app.name,pid:mode === 'pid' ? 0 : 4321,pm2_env:{
    status:mode === 'status' ? 'errored' : 'online',
    pm_exec_path:path.resolve(cwd,mode === 'script' ? '../B-other/server.cjs' : app.script),
    pm_cwd:mode === 'cwd' ? path.join(cwd,'../B-other') : cwd
  }});
  if (mode === 'duplicate') list.push(list[list.length-1]);
} else process.exit(1);
fs.writeFileSync(state,JSON.stringify(list));
FAKE
chmod +x "$root/bin/pm2"
PATH="$root/bin:$PATH"; export PATH
${PM2_ACTIVATION_FUNCTION}
# Missing process is safe; an existing process is replaced by name.
activate_pm2 "$root/A" "$name" >/dev/null
activate_pm2 "$root/B" "$name" >/dev/null
for failure in delete start script cwd status pid duplicate; do
  rm -f "$PM2_HOME.json"
  activate_pm2 "$root/A" "$name" >/dev/null
  if FAILURE="$failure" activate_pm2 "$root/B" "$name" >/dev/null; then
    printf 'unexpected success: %s\n' "$failure" >&2; exit 1
  fi
  printf 'rejected %s\n' "$failure"
done
# A repository definition must not direct execution outside its release.
rm -f "$PM2_HOME.json"
printf 'module.exports={apps:[{name:"%s",cwd:__dirname,script:"../B-other/server.cjs"}]};\n' "$name" > "$root/B/ecosystem.config.cjs"
if activate_pm2 "$root/B" "$name" >/dev/null; then exit 1; fi
printf 'rejected escape\n'
ln -s "$root/B-other/server.cjs" "$root/B/link.cjs"
printf 'module.exports={apps:[{name:"%s",cwd:__dirname,script:"./link.cjs"}]};\n' "$name" > "$root/B/ecosystem.config.cjs"
if activate_pm2 "$root/B" "$name" >/dev/null; then exit 1; fi
printf 'rejected symlink\n'
`);
  for (const failure of [
    'delete',
    'start',
    'script',
    'cwd',
    'status',
    'pid',
    'duplicate',
    'escape',
    'symlink',
  ])
    assert.match(output, new RegExp(`rejected ${failure}`));
});
