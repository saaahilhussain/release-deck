export const STAGE_REMOTE_SCRIPT = String.raw`set -eu
project_id=$1
deployment_id=$2
commit_sha=$3
root=$4
archive=$5
archive_sha=$6
attempt_id=$7

valid_uuid() {
  case "$1" in
    ????????-????-????-????-????????????) ;;
    *) return 1 ;;
  esac
  case "$1" in *[!0-9a-fA-F-]*) return 1 ;; esac
}
valid_uuid "$project_id" || exit 64
valid_uuid "$deployment_id" || exit 64
valid_uuid "$attempt_id" || exit 64
case "$commit_sha" in
  ????????????????????????????????????????) ;;
  *) exit 64 ;;
esac
case "$commit_sha" in *[!0-9a-fA-F]*) exit 64 ;; esac
case "$archive_sha" in
  ????????????????????????????????????????????????????????????????) ;;
  *) exit 64 ;;
esac
case "$archive_sha" in *[!0-9a-fA-F]*) exit 64 ;; esac
case "$root" in /*) ;; *) exit 64 ;; esac
case "$root" in /|*//*|*/../*|*/..|*/./*|*/.|*[!A-Za-z0-9._/-]*) exit 64 ;; esac
case "$archive" in /tmp/releasedeck-*.tar.gz) ;; *) exit 64 ;; esac
case "$archive" in *//*|*/../*|*/..|*[!A-Za-z0-9._/-]*) exit 64 ;; esac

base="$root/$project_id"
releases="$base/releases"
target="$releases/$deployment_id"
stage="$releases/.staging-$deployment_id-$attempt_id"
test -f "$base/shared/.env"
mkdir -p "$releases"
rm -rf -- "$stage"
mkdir -- "$stage"
trap 'rm -rf -- "$stage"; rm -f -- "$archive"' EXIT

actual_sha=$(sha256sum "$archive" | awk '{print $1}')
test "$actual_sha" = "$archive_sha"
tar -xzf "$archive" -C "$stage"
test -f "$stage/ecosystem.config.cjs"
test "$(cat "$stage/.releasedeck-release/project-id")" = "$project_id"
test "$(cat "$stage/.releasedeck-release/deployment-id")" = "$deployment_id"
test "$(cat "$stage/.releasedeck-release/commit-sha")" = "$commit_sha"
printf '%s' "$archive_sha" > "$stage/.releasedeck-release/archive-sha256"
ln -s "$base/shared/.env" "$stage/.env"

if test -e "$target" || test -L "$target"; then
  test -d "$target"
  test ! -L "$target"
  test "$(cat "$target/.releasedeck-release/project-id")" = "$project_id"
  test "$(cat "$target/.releasedeck-release/deployment-id")" = "$deployment_id"
  test "$(cat "$target/.releasedeck-release/commit-sha")" = "$commit_sha"
  test "$(cat "$target/.releasedeck-release/archive-sha256")" = "$archive_sha"
else
  mv -Tn -- "$stage" "$target" || true
fi

test -d "$target"
test ! -L "$target"
test "$(cat "$target/.releasedeck-release/project-id")" = "$project_id"
test "$(cat "$target/.releasedeck-release/deployment-id")" = "$deployment_id"
test "$(cat "$target/.releasedeck-release/commit-sha")" = "$commit_sha"
test "$(cat "$target/.releasedeck-release/archive-sha256")" = "$archive_sha"

rm -rf -- "$stage"
rm -f -- "$archive"
trap - EXIT
printf 'RELEASE_STAGED project=%s deployment=%s sha=%s path=%s\n' \
  "$project_id" "$deployment_id" "$commit_sha" "$target"
`;

export const ACTIVATE_REMOTE_SCRIPT = String.raw`set -eu
project_id=$1
deployment_id=$2
commit_sha=$3
root=$4
keep=$5
attempt_id=$6

valid_uuid() {
  case "$1" in
    ????????-????-????-????-????????????) ;;
    *) return 1 ;;
  esac
  case "$1" in *[!0-9a-fA-F-]*) return 1 ;; esac
}
valid_uuid "$project_id" || exit 64
valid_uuid "$deployment_id" || exit 64
valid_uuid "$attempt_id" || exit 64
case "$commit_sha" in
  ????????????????????????????????????????) ;;
  *) exit 64 ;;
esac
case "$commit_sha" in *[!0-9a-fA-F]*) exit 64 ;; esac
case "$root" in /*) ;; *) exit 64 ;; esac
case "$root" in /|*//*|*/../*|*/..|*/./*|*/.|*[!A-Za-z0-9._/-]*) exit 64 ;; esac
case "$keep" in 2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20) ;; *) exit 64 ;; esac

base="$root/$project_id"
releases="$base/releases"
target="$releases/$deployment_id"
next="$base/.current-$attempt_id"
test -d "$base"
test ! -L "$base"
exec 9>"$base/.release.lock"
flock -w 300 9 || exit 75
test -d "$target"
test ! -L "$target"
test -f "$base/shared/.env"
test "$(cat "$target/.releasedeck-release/project-id")" = "$project_id"
test "$(cat "$target/.releasedeck-release/deployment-id")" = "$deployment_id"
test "$(cat "$target/.releasedeck-release/commit-sha")" = "$commit_sha"
test -s "$target/.releasedeck-release/archive-sha256"
test "$(readlink "$target/.env")" = "$base/shared/.env"

rm -f -- "$next"
ln -s "releases/$deployment_id" "$next"
mv -Tf -- "$next" "$base/current"
test "$(readlink "$base/current")" = "releases/$deployment_id"
active=$(readlink -f "$base/current")
test "$active" = "$target"

name="releasedeck-$project_id"
pm2 startOrReload "$target/ecosystem.config.cjs" --only "$name" --update-env
pid=$(pm2 pid "$name")
case "$pid" in ''|*[!0-9]*) exit 68 ;; esac
test "$pid" -gt 0
sudo -n nginx -t
sudo -n nginx -s reload

previous=$((keep - 1))
find "$releases" -mindepth 1 -maxdepth 1 -type d \
  -name '????????-????-????-????-????????????' ! -name "$deployment_id" \
  -printf '%T@ %f\n' | sort -rn | awk -v keep="$previous" 'NR > keep {print $2}' | \
  while IFS= read -r old; do
    test -n "$old" || continue
    valid_uuid "$old" || exit 69
    rm -rf -- "$releases/$old"
  done

test "$(readlink "$base/current")" = "releases/$deployment_id"
active=$(readlink -f "$base/current")
test "$active" = "$target"

printf 'RELEASE_PROOF project=%s deployment=%s sha=%s path=%s active=%s pm2=%s pid=%s nginxValidated=1 nginxReloaded=1\n' \
  "$project_id" "$deployment_id" "$commit_sha" "$target" "$active" "$name" "$pid"
`;

export const PROMOTE_REMOTE_SCRIPT = String.raw`set -u
project_id=$1 deployment_id=$2 commit_sha=$3 root=$4 keep=$5 attempt_id=$6
health_url=$7 attempts=$8 interval_ms=$9 request_timeout_ms=${'$'}{10}
valid_uuid() { case "$1" in ????????-????-????-????-????????????) ;; *) return 1 ;; esac; case "$1" in *[!0-9a-fA-F-]*) return 1 ;; esac; }
valid_release() {
  id=$1 sha=$2 dir="$releases/$1"
  valid_uuid "$id" && test -d "$dir" && test ! -L "$dir" &&
    test "$(cat "$dir/.releasedeck-release/project-id")" = "$project_id" &&
    test "$(cat "$dir/.releasedeck-release/deployment-id")" = "$id" &&
    test "$(cat "$dir/.releasedeck-release/commit-sha")" = "$sha" &&
    test -s "$dir/.releasedeck-release/archive-sha256" &&
    test "$(readlink "$dir/.env")" = "$base/shared/.env"
}
case "$health_url" in http://127.0.0.1:[1-9]*/*) ;; *) exit 64 ;; esac
case "$health_url" in *\?*|*\#*|*@*|*[!A-Za-z0-9:/._~-]*) exit 64 ;; esac
health_port=${'$'}{health_url#http://127.0.0.1:}; health_port=${'$'}{health_port%%/*}
case "$health_port" in ''|*[!0-9]*) exit 64 ;; esac
test "$health_port" -ge 1 && test "$health_port" -le 65535 || exit 64
valid_uuid "$project_id" && valid_uuid "$deployment_id" && valid_uuid "$attempt_id" || exit 64
case "$commit_sha" in ????????????????????????????????????????) ;; *) exit 64 ;; esac
case "$commit_sha" in *[!0-9a-fA-F]*) exit 64 ;; esac
case "$root" in /*) ;; *) exit 64 ;; esac
case "$root" in /|*//*|*/../*|*/..|*/./*|*/.|*[!A-Za-z0-9._/-]*) exit 64 ;; esac
case "$keep" in 2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20) ;; *) exit 64 ;; esac
case "$attempts" in 1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20) ;; *) exit 64 ;; esac
case "$interval_ms:$request_timeout_ms" in *[!0-9:]*) exit 64 ;; esac
test "$interval_ms" -ge 100 && test "$interval_ms" -le 10000 && test "$request_timeout_ms" -ge 100 && test "$request_timeout_ms" -le 10000 || exit 64
base="$root/$project_id"; releases="$base/releases"; target="$releases/$deployment_id"
test -d "$base" && test ! -L "$base" && test -f "$base/shared/.env" || exit 65
exec 9>"$base/.release.lock"; flock -w 300 9 || exit 75
valid_release "$deployment_id" "$commit_sha" || exit 65
previous_id= previous_sha=
if test -L "$base/current"; then
  current=$(readlink "$base/current")
  case "$current" in releases/????????-????-????-????-????????????) previous_id=${'$'}{current#releases/} ;; *) exit 66 ;; esac
  if test -f "$base/known-good"; then
    test ! -L "$base/known-good" || exit 66
    previous_id=$(cat "$base/known-good")
    valid_uuid "$previous_id" || exit 66
    if test "$previous_id" = "$deployment_id"; then
      test -f "$base/previous-known-good" && test ! -L "$base/previous-known-good" || exit 66
      previous_id=$(cat "$base/previous-known-good")
      valid_uuid "$previous_id" || exit 66
    fi
    previous_sha=$(cat "$releases/$previous_id/.releasedeck-release/commit-sha")
    valid_release "$previous_id" "$previous_sha" || exit 66
  else
    # A Phase 5 current pointer has no application-health proof. It cannot be
    # used as a known-good rollback target until it passes this health gate.
    previous_id=
  fi
else
  test ! -e "$base/known-good" || exit 66
fi
next="$base/.current-$attempt_id"; rm -f -- "$next"; ln -s "releases/$deployment_id" "$next"; mv -Tf -- "$next" "$base/current"
activate() {
  id=$1 dir="$releases/$1" name="releasedeck-$project_id"
  ln -sfn "$base/shared/.env" "$dir/.env"
  pm2 startOrReload "$dir/ecosystem.config.cjs" --only "$name" --update-env || return 1
  pid=$(pm2 pid "$name") || return 1
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  test "$pid" -gt 0 || return 1
  sudo -n nginx -t && sudo -n nginx -s reload || return 1
  return 0
}
healthy() {
  i=1; HEALTH_ATTEMPTS=0; HEALTH_STATUS=0
  while test "$i" -le "$attempts"; do
    HEALTH_ATTEMPTS=$i
    status=$(curl --noproxy '*' --silent --show-error --max-time "$(awk -v ms="$request_timeout_ms" 'BEGIN { printf "%.3f", ms / 1000 }')" --output /dev/null --write-out '%{http_code}' "$health_url" 2>/dev/null) || status=0
    case "$status" in ??????*) status=0 ;; *[!0-9]*) status=0 ;; esac
    if test "$status" -ge 200 && test "$status" -lt 300; then HEALTH_STATUS=$status; return 0; fi
    test "$i" -lt "$attempts" && sleep "$(awk -v ms="$interval_ms" 'BEGIN { printf "%.3f", ms / 1000 }')"
    i=$((i + 1))
  done
  return 1
}
prune() {
  keep_active=$(readlink "$base/current" | sed 's#^releases/##')
  protected=" $keep_active $(cat "$base/known-good" 2>/dev/null || true) $(cat "$base/previous-known-good" 2>/dev/null || true) "
  extra=0; max_extra=$((keep - 3))
  find "$releases" -mindepth 1 -maxdepth 1 -type d -name '????????-????-????-????-????????????' -printf '%T@ %f\n' | sort -rn | awk -v keep="$keep" '{print $2}' | while IFS= read -r old; do
    valid_uuid "$old" || continue
    case "$protected" in *" $old "*) continue ;; esac
    old_sha=$(cat "$releases/$old/.releasedeck-release/commit-sha" 2>/dev/null) || continue
    valid_release "$old" "$old_sha" || continue
    extra=$((extra + 1))
    test "$extra" -le "$max_extra" || rm -rf -- "$releases/$old" || exit 1
  done
}
name="releasedeck-$project_id"
failure_code=activation_failed
if activate "$deployment_id" && test "$(readlink "$base/current")" = "releases/$deployment_id"; then
  if healthy; then
    if test -n "$previous_id"; then printf '%s\n' "$previous_id" > "$base/previous-known-good.tmp-$attempt_id" && mv -f -- "$base/previous-known-good.tmp-$attempt_id" "$base/previous-known-good" || exit 74; else rm -f -- "$base/previous-known-good" || exit 74; fi
    printf '%s\n' "$deployment_id" > "$base/known-good.tmp-$attempt_id" && mv -f -- "$base/known-good.tmp-$attempt_id" "$base/known-good" || exit 74
    prune || exit 74
    valid_release "$deployment_id" "$commit_sha" && test "$(readlink -f "$base/current")" = "$target" && test "$(cat "$base/known-good")" = "$deployment_id" || exit 74
    printf 'PROMOTION_PROMOTED project=%s deployment=%s sha=%s path=%s active=%s pm2=%s pid=%s nginxValidated=1 nginxReloaded=1 healthStatus=%s healthAttempts=%s\n' "$project_id" "$deployment_id" "$commit_sha" "$target" "$target" "$name" "$pid" "$HEALTH_STATUS" "$HEALTH_ATTEMPTS"
    exit 0
  fi
  failure_code=candidate_unhealthy
fi
if test -n "$previous_id" && valid_release "$previous_id" "$previous_sha"; then
  restore="$base/.restore-$attempt_id"; rm -f -- "$restore" && ln -s "releases/$previous_id" "$restore" && mv -Tf -- "$restore" "$base/current" || exit 74
  if activate "$previous_id" && healthy && test "$(readlink "$base/current")" = "releases/$previous_id"; then
    printf '%s\n' "$previous_id" > "$base/known-good.tmp-$attempt_id" && mv -f -- "$base/known-good.tmp-$attempt_id" "$base/known-good" || exit 74
    prune || exit 74
    valid_release "$previous_id" "$previous_sha" && test "$(readlink -f "$base/current")" = "$releases/$previous_id" && test "$(cat "$base/known-good")" = "$previous_id" || exit 74
    printf 'PROMOTION_ROLLED_BACK project=%s deployment=%s sha=%s path=%s active=%s pm2=%s pid=%s nginxValidated=1 nginxReloaded=1 candidate=%s candidateSha=%s healthStatus=%s healthAttempts=%s\n' "$project_id" "$previous_id" "$previous_sha" "$releases/$previous_id" "$releases/$previous_id" "$name" "$pid" "$deployment_id" "$commit_sha" "$HEALTH_STATUS" "$HEALTH_ATTEMPTS"
    exit 0
  fi
  failure_code=restore_unhealthy
fi
restore_id=${'$'}{previous_id:-$deployment_id}; restore_sha=${'$'}{previous_sha:-$commit_sha}
if test -z "$previous_id"; then
  printf 'PROMOTION_NO_KNOWN_GOOD project=%s deployment=%s sha=%s candidate=%s candidateSha=%s failureCode=no_known_good\n' "$project_id" "$deployment_id" "$commit_sha" "$deployment_id" "$commit_sha"
  exit 0
fi
printf 'PROMOTION_ROLLBACK_FAILED project=%s deployment=%s sha=%s candidate=%s candidateSha=%s failureCode=%s\n' "$project_id" "$restore_id" "$restore_sha" "$deployment_id" "$commit_sha" "$failure_code"
exit 0
`;

export const MANUAL_ROLLBACK_REMOTE_SCRIPT = String.raw`set -u
project_id=$1 active_id=$2 active_sha=$3 restore_id=$4 restore_sha=$5 root=$6 keep=$7 attempt_id=$8 health_url=$9 attempts=${'$'}{10} interval_ms=${'$'}{11} request_timeout_ms=${'$'}{12} request_id=${'$'}{13}
valid_uuid() { case "$1" in ????????-????-????-????-????????????) ;; *) return 1 ;; esac; case "$1" in *[!0-9a-fA-F-]*) return 1 ;; esac; }
valid_uuid "$project_id" && valid_uuid "$active_id" && valid_uuid "$restore_id" && valid_uuid "$attempt_id" && valid_uuid "$request_id" || exit 64
test "$restore_id" != "$active_id" || exit 64
case "$health_url" in http://127.0.0.1:[1-9]*/*) ;; *) exit 64 ;; esac
case "$health_url" in *\?*|*\#*|*@*|*[!A-Za-z0-9:/._~-]*) exit 64 ;; esac
health_port=${'$'}{health_url#http://127.0.0.1:}; health_port=${'$'}{health_port%%/*}
case "$health_port" in ''|*[!0-9]*) exit 64 ;; esac
test "$health_port" -ge 1 && test "$health_port" -le 65535 || exit 64
case "$active_sha" in ????????????????????????????????????????) ;; *) exit 64 ;; esac
case "$active_sha" in *[!0-9a-fA-F]*) exit 64 ;; esac
case "$restore_sha" in ????????????????????????????????????????) ;; *) exit 64 ;; esac
case "$restore_sha" in *[!0-9a-fA-F]*) exit 64 ;; esac
case "$keep" in 2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20) ;; *) exit 64 ;; esac
case "$attempts" in 1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20) ;; *) exit 64 ;; esac
case "$interval_ms:$request_timeout_ms" in *[!0-9:]*) exit 64 ;; esac
test "$interval_ms" -ge 100 && test "$interval_ms" -le 10000 && test "$request_timeout_ms" -ge 100 && test "$request_timeout_ms" -le 10000 || exit 64
case "$root" in /*) ;; *) exit 64 ;; esac
case "$root" in /|*//*|*/../*|*/..|*/./*|*/.|*[!A-Za-z0-9._/-]*) exit 64 ;; esac
base="$root/$project_id"; releases="$base/releases"; active="$releases/$active_id"
test -d "$base" && test ! -L "$base" || exit 65
exec 9>"$base/.release.lock"; flock -w 300 9 || exit 75
marker="$base/.manual-rollback-request"
signature="$request_id $active_id $active_sha $restore_id $restore_sha"
matching_request() { test -f "$marker" && test ! -L "$marker" && test "$(cat "$marker")" = "$signature"; }
reject_precondition() { if matching_request; then exit 74; fi; exit 66; }
test -f "$base/known-good" && test ! -L "$base/known-good" && test -f "$base/previous-known-good" && test ! -L "$base/previous-known-good" || reject_precondition
test -d "$active" && test ! -L "$active" && test "$(cat "$active/.releasedeck-release/project-id")" = "$project_id" && test "$(cat "$active/.releasedeck-release/deployment-id")" = "$active_id" && test "$(cat "$active/.releasedeck-release/commit-sha")" = "$active_sha" && test -s "$active/.releasedeck-release/archive-sha256" && test "$(readlink "$active/.env")" = "$base/shared/.env" || reject_precondition
valid_uuid "$restore_id" || reject_precondition
restore="$releases/$restore_id"
test -d "$restore" && test ! -L "$restore" && test "$(cat "$restore/.releasedeck-release/project-id")" = "$project_id" && test "$(cat "$restore/.releasedeck-release/deployment-id")" = "$restore_id" && test -s "$restore/.releasedeck-release/archive-sha256" || reject_precondition
test "$(cat "$restore/.releasedeck-release/commit-sha")" = "$restore_sha" || reject_precondition
test "$(readlink "$restore/.env")" = "$base/shared/.env" || reject_precondition
current=$(readlink "$base/current") || reject_precondition
known_good=$(cat "$base/known-good") || reject_precondition
predecessor=$(cat "$base/previous-known-good") || reject_precondition
if test "$current" = "releases/$active_id" && test "$known_good" = "$active_id" && test "$predecessor" = "$restore_id"; then
  printf '%s\n' "$signature" > "$marker.tmp-$attempt_id" && mv -f -- "$marker.tmp-$attempt_id" "$marker" || exit 74
elif test "$current" = "releases/$restore_id" && matching_request; then
  case "$known_good:$predecessor" in
    "$active_id:$restore_id"|"$restore_id:$restore_id"|"$restore_id:$active_id") ;;
    *) exit 74 ;;
  esac
else
  if test "$current" = "releases/$restore_id"; then exit 74; fi
  if matching_request; then exit 74; fi
  exit 66
fi
if test "$current" != "releases/$restore_id"; then
  next="$base/.rollback-$attempt_id"; rm -f -- "$next" && ln -s "releases/$restore_id" "$next" && mv -Tf -- "$next" "$base/current" || exit 74
fi
name="releasedeck-$project_id"
if pm2 startOrReload "$restore/ecosystem.config.cjs" --only "$name" --update-env && sudo -n nginx -t && sudo -n nginx -s reload; then
  pid=$(pm2 pid "$name") || pid=
  i=1; ok=0; status=0
  while test "$i" -le "$attempts"; do status=$(curl --noproxy '*' --silent --show-error --max-time "$(awk -v ms="$request_timeout_ms" 'BEGIN { printf "%.3f", ms / 1000 }')" --output /dev/null --write-out '%{http_code}' "$health_url" 2>/dev/null) || status=0; case "$status" in ??????*) status=0 ;; *[!0-9]*) status=0 ;; esac; if test "$status" -ge 200 && test "$status" -lt 300; then ok=1; break; fi; test "$i" -lt "$attempts" && sleep "$(awk -v ms="$interval_ms" 'BEGIN { printf "%.3f", ms / 1000 }')"; i=$((i + 1)); done
  if test "$ok" = 1 && test "$(readlink "$base/current")" = "releases/$restore_id" && test "$pid" -gt 0; then
    printf '%s\n' "$active_id" > "$base/previous-known-good.tmp-$attempt_id" && mv -f -- "$base/previous-known-good.tmp-$attempt_id" "$base/previous-known-good" || exit 74
    printf '%s\n' "$restore_id" > "$base/known-good.tmp-$attempt_id" && mv -f -- "$base/known-good.tmp-$attempt_id" "$base/known-good" || exit 74
    protected=" $restore_id $active_id "; extra=0; max_extra=$((keep - 3))
    find "$releases" -mindepth 1 -maxdepth 1 -type d -name '????????-????-????-????-????????????' -printf '%T@ %f\n' | sort -rn | awk -v keep="$keep" '{print $2}' | while IFS= read -r old; do
      valid_uuid "$old" || continue
      case "$protected" in *" $old "*) continue ;; esac
      old_dir="$releases/$old"
      test -d "$old_dir" && test ! -L "$old_dir" && test "$(cat "$old_dir/.releasedeck-release/project-id" 2>/dev/null)" = "$project_id" && test "$(cat "$old_dir/.releasedeck-release/deployment-id" 2>/dev/null)" = "$old" && test -s "$old_dir/.releasedeck-release/archive-sha256" && test "$(readlink "$old_dir/.env")" = "$base/shared/.env" || continue
      old_sha=$(cat "$old_dir/.releasedeck-release/commit-sha" 2>/dev/null) || continue
      case "$old_sha" in ????????????????????????????????????????) ;; *) continue ;; esac
      case "$old_sha" in *[!0-9a-fA-F]*) continue ;; esac
      extra=$((extra + 1))
      test "$extra" -le "$max_extra" || rm -rf -- "$old_dir" || exit 1
    done || exit 74
    test "$(readlink -f "$base/current")" = "$restore" && test "$(cat "$base/known-good")" = "$restore_id" && test "$(cat "$base/previous-known-good")" = "$active_id" || exit 74
    printf 'MANUAL_ROLLBACK_RESTORED project=%s deployment=%s sha=%s path=%s active=%s pm2=%s pid=%s nginxValidated=1 nginxReloaded=1 healthStatus=%s healthAttempts=%s\n' "$project_id" "$restore_id" "$restore_sha" "$restore" "$restore" "$name" "$pid" "$status" "$i"
    exit 0
  fi
fi
restore_next="$base/.restore-active-$attempt_id"; rm -f -- "$restore_next" && ln -s "releases/$active_id" "$restore_next" && mv -Tf -- "$restore_next" "$base/current" || exit 74
active_dir="$releases/$active_id"
if pm2 startOrReload "$active_dir/ecosystem.config.cjs" --only "$name" --update-env && sudo -n nginx -t && sudo -n nginx -s reload; then
  active_pid=$(pm2 pid "$name") || active_pid=
  i=1; active_status=0; active_attempts=0; active_ok=0
  while test "$i" -le "$attempts"; do active_attempts=$i; active_status=$(curl --noproxy '*' --silent --show-error --max-time "$(awk -v ms="$request_timeout_ms" 'BEGIN { printf "%.3f", ms / 1000 }')" --output /dev/null --write-out '%{http_code}' "$health_url" 2>/dev/null) || active_status=0; case "$active_status" in ??????*) active_status=0 ;; *[!0-9]*) active_status=0 ;; esac; if test "$active_status" -ge 200 && test "$active_status" -lt 300; then active_ok=1; break; fi; test "$i" -lt "$attempts" && sleep "$(awk -v ms="$interval_ms" 'BEGIN { printf "%.3f", ms / 1000 }')"; i=$((i + 1)); done
  if test "$active_ok" = 1 && test "$active_pid" -gt 0 && test "$(readlink "$base/current")" = "releases/$active_id"; then
    printf '%s\n' "$restore_id" > "$base/previous-known-good.tmp-$attempt_id" && mv -f -- "$base/previous-known-good.tmp-$attempt_id" "$base/previous-known-good" || exit 74
    printf '%s\n' "$active_id" > "$base/known-good.tmp-$attempt_id" && mv -f -- "$base/known-good.tmp-$attempt_id" "$base/known-good" || exit 74
    test "$(readlink -f "$base/current")" = "$active_dir" && test "$(cat "$base/known-good")" = "$active_id" && test "$(cat "$base/previous-known-good")" = "$restore_id" || exit 74
    printf 'MANUAL_ROLLBACK_ACTIVE_RESTORED project=%s deployment=%s sha=%s path=%s active=%s pm2=%s pid=%s nginxValidated=1 nginxReloaded=1 attempted=%s attemptedSha=%s healthStatus=%s healthAttempts=%s\n' "$project_id" "$active_id" "$active_sha" "$active_dir" "$active_dir" "$name" "$active_pid" "$restore_id" "$restore_sha" "$active_status" "$active_attempts"
    exit 0
  fi
fi
printf 'MANUAL_ROLLBACK_FAILED project=%s deployment=%s sha=%s attempted=%s attemptedSha=%s failureCode=active_restore_failed\n' "$project_id" "$active_id" "$active_sha" "$restore_id" "$restore_sha"
exit 0
`;
