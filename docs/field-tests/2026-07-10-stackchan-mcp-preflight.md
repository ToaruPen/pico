# StackChan MCP Preflight

## Summary

Issue: https://github.com/ToaruPen/pico/issues/90

Result: local gateway preflight passed. Factory firmware was backed up, then
`stackchan-mcp` firmware was clean-installed and the local gateway was started.

## Local State

- Repo branch: `codex/issue-90-stackchan-mcp`
- Worktree before documentation: clean
- StackChan USB device:
  - serial device: `<usb-serial-device>`
  - tty device: `<usb-tty-device>`
  - USB vendor: Espressif
  - USB product: USB JTAG/serial debug unit
  - USB serial: `<redacted-device-id>`
- Existing local port conflict:
  - `127.0.0.1:8765` is held by pico's `mlx_whisper_sidecar.py`
- Gateway host LAN IP:
  - `<gateway-host-lan-ip>`
- Tailscale DNS name:
  - `<gateway-host-tailnet-name>`
- Local tunnel tools:
  - `tailscale` is installed
  - `cloudflared 2026.7.1` is installed

## stackchan-mcp Release State

- Latest gateway release checked with GitHub CLI:
  - `v0.15.0`, published 2026-07-09
- Latest firmware release checked with GitHub CLI:
  - `firmware-v1.14.0`, published 2026-07-09
- Firmware assets:
  - `merged-binary.bin`
    - clean install at `0x0`
    - resets NVS / Wi-Fi settings
    - sha256 `c9d413623a2bd83175b508f0ba7ace5455afeecec6968b57bcff62c0e5aeeb19`
  - `xiaozhi.bin`
    - app-only update at `0x20000`
    - preserves NVS / Wi-Fi settings
    - sha256 `20d03db05e26e768d8ab85b108c63c73f0dd17aedaeb6031270048d928faa73d`
  - `v2.2.6_stackchan.zip`
    - full build output
    - sha256 `75d12072b9f40b1fe4c24e89c3c4d17d96ae980dd0b2e462fe9ddc7bb89f95f3`

## Preflight Command

The gateway was first checked through `uvx` without installing the command
permanently:

```bash
HOST=0.0.0.0 \
WS_PORT=18765 \
CAPTURE_PORT=18766 \
MCP_HTTP_PORT=18767 \
MCP_HTTP_HOST=127.0.0.1 \
uvx --from stackchan-mcp stackchan-mcp --preflight
```

## Preflight Output

```text
stackchan-mcp 0.15.0 preflight

Configuration:
  STACKCHAN_TOKEN     not set (gateway will accept any client)
  MCP_HTTP_ALLOWED_HOSTS not set
  VISION_HOST         not set
  VISION_URL          not set (set VISION_HOST or VISION_URL for take_photo)
  VISION_TOKEN        not set (will reuse STACKCHAN_TOKEN)
  STACKCHAN_AUDIO_HOOK_URL  not set (device-driven listen capture disabled)

Ports:
  ws://0.0.0.0:18765   AVAILABLE
  http://0.0.0.0:18766 AVAILABLE
  http://127.0.0.1:18767/mcp AVAILABLE

Result: ready. Exit 0.
```

The gateway was then checked with the intended LAN capture host and a dummy
preflight token:

```bash
HOST=0.0.0.0 \
WS_PORT=18765 \
CAPTURE_PORT=18766 \
MCP_HTTP_PORT=18767 \
MCP_HTTP_HOST=127.0.0.1 \
VISION_HOST=<gateway-host-lan-ip> \
STACKCHAN_TOKEN=dummy-preflight-token \
uvx --from stackchan-mcp stackchan-mcp --preflight
```

```text
stackchan-mcp 0.15.0 preflight

Configuration:
  STACKCHAN_TOKEN     set (***redacted***)
  MCP_HTTP_ALLOWED_HOSTS not set
  VISION_HOST         <gateway-host-lan-ip>
  VISION_URL          (derived) http://<gateway-host-lan-ip>:18766/capture
  VISION_TOKEN        not set (will reuse STACKCHAN_TOKEN)
  STACKCHAN_AUDIO_HOOK_URL  not set (device-driven listen capture disabled)

Ports:
  ws://0.0.0.0:18765   AVAILABLE
  http://0.0.0.0:18766 AVAILABLE
  http://127.0.0.1:18767/mcp AVAILABLE

Result: ready. Exit 0.
```

## Downloaded Firmware Assets

Firmware assets were downloaded to `/tmp/stackchan-firmware-v1.14.0`.

```text
c9d413623a2bd83175b508f0ba7ace5455afeecec6968b57bcff62c0e5aeeb19  merged-binary.bin
20d03db05e26e768d8ab85b108c63c73f0dd17aedaeb6031270048d928faa73d  xiaozhi.bin
75d12072b9f40b1fe4c24e89c3c4d17d96ae980dd0b2e462fe9ddc7bb89f95f3  v2.2.6_stackchan.zip
```

## Factory Firmware Backup

A full 16MB factory flash backup was saved before clean install:

- backup directory:
  `~/.pico/stackchan-backups/<timestamped-device-backup>`
- backup file:
  `factory-full-flash-16mb.bin`
- backup size:
  `16777216` bytes
- sha256:
  `ebac3fd1cbfff021b2b8608b7ccbde0daa013f8d12a6d2b23e583c18aaee0540`
- restore command from inside the backup directory:

```bash
uvx esptool --chip esp32s3 --port <usb-serial-device> -b 460800 write_flash 0x0 factory-full-flash-16mb.bin
```

## Clean Install

The clean install used the `firmware-v1.14.0` merged binary:

```bash
uvx esptool --chip esp32s3 --port <usb-serial-device> -b 460800 write_flash 0x0 /tmp/stackchan-firmware-v1.14.0/merged-binary.bin
```

Flash write result:

```text
Wrote 9981052 bytes (2737406 compressed) at 0x00000000.
Hash of data verified.
```

Post-flash USB check:

```text
Chip type: ESP32-S3 (QFN56) (revision v0.2)
MAC: <redacted-device-id>
```

## Local Gateway Runtime

`stackchan-mcp==0.15.0` was installed as a uv tool so it can run under launchd:

```bash
uv tool install 'stackchan-mcp==0.15.0'
```

Local private settings are stored outside the repo:

- env file:
  `~/.pico/stackchan-mcp/local-gateway.env`
- recovered device Wi-Fi env:
  `~/.pico/stackchan-mcp/device-wifi.env`
- non-secret local memo:
  `~/.pico/stackchan-mcp/README.txt`
- file permissions:
  `0600`

The private env files contain the real `STACKCHAN_TOKEN` and recovered Wi-Fi
credentials. Do not copy their contents into the repo or issue comments.

Gateway values to use when provisioning the device:

- primary WebSocket URL:
  `wss://<stackchan-gateway-host>/`
- fallback WebSocket URL:
  empty
- public capture URL:
  `https://<stackchan-gateway-host>/capture`
- local MCP HTTP endpoint:
  `http://127.0.0.1:18767/mcp`

The gateway is managed by a user LaunchAgent:

- plist:
  `~/Library/LaunchAgents/dev.pico.stackchan-mcp.gateway.plist`
- label:
  `dev.pico.stackchan-mcp.gateway`
- mode:
  `streamable-http`
- mDNS:
  disabled, because an explicit fixed Cloudflare gateway URL is used

One additional user LaunchAgent keeps the named Cloudflare Tunnel running:

- tunnel name:
  `<redacted-tunnel-name>`
- tunnel ID:
  `<redacted-tunnel-id>`
- DNS hostname:
  `<stackchan-gateway-host>`
- launchd label:
  `dev.pico.stackchan-mcp.cloudflare-named`
- config:
  `~/.pico/stackchan-mcp/cloudflared-named.yml`

The named tunnel routes `/capture` to local port `18766` and all other requests,
including WebSocket upgrades, to local port `18765`. The two earlier
`trycloudflare.com` quick tunnels were stopped and their LaunchAgent plists were
moved under `~/.pico/stackchan-mcp/retired-launchagents`.

Runtime verification after launchd start:

```text
127.0.0.1:18767 LISTEN
0.0.0.0:18765 LISTEN
0.0.0.0:18766 LISTEN
owner_id=<runtime-owner> pid=<gateway-pid> mode=streamable-http http_endpoint=127.0.0.1:18767
```

## Provisioning And Device Verification

The factory backup NVS contained the previous 2.4GHz Wi-Fi credentials. They
were recovered locally without printing them and stored in the private
`device-wifi.env` file above.

The direct LAN path initially failed because macOS had overlapping routes for
the gateway LAN subnet on Wi-Fi and an inactive bridge. Replies to the device
IP were selected through the inactive bridge, so the ESP32 saw `EHOSTUNREACH`
when opening the LAN WebSocket endpoint. The Cloudflare WSS path avoids this
host routing conflict.

An additional 16KB post-Wi-Fi NVS backup was saved before re-provisioning:

- file:
  `~/.pico/stackchan-backups/<timestamped-device-backup>/post-wifi-before-cloudflare-nvs-0x9000-0x4000.bin`
- flash region:
  `0x9000` through `0xcfff`

Final MCP status:

```text
connected: true
device_id: <redacted-device-id>
initialized: true
tools_count: 35
```

Read-only smoke checks passed:

- device info: battery 100%, Wi-Fi connected, medium signal
- head angles: yaw 0, pitch 44
- servo power: VM EN high

Actuation smoke checks passed:

- avatar `happy`, then restored to `idle`
- head moved to yaw 10 / pitch 45, then returned to yaw 0 / pitch 44

Camera smoke check passed through the public capture tunnel:

- capture file:
  `~/.stackchan/captures/<capture-id>.jpg`
- size:
  `9805` bytes

Final device gateway configuration:

```text
url: wss://<stackchan-gateway-host>/
fallback_url: empty
connected_url: wss://<stackchan-gateway-host>/
```

## Interpretation

The selected local ports avoided pico's `8765` MLX sidecar conflict at the time
of this run. Apple Speech now uses `8766`; the validated StackChan ports remain
unchanged so the two process boundaries stay independent. The device is now
paired with the local gateway through authenticated Cloudflare
WSS, and MCP status, device reads, servo movement, avatar control, and camera
capture have all been verified.

Clean install replaces the factory firmware and clears the device's previous
NVS-backed settings, including Wi-Fi provisioning.
