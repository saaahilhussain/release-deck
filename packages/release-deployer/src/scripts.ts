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
