#!/usr/bin/env bash
# Windows Chrome, WebMCP on, DevTools port reachable from WSL — for driving
# src/ui/webmcp.js's tools from this side.
#
# Three things have to be true and none of them is the default:
#   · a SEPARATE user-data-dir — Chrome ignores --remote-debugging-port on the
#     default profile (a 136-era security change), so the everyday browser can't
#     be driven at all. chrome://flags lives in the profile, hence the pre-written
#     Local State: a fresh dir would otherwise have WebMCP off.
#   · a relay — Chrome binds DevTools to 127.0.0.1 and ignores
#     --remote-debugging-address, and WSL2's NAT means Windows' loopback is not
#     ours. node.exe on the Windows side forwards 0.0.0.0:9223 → 127.0.0.1:9222.
#   · the browser-url uses the gateway IP, not localhost, and it changes per boot.
#
# ponytail: no cleanup, no pid file. Close the window; run it again.
set -euo pipefail
# /etc/wsl.conf here sets appendWindowsPath=false, so cmd.exe isn't on PATH to ask.
# A real profile, not the "Default"/"Public"/"Default User" shells Windows keeps.
WIN_USER="${WIN_USER:-$(ls -d /mnt/c/Users/*/AppData/Local/Google 2>/dev/null | head -1 | cut -d/ -f5)}"
PROFILE="C:\\Users\\${WIN_USER}\\webmcp-profile"
UNIX_PROFILE="/mnt/c/Users/${WIN_USER}/webmcp-profile"
NODE_EXE="${NODE_EXE:-$(command -v node.exe || echo /mnt/c/nvm4w/nodejs/node.exe)}"
CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
HOST_IP=$(ip route show default | awk '{print $3}')

mkdir -p "$UNIX_PROFILE"
[ -f "$UNIX_PROFILE/Local State" ] ||
    echo '{"browser":{"enabled_labs_experiments":["enable-webmcp-testing@1"]}}' > "$UNIX_PROFILE/Local State"

cat > "/mnt/c/Users/${WIN_USER}/cdp-relay.js" <<'JS'
const net = require("net");
net.createServer((a) => {
  const b = net.connect(9222, "127.0.0.1");
  a.pipe(b); b.pipe(a);
  const die = () => { a.destroy(); b.destroy(); };
  a.on("error", die); b.on("error", die);
}).listen(9223, "0.0.0.0", () => console.log("relay up"));
JS

curl -sf --max-time 2 "http://127.0.0.1:9222/json/version" >/dev/null 2>&1 || true
"$CHROME" --user-data-dir="$PROFILE" --remote-debugging-port=9222 \
    --no-first-run --no-default-browser-check "${1:-https://tv.fangorn.network/}" >/dev/null 2>&1 &
"$NODE_EXE" "C:\\Users\\${WIN_USER}\\cdp-relay.js" >/dev/null 2>&1 &

for _ in $(seq 30); do curl -sf --max-time 2 "http://${HOST_IP}:9223/json/version" >/dev/null && break; sleep 1; done
curl -s "http://${HOST_IP}:9223/json/version" | grep Browser
echo "browser-url: http://${HOST_IP}:9223"
