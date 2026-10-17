#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
if [[ "${CI:-}" != true || "$(uname -s)" != Linux ]]; then
  echo 'Package lifecycle tests run only on an isolated Linux CI runner.' >&2
  exit 1
fi

shopt -s nullglob
debs=(apps/desktop/src-tauri/target/release/bundle/deb/*.deb)
images=(apps/desktop/src-tauri/target/release/bundle/appimage/*.AppImage)
if (( ${#debs[@]} != 1 || ${#images[@]} != 1 )); then
  echo 'Expected exactly one DEB and one AppImage.' >&2
  exit 1
fi
deb="$(realpath "${debs[0]}")"
image="$(realpath "${images[0]}")"
package="$(dpkg-deb --field "$deb" Package)"
version="$(dpkg-deb --field "$deb" Version)"
test "$package" = zichan
test "$(dpkg-deb --field "$deb" Architecture)" = amd64

temporary="$(mktemp -d)"
export XDG_DATA_HOME="$temporary/user/data"
export XDG_CONFIG_HOME="$temporary/user/config"
export XDG_CACHE_HOME="$temporary/user/cache"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
cleanup() {
  sudo apt-get remove -y "$package" >/dev/null 2>&1 || true
  rm -rf -- "$temporary"
}
trap cleanup EXIT

if [[ -n "${ZICHAN_PREVIOUS_DEB:-}" ]]; then
  previous="$(realpath "$ZICHAN_PREVIOUS_DEB")"
  test "$(dpkg-deb --field "$previous" Package)" = "$package"
  previous_version="$(dpkg-deb --field "$previous" Version)"
else
  # Exercise dpkg's real upgrade path on first release, when no prior package exists.
  # This cannot substitute for a migration test against a historical application build.
  previous_version=0.0.0
  dpkg-deb --raw-extract "$deb" "$temporary/previous-tree"
  sed -i -E "s/^Version: .*/Version: $previous_version/" "$temporary/previous-tree/DEBIAN/control"
  previous="$temporary/previous.deb"
  dpkg-deb --build "$temporary/previous-tree" "$previous" >/dev/null
fi
if ! dpkg --compare-versions "$previous_version" lt "$version"; then
  echo "Previous package $previous_version must be older than $version." >&2
  exit 1
fi

launch() {
  local label="$1"
  local executable="$2"
  local log="$temporary/$label.log"
  local status=0
  timeout -s TERM -k 3s 45s dbus-run-session -- xvfb-run -a \
    env GDK_BACKEND=x11 WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    APPIMAGE_EXTRACT_AND_RUN=1 bash -c '
      "$1" &
      app_pid=$!
      trap '\''kill "$app_pid" 2>/dev/null || true; wait "$app_pid" 2>/dev/null || true'\'' EXIT
      for attempt in $(seq 1 40); do
        if xdotool search --onlyvisible --name "Lifecycle Ledger" >/dev/null 2>&1; then
          exit 0
        fi
        if ! kill -0 "$app_pid" 2>/dev/null; then
          echo "App exited before opening a window" >&2
          exit 1
        fi
        sleep 1
      done
      echo "GUI window did not appear" >&2
      exit 1
    ' launch "$executable" >"$log" 2>&1 || status=$?
  if [[ "$status" != 0 ]]; then
    echo "$label did not open its desktop window (status $status)." >&2
    cat "$log" >&2
    exit 1
  fi
}

sudo apt-get install -y "$previous" >/dev/null
launch previous /usr/bin/zichan
data_root="$(find "$XDG_DATA_HOME" -type d -name com.zichan.ledger -print -quit)"
if [[ -z "$data_root" ]]; then
  echo 'Installed app did not create its user data directory.' >&2
  exit 1
fi
printf 'preserve user data\n' > "$data_root/ci-upgrade-sentinel.txt"

sudo apt-get install -y "$deb" >/dev/null
test "$(dpkg-query -W -f='${Version}' "$package")" = "$version"
launch upgraded /usr/bin/zichan
test "$(cat "$data_root/ci-upgrade-sentinel.txt")" = 'preserve user data'

sudo apt-get remove -y "$package" >/dev/null
test ! -e /usr/bin/zichan
test "$(cat "$data_root/ci-upgrade-sentinel.txt")" = 'preserve user data'
launch appimage "$image"
test "$(cat "$data_root/ci-upgrade-sentinel.txt")" = 'preserve user data'
echo "DEB install/upgrade/uninstall and AppImage launch preserved $data_root"
