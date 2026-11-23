#!/usr/bin/env bash
# Isolated functional test. No host network, existing proxy, or site config is changed.
set -Eeuo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d -t zichan-realip.XXXXXXXX)"
trap 'rm -f -- "$work/default.conf" "$work/cloudflare-realip.conf" "$work/location.conf" "$work/document-rules"; rmdir -- "$work"' EXIT
cp "$root/scripts/production/cloudflare-realip.conf" "$work/cloudflare-realip.conf"
awk '/^```nginx$/ { block=1; next } block && /^```$/ { exit } block { print }' \
  "$root/docs/deployment/cloudflare-1panel-proxy.md" > "$work/location.conf"
grep -E '^[[:space:]]*(set_real_ip_from|real_ip_header|real_ip_recursive) ' "$work/location.conf" \
  | sed 's/^[[:space:]]*//' > "$work/document-rules"
diff -u <(grep -E '^(set_real_ip_from|real_ip_header|real_ip_recursive) ' "$work/cloudflare-realip.conf") "$work/document-rules"
# Expose the original peer only to the isolated fixture's echo server.
sed -i '/proxy_pass /i\    proxy_set_header X-Test-Peer $realip_remote_addr;' "$work/location.conf"
cat > "$work/default.conf" <<'NGINX'
server {
  listen 34567;
  location / { return 200 "$http_x_forwarded_for|$http_x_test_peer"; }
}
server {
  listen 8080;
  listen [::]:8080;
  include /check/location.conf;
}
server {
  listen 8081;
  location /ipv4 {
    proxy_bind 104.22.101.160;
    proxy_set_header CF-Connecting-IP 203.0.113.8;
    proxy_pass http://127.0.0.1:8080;
  }
  location /ipv6 {
    proxy_bind 2400:cb00::1;
    proxy_set_header CF-Connecting-IP 2001:db8::8;
    proxy_pass http://[::1]:8080;
  }
  location /forged {
    proxy_bind 192.0.2.10;
    proxy_set_header CF-Connecting-IP 203.0.113.8;
    proxy_set_header X-Forwarded-For 203.0.113.9;
    proxy_pass http://127.0.0.1:8080;
  }
  location /invalid {
    proxy_bind 104.22.101.160;
    proxy_set_header CF-Connecting-IP invalid-ip;
    proxy_pass http://127.0.0.1:8080;
  }
}
NGINX
image="${NGINX_TEST_IMAGE:-nginx:stable-alpine@sha256:caf4e1e032a20f9c3c5e28fc7f25ffd768ad8677b4975c54193075997b3a97e3}"
docker run --rm --network none --cap-add NET_ADMIN \
  --sysctl net.ipv6.conf.all.disable_ipv6=0 \
  --mount "type=bind,src=$work,dst=/check,readonly" \
  --mount "type=bind,src=$work/default.conf,dst=/etc/nginx/conf.d/default.conf,readonly" \
  --entrypoint /bin/sh "$image" -ec '
    ip link set lo up
    ip addr add 104.22.101.160/32 dev lo
    ip addr add 192.0.2.10/32 dev lo
    ip -6 addr add 2400:cb00::1/128 dev lo
    nginx -t
    nginx
    trap "nginx -s quit" EXIT
    check() {
      actual="$(wget -qO- "http://127.0.0.1:8081/$1")"
      if [ "$actual" != "$2" ]; then echo "$1 failed: $actual" >&2; exit 1; fi
      echo "$1 passed"
    }
    check ipv4 "203.0.113.8|104.22.101.160"
    check ipv6 "2001:db8::8|2400:cb00::1"
    check forged "192.0.2.10|192.0.2.10"
    check invalid "104.22.101.160|104.22.101.160"
  '
