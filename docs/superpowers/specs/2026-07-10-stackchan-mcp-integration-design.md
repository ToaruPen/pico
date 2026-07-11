# StackChan MCP Integration Design

## 目的

M5Stack StackChan を Pi Agent / Codex / Claude Code などの MCP client から
扱える device provider として接続する。最初の対象は施設ドメイン判断ではなく、
StackChan の身体機能を安全に外部 agent へ見せるための接続実証である。

## 現時点の判断

最初の実装経路は `stackchan-mcp` gateway を使う。

理由は以下である。

- `stackchan-mcp` は StackChan の head movement、camera capture、touch、
  avatar、LED、TTS/STT を MCP tool として公開する。
- M5Stack factory firmware の内部 MCP は Xiaozhi transport 上の tool であり、
  pico からそのまま LAN-local MCP server として扱える形ではない。
- 公式 server/WebSocket 経路は独自 binary framing と認証を持ち、最初の spike
  としては調査面が大きい。
- `pico` は StackChan の servo/avatar/camera 制御を再実装しない。必要になれば
  StackChan MCP tools を呼ぶ薄い domain wrapper を追加する。

## 接続形

実機検証後の接続形は以下とする。

```text
StackChan firmware
  -> wss://<stackchan-gateway-host>/
  -> https://<stackchan-gateway-host>/capture

Cloudflare named Tunnel: <stackchan-tunnel-name>
  -> WebSocket requests -> http://127.0.0.1:18765
  -> /capture requests  -> http://127.0.0.1:18766

stackchan-mcp gateway
  -> http://127.0.0.1:18767/mcp

Pi Agent / Codex / Claude Code
  -> Streamable HTTP MCP client
```

初回検証時は標準 port `8765` が pico の MLX Whisper sidecar と衝突していたため
使わなかった。STT の Apple Speech 移行後も、実機検証済みの `18765` から不要に
変更せず、StackChan と STT の process boundary を独立させる。

## Local Gateway Settings

最初の検証では以下を使う。

```bash
STACKCHAN_TOKEN=<strong-shared-token>
HOST=0.0.0.0
WS_PORT=18765
CAPTURE_PORT=18766
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=18767
VISION_HOST=<gateway-host-lan-ip>
stackchan-mcp serve --transport streamable-http
```

`STACKCHAN_TOKEN` は gateway と StackChan firmware の `websocket.token` で共有する。
実運用設定では `VISION_URL=https://<stackchan-gateway-host>/capture` を使う。

## Cloudflare / Remote Access

local spike 後、`<gateway-dns-zone>` に専用 named Tunnel を作成した。

```text
StackChan
  -> wss://<stackchan-gateway-host>/
       Cloudflare Tunnel -> localhost:18765

StackChan capture upload
  -> https://<stackchan-gateway-host>/capture
       Cloudflare Tunnel -> localhost:18766
```

MCP HTTP endpoint は公開せず、`127.0.0.1:18767` のまま Pi Agent とローカル
coding agent だけから使う。StackChan device の WebSocket/capture 経路は
`STACKCHAN_TOKEN` による gateway 認証を使う。

## Factory Firmware Boundary

移行前の実機は M5Stack factory firmware 1.4.3 で動いていた。移行前に16MB
full-flash backup を保存し、現在は `firmware-v1.14.0` を clean install 済みである。

`stackchan-mcp` firmware は factory firmware を置き換える前提である。flash する
前に、以下を明示確認する。

- factory firmware / StackChan World / XiaoZhi flow から離れてよいか。
- clean install で NVS と Wi-Fi 設定を消してよいか、app-only update にするか。
- rollback 用に M5Burner などで factory firmware へ戻す手順を確保するか。

## First Spike Acceptance

Issue #90 の最初の spike は以下を満たせば完了とする。

- `stackchan-mcp` gateway の preflight が non-conflicting port で成功する。
- 最新 gateway / firmware release と flash asset が確認されている。
- firmware flash の前に destructive boundary が明示されている。
- `get_status` または同等の harmless tool を MCP client から呼ぶ実機手順がある。
- robot-control endpoint は unauthenticated public にしない。

## 次の実装単位

以下は実機確認済みである。

1. 実際の Pi Agent runtime からローカル MCP endpoint を利用できる。
2. Pi Agent は `get_status`, `move_head`, `set_avatar`, `get_head_angles` を意図どおり
   選択して実行できる。
3. resident runtime は同一 Pi Agent SDK session を複数 turn で再利用し、会話状態と
   StackChan tool 接続を維持できる。

初期実装では `.pi/mcp.json` の selected direct tools を使い、pico 固有の domain
wrapper は追加しない。施設ドメイン固有の一連動作、追加の認可境界、または MCP tool
schema から独立した契約が必要になった時点で wrapper を再検討する。
