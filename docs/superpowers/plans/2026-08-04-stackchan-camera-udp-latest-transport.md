# StackChan Camera UDP Latest-Only Transport Implementation Plan

> **Historical rejected design — non-executable.** Do not execute the checkboxes below. The SCU1
> draft relied on a routing token, source binding, sequence, and CRC, but lacked cryptographic
> datagram authentication, an on-wire stream epoch, and replay rejection. A successor plan must
> first define and review the AEAD/session/replay contract described in the corresponding design.

**Goal:** Replace only StackChan camera JPEG delivery with an authenticated UDP latest-only protocol so a lost packet cannot impose TCP retransmission head-of-line blocking on person-follow perception.

**Architecture:** Keep the authenticated camera WebSocket as the session/configuration and disconnect boundary, then carry SCL1 frame chunks and bounded credits over one UDP endpoint. Firmware retains its existing one-slot sender; Gateway retains one incomplete frame and one published frame, drops incomplete older sequences, and never falls back to camera binary over TCP.

**Tech Stack:** Python 3.13, asyncio DatagramProtocol, pytest, C++17 host tests, ESP-IDF 5.5.2, existing `NetworkInterface::CreateUdp()`.

---

The user explicitly requested no commit. Commit steps from the normal workflow are intentionally omitted.

## File ownership map

- Create `gateway/stackchan_mcp/camera_datagram.py`: SCU1 wire parser, latest-only assembler, authenticated session, UDP endpoint.
- Create `gateway/tests/test_camera_datagram.py`: golden vector, malformed input, ordering, expiry, token/source binding tests.
- Modify `gateway/stackchan_mcp/esp32_client.py`: UDP listener lifecycle, media-session configuration/hello, completed-frame publication, capability gate.
- Modify `gateway/tests/test_esp32_client.py`: WebSocket/UDP pairing, listener cleanup, no-TCP-binary behavior.
- Modify `gateway/stackchan_mcp/camera_stream.py`: start/stop the periodic UDP credit lease instead of per-frame TCP replenishment.
- Modify `gateway/tests/test_camera_stream.py`: stream lifecycle and credit lease tests.
- Modify `gateway/stackchan_mcp/stdio_server.py`: expose non-secret datagram counters through existing camera status only.
- Modify `gateway/tests/test_stdio_server.py`: diagnostic status assertions without token disclosure.
- Create `firmware/main/camera_datagram_protocol.h`: tracked, platform-neutral SCU1 encode/decode, CRC32, URL host extraction.
- Create `firmware/host_test/test_camera_datagram_protocol.cc`: C++ golden vector, split, credit, token, URL tests.
- Modify `firmware/host_test/CMakeLists.txt`: register the new host test executable.
- Modify `firmware/main/protocols/protocol.h`: add the camera-packet transport boundary.
- Modify `firmware/main/protocols/websocket_protocol.h`: own the camera UDP session alongside the authenticated media WebSocket.
- Modify `firmware/main/protocols/websocket_protocol.cc`: accept datagram config, open/close UDP, receive credits, send SCU1 chunks, advertise capability.
- Modify `firmware/main/application.cc`: send camera packets through the camera-specific protocol method while keeping control/audio unchanged.
- Modify `firmware/host_test/test_camera_stream_protocol.cc`: assert no camera TCP fallback and unchanged one-slot semantics.
- Modify `/Users/monsoon/.pico/field-runs/stackchan-gimbal-causal-2.Fu5f5wAk/camera-producer-consumer-probe.ts`: record datagram counters without changing its safe trajectory.

### Task 1: Define and verify the Python SCU1 wire contract

Run this task from `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway`.

**Files:**
- Create: `stackchan_mcp/camera_datagram.py`
- Create: `tests/test_camera_datagram.py`

- [ ] **Step 1: Write failing golden-vector and validation tests**

Use token `000102030405060708090a0b0c0d0e0f`, sequence `7`, and frame `b"abc"`. Require the single frame datagram to equal:

```python
bytes.fromhex(
    "534355310101"
    "000102030405060708090a0b0c0d0e0f"
    "000000070000000100000003352441c2"
    "616263"
)
```

Also require:

```python
assert encode_hello(token) == bytes.fromhex(
    "534355310103000102030405060708090a0b0c0d0e0f"
)
assert encode_credit(token, 4) == bytes.fromhex(
    "534355310102000102030405060708090a0b0c0d0e0f04"
)
```

Parametrize rejection of short prefixes, wrong magic/version/kind, token lengths other than 16, credit outside 1..4, zero-length frames, frames above `5 * 1024 * 1024`, inconsistent chunk counts, and datagrams above 1,200 bytes.

- [ ] **Step 2: Run the new test file and verify RED**

Run:

```bash
.venv/bin/python -m pytest tests/test_camera_datagram.py -q
```

Expected: collection fails because `stackchan_mcp.camera_datagram` does not exist.

- [ ] **Step 3: Implement the minimal wire module**

Define these public contracts exactly:

```python
SCU1_MAGIC = b"SCU1"
SCU1_VERSION = 1
SCU1_FRAME = 1
SCU1_CREDIT = 2
SCU1_HELLO = 3
SCU1_TOKEN_BYTES = 16
SCU1_MAX_DATAGRAM_BYTES = 1200
SCU1_MAX_FRAME_BYTES = 5 * 1024 * 1024

@dataclass(frozen=True, slots=True)
class FrameChunk:
    token: bytes
    sequence: int
    chunk_index: int
    chunk_count: int
    frame_length: int
    frame_crc32: int
    payload: bytes

@dataclass(frozen=True, slots=True)
class CreditGrant:
    token: bytes
    credits: int

@dataclass(frozen=True, slots=True)
class SessionHello:
    token: bytes

def split_frame(*, token: bytes, sequence: int, frame: bytes) -> tuple[bytes, ...]: ...
def encode_credit(token: bytes, credits: int) -> bytes: ...
def encode_hello(token: bytes) -> bytes: ...
def peek_token(data: bytes) -> bytes | None: ...
def parse_datagram(data: bytes) -> FrameChunk | CreditGrant | SessionHello: ...
```

Use `struct.Struct("!4sBB16sIHHII")` for frame chunks, `struct.Struct("!4sBB16sB")` for credits, `struct.Struct("!4sBB16s")` for hello, and `zlib.crc32(frame) & 0xFFFFFFFF`. Validate all bounds before returning dataclasses.

- [ ] **Step 4: Run protocol tests and verify GREEN**

Run:

```bash
.venv/bin/python -m pytest tests/test_camera_datagram.py -q
.venv/bin/ruff check stackchan_mcp/camera_datagram.py tests/test_camera_datagram.py
```

Expected: all new tests pass and Ruff reports no errors.

### Task 2: Implement one-frame latest-only reassembly

**Files:**
- Modify: `gateway/stackchan_mcp/camera_datagram.py`
- Modify: `gateway/tests/test_camera_datagram.py`

- [ ] **Step 1: Write failing assembler tests**

Require these cases:

```python
assembler = LatestFrameAssembler(max_age_ms=500)
chunks = split_frame(token=token, sequence=8, frame=large_scl1)
assert assembler.push(chunks[-1], now_ms=0) is None
for chunk in reversed(chunks[:-1]):
    completed = assembler.push(chunk, now_ms=1)
assert completed == large_scl1
```

Also assert duplicate chunks are idempotent; sequence 9 discards incomplete sequence 8; sequence 8 arriving after 9 is stale; a frame older than 500 ms is expired on the next push; CRC failure never completes; `status()` reports `completed_frames`, `replaced_incomplete_frames`, `stale_chunks`, `expired_frames`, `invalid_frames`, and never contains frame bytes or tokens.

- [ ] **Step 2: Run the assembler cases and verify RED**

Run:

```bash
.venv/bin/python -m pytest tests/test_camera_datagram.py -q -k assembler
```

Expected: failure because `LatestFrameAssembler` is undefined.

- [ ] **Step 3: Implement the bounded assembler**

Add:

```python
class LatestFrameAssembler:
    def __init__(self, *, max_age_ms: int = 500, max_frame_bytes: int = SCU1_MAX_FRAME_BYTES): ...
    def push(self, datagram: bytes, *, now_ms: int) -> bytes | None: ...
    def reset(self) -> None: ...
    def status(self) -> dict[str, int | bool]: ...
```

Keep only one `_PendingFrame` containing sequence, start time, declared metadata, and a `dict[int, bytes]`. On a newer sequence, replace the pending frame. Join chunks only when the bitmap is complete, verify exact total length and CRC32, then clear pending state. Do not start a timer or background worker.

- [ ] **Step 4: Run all datagram tests and verify GREEN**

Run:

```bash
.venv/bin/python -m pytest tests/test_camera_datagram.py -q
```

Expected: all cases pass.

### Task 3: Add the authenticated Gateway UDP session

**Files:**
- Modify: `gateway/stackchan_mcp/camera_datagram.py`
- Modify: `gateway/stackchan_mcp/esp32_client.py`
- Modify: `gateway/tests/test_camera_datagram.py`
- Modify: `gateway/tests/test_esp32_client.py`

- [ ] **Step 1: Write failing session-binding tests**

Create a `CameraDatagramSession` with a deterministic 16-byte token and expected IP `127.0.0.1`. Assert that:

```python
assert session.accept(encode_hello(token), ("127.0.0.1", 41000), now_ms=0) is None
assert session.ready is True
assert session.peer == ("127.0.0.1", 41000)
```

Wrong token and wrong source IP must not make the session ready. After binding, a different port must be rejected. A completed frame from the bound endpoint must be returned. `close()` must clear peer, token lookup, assembler state, and ready event.

Add manager tests requiring `start("127.0.0.1", 0)` to create both WebSocket and UDP transports, and `stop()` to close both even when camera cleanup raises.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
.venv/bin/python -m pytest tests/test_camera_datagram.py tests/test_esp32_client.py -q -k "datagram or udp"
```

Expected: failures because session and UDP listener ownership are absent.

- [ ] **Step 3: Implement session and endpoint ownership**

Define:

```python
class CameraDatagramSession:
    def __init__(self, *, token: bytes, expected_ip: str): ...
    @property
    def ready(self) -> bool: ...
    @property
    def peer(self) -> tuple[str, int] | None: ...
    async def wait_ready(self, timeout_s: float) -> None: ...
    def accept(self, data: bytes, addr: tuple[str, int], *, now_ms: int) -> bytes | None: ...
    def close(self) -> None: ...
    def status(self) -> dict[str, object]: ...

class CameraDatagramEndpoint(asyncio.DatagramProtocol):
    def __init__(self, on_datagram: Callable[[bytes, tuple[str, int]], None]): ...
    def connection_made(self, transport: asyncio.BaseTransport) -> None: ...
    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None: ...
    def sendto(self, data: bytes, addr: tuple[str, int]) -> None: ...
    def close(self) -> None: ...
```

This historical API is insufficient and must not be implemented as written. A successor session
must authenticate every frame and credit datagram with AEAD, bind it to a per-stream on-wire epoch,
use nonce-unique direction-separated keys established through the authenticated WebSocket, and
reject duplicate or stale counters with a bounded replay window. Token/source routing remains an
additional pre-allocation check and never substitutes for message authentication.

In `ESP32Manager.start`, start the WebSocket server, resolve its actual port, then call `loop.create_datagram_endpoint(..., local_addr=(host, actual_ws_port if port != 0 else 0))`. Store and advertise the actual UDP port. Route datagrams by `peek_token()` to exactly one active camera session and schedule completed-frame handling on the event loop.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
.venv/bin/python -m pytest tests/test_camera_datagram.py tests/test_esp32_client.py -q
```

Expected: all focused tests pass.

### Task 4: Pair the media WebSocket with UDP and remove TCP camera binary

**Files:**
- Modify: `gateway/stackchan_mcp/esp32_client.py`
- Modify: `gateway/tests/test_esp32_client.py`

- [ ] **Step 1: Write failing pairing and capability tests**

Require control hello features to include both `camera_stream: true` and `camera_datagram_v1: true`. On camera WebSocket connection, assert the first Gateway message decodes to:

```python
{
    "type": "camera_datagram_config",
    "version": 1,
    "port": manager._camera_datagram_port,
    "maxDatagramBytes": 1200,
    "token": expected_token.hex(),
}
```

The media connection must not become ready before a valid UDP hello. A binary WebSocket camera frame must be ignored and must not publish. Capability mismatch must make `supports_camera_stream` false. Media/control disconnect must close the session and reset the assembler.

- [ ] **Step 2: Run the pairing cases and verify RED**

Run:

```bash
.venv/bin/python -m pytest tests/test_esp32_client.py -q -k "camera and (datagram or binary or capability)"
```

Expected: current media connection accepts binary frames and has no datagram readiness gate.

- [ ] **Step 3: Implement the pairing boundary**

Extend `CameraMediaConnection` with `datagram_session`. Generate the token with `secrets.token_bytes(16)`, derive the expected IP from `ws.remote_address`, register it before sending config, and wait at most one second for UDP hello. Only then call `_ensure_camera_stream_ready`.

Change `supports_camera_stream` to require `connection.features.get("camera_datagram_v1") is True` and a ready session. In `_camera_handler`, ignore all binary messages with a bounded warning instead of calling `_handle_camera_binary_message`. On disconnect, unregister the token, stop credits, clear assembler, and run existing `camera_stream.stop_all()`.

- [ ] **Step 4: Run Gateway connection tests and verify GREEN**

Run:

```bash
.venv/bin/python -m pytest tests/test_esp32_client.py -q
```

Expected: all tests pass.

### Task 5: Move camera credits to a bounded UDP lease

**Files:**
- Modify: `gateway/stackchan_mcp/camera_stream.py`
- Modify: `gateway/stackchan_mcp/esp32_client.py`
- Modify: `gateway/tests/test_camera_stream.py`
- Modify: `gateway/tests/test_esp32_client.py`

- [ ] **Step 1: Write failing stream-lifecycle tests**

Replace the fake device's `send_camera_stream_credit` contract with:

```python
async def begin_camera_datagram_stream(self) -> None: ...
async def end_camera_datagram_stream(self) -> None: ...
```

Require acquire to call WiFi performance mode, `self.camera.start_stream`, then begin the datagram lease. Require release, idle expiry, start failure cleanup, reconnect, and shutdown to call end before `self.camera.stop_stream`. Verify the manager sends credit 4 immediately and every 250 ms, never lets two credit tasks coexist, and cancels the task without leaking `CancelledError`.

- [ ] **Step 2: Run stream tests and verify RED**

Run:

```bash
.venv/bin/python -m pytest tests/test_camera_stream.py tests/test_esp32_client.py -q -k "stream or credit"
```

Expected: failures because credits are currently sent over WebSocket per completed frame.

- [ ] **Step 3: Implement the UDP credit lease**

Change `CameraStreamDevice` to the begin/end methods. Remove `replenish_frame_credit()` and per-frame credit timing counters. In the manager, implement:

```python
async def begin_camera_datagram_stream(self) -> None:
    await self.end_camera_datagram_stream()
    session = self._require_ready_camera_datagram_session()
    session.send_credit(self._camera_datagram_endpoint, 4)
    self._camera_credit_task = asyncio.create_task(self._camera_credit_loop(session))

async def _camera_credit_loop(self, session: CameraDatagramSession) -> None:
    while session.ready:
        await asyncio.sleep(0.25)
        session.send_credit(self._camera_datagram_endpoint, 4)
```

Cancel and await the task in `end_camera_datagram_stream`. Start the lease only after physical stream start succeeds. Stop it before physical stream cleanup. Completed-frame handling publishes to `LatestCameraFrameStore` without sending a TCP credit.

- [ ] **Step 4: Run camera service and manager tests and verify GREEN**

Run:

```bash
.venv/bin/python -m pytest tests/test_camera_stream.py tests/test_esp32_client.py -q
```

Expected: all focused tests pass with no pending-task warnings.

### Task 6: Expose non-secret transport evidence

**Files:**
- Modify: `gateway/stackchan_mcp/camera_stream.py`
- Modify: `gateway/stackchan_mcp/esp32_client.py`
- Modify: `gateway/stackchan_mcp/stdio_server.py`
- Modify: `gateway/tests/test_camera_stream.py`
- Modify: `gateway/tests/test_stdio_server.py`

- [ ] **Step 1: Write failing status tests**

Require `camera_stream status` to include:

```python
"datagram": {
    "ready": True,
    "completed_frames": 3,
    "replaced_incomplete_frames": 1,
    "stale_chunks": 2,
    "expired_frames": 0,
    "invalid_frames": 0,
    "source_mismatch_packets": 0,
}
```

Assert recursively that neither `token`, `session_token`, nor raw datagram/frame bytes appear. Keep `get_camera_device_stream_status` mapped only to the firmware producer status.

- [ ] **Step 2: Run status tests and verify RED**

Run:

```bash
.venv/bin/python -m pytest tests/test_camera_stream.py tests/test_stdio_server.py -q -k "status or device_stream"
```

Expected: datagram counters are absent.

- [ ] **Step 3: Merge the status provider without a new public tool**

Inject `datagram_status: Callable[[], dict[str, object]]` into `CameraStreamService` and merge it under the `datagram` key in `status()`. Have `ESP32Manager` pass a method that returns only counters and booleans from the active or last closed session. Do not return token, IP, port, payload, or frame bytes.

- [ ] **Step 4: Run status tests and verify GREEN**

Run:

```bash
.venv/bin/python -m pytest tests/test_camera_stream.py tests/test_stdio_server.py -q
```

Expected: all focused tests pass.

### Task 7: Define and verify the firmware SCU1 wire contract

Run this task from `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream`.

**Files:**
- Create: `firmware/main/camera_datagram_protocol.h`
- Create: `firmware/host_test/test_camera_datagram_protocol.cc`
- Modify: `firmware/host_test/CMakeLists.txt`

- [ ] **Step 1: Write the failing C++ golden-vector tests**

Use the same token, sequence, frame, hello, credit, and expected hex bytes as Task 1. Also test a payload spanning at least three 1,200-byte datagrams, invalid tokens/credits, one-bit CRC corruption, and Gateway host extraction from `ws://192.0.2.10:18765/`.

Require these public contracts:

```cpp
using CameraDatagramToken = std::array<uint8_t, 16>;
std::optional<CameraDatagramToken> ParseCameraDatagramTokenHex(std::string_view hex);
std::string BuildCameraDatagramHello(const CameraDatagramToken& token);
std::optional<uint8_t> ParseCameraDatagramCredit(
    std::string_view datagram,
    const CameraDatagramToken& expected_token
);
std::vector<std::string> BuildCameraFrameDatagrams(
    const CameraDatagramToken& token,
    uint32_t sequence,
    const uint8_t* frame,
    size_t frame_size,
    size_t max_datagram_bytes = 1200
);
std::optional<std::string> ExtractCameraDatagramHost(std::string_view websocket_url);
```

- [ ] **Step 2: Configure and run the test to verify RED**

Add the executable and `gtest_discover_tests` entry, then run:

```bash
cmake -S firmware/host_test -B firmware/host_test/build
cmake --build firmware/host_test/build --target camera_datagram_protocol_test -j2
```

Expected: compilation fails because `camera_datagram_protocol.h` does not exist.

- [ ] **Step 3: Implement the header-only tracked protocol**

Use fixed constants matching Python, explicit big-endian append/read helpers, and an IEEE CRC32 implementation with polynomial `0xEDB88320`. Return empty vectors/`nullopt` for invalid inputs. Derive each chunk payload offset from `chunk_index * (max_datagram_bytes - 38)` and never produce a datagram larger than the configured maximum.

- [ ] **Step 4: Run the C++ protocol test and verify GREEN**

Run:

```bash
cmake --build firmware/host_test/build --target camera_datagram_protocol_test -j2
firmware/host_test/build/camera_datagram_protocol_test
```

Expected: all SCU1 C++ tests pass.

### Task 8: Integrate UDP into the firmware camera protocol

**Files:**
- Modify: `firmware/main/protocols/protocol.h`
- Modify: `firmware/main/protocols/websocket_protocol.h`
- Modify: `firmware/main/protocols/websocket_protocol.cc`
- Modify: `firmware/main/application.cc`
- Modify: `firmware/host_test/test_camera_stream_protocol.cc`

- [ ] **Step 1: Write failing transport-boundary tests**

In host tests, require the camera send action to be `kSendDatagram` only when the datagram session is ready, and `kReject` otherwise. Require `camera_stream_credit` received from camera WebSocket to be rejected, `camera_datagram_config` version 1 with valid port/MTU/token to be accepted, and `camera_datagram_v1` capability to be enabled for StackChan.

Require chunk sending to stop at the first failed `Udp::Send()` and never invoke a TCP/WebSocket binary sender.

- [ ] **Step 2: Run focused host tests and verify RED**

Run:

```bash
cmake --build firmware/host_test/build --target camera_stream_protocol_test -j2
firmware/host_test/build/camera_stream_protocol_test
```

Expected: failures because the existing action is dedicated WebSocket media and Application still calls `SendBinary()`.

- [ ] **Step 3: Add the camera-specific protocol method**

Add to `Protocol`:

```cpp
virtual bool SendCameraPacket(
    uint32_t sequence,
    const uint8_t* data,
    size_t size
) {
    return false;
}
```

Override it in `WebsocketProtocol`. Change `Application::SendCameraPacket` to call this method. Do not change `SendAudio`, `SendText`, incoming control binary, MCP dispatch, or head-target paths.

- [ ] **Step 4: Own the UDP session inside `WebsocketProtocol`**

Add a camera mutex, `std::unique_ptr<Udp>`, current token, current host/port/MTU, and an atomic ready flag. On valid `camera_datagram_config`, extract the host from the already selected candidate URL, create UDP connect-id 3, connect, register `OnMessage`, send hello, then set the current epoch ready. On a valid credit datagram for the current token, forward a credit event through the existing incoming-JSON callback so `EspVideo::GrantStreamCredits()` remains the only producer-credit mutation.

`CloseCameraChannel`, reconnect, destructor, and reboot paths must clear ready before destroying UDP. Never edit files under `firmware/managed_components`.

- [ ] **Step 5: Send frame chunks without retry or TCP fallback**

In `SendCameraPacket`, build SCU1 chunks using the negotiated MTU. Send each chunk once through `Udp::Send()`. Return false at the first short/failed send. Do not reopen the socket, retry a chunk, lower TCP RTO, or call `camera_websocket_->Send()`.

Advertise `camera_datagram_v1: true` in the StackChan hello features. Camera WebSocket text handling must accept only datagram config; legacy credit text and binary payloads must not enable the stream.

- [ ] **Step 6: Run focused firmware host tests and verify GREEN**

Run:

```bash
cmake -S firmware/host_test -B firmware/host_test/build
cmake --build firmware/host_test/build -j2
ctest --test-dir firmware/host_test/build --output-on-failure
```

Expected: all host tests pass, including existing spring, auto-sleep, and MCP dispatch tests.

### Task 9: Run full offline verification and build the real firmware

**Files:**
- Verify all modified production/test files.

- [ ] **Step 1: Run full Gateway verification**

Run from `gateway/`:

```bash
.venv/bin/ruff check stackchan_mcp tests
.venv/bin/python -m pytest -q
```

Expected: Ruff has zero findings; the complete Gateway suite passes with only its existing documented skips.

- [ ] **Step 2: Run all firmware host tests**

Run from repository root:

```bash
cmake -S firmware/host_test -B firmware/host_test/build
cmake --build firmware/host_test/build -j2
ctest --test-dir firmware/host_test/build --output-on-failure
```

Expected: zero failures.

- [ ] **Step 3: Confirm scope and secret hygiene**

Run:

```bash
rg -n "camera_datagram_v1|SCU1|camera_datagram_config" gateway firmware/main firmware/host_test
rg -n "TCP_NODELAY|LWIP_TCP_RTO_TIME|SetNoDelay" firmware/main gateway || true
git diff --check
```

Expected: new identifiers appear only in camera transport owners/tests; no NODELAY/RTO experiment returns; diff check is clean. Do not print local environment files or tokens.

- [ ] **Step 4: Build the canonical StackChan image in Docker**

Run from `firmware/` without deleting user data or flashing:

```bash
docker run --rm --cpus=4 --ulimit nofile=65536:65536 \
  -v "$PWD":/project -w /project espressif/idf:v5.5.2 \
  python ./scripts/release.py stackchan
```

Expected: `build/xiaozhi.bin` is produced by the mandatory `stackchan` board path. Do not use native `idf.py` and do not flash a merged image.

### Task 10: Extend the existing safe evidence probe

**Files:**
- Modify: `/Users/monsoon/.pico/field-runs/stackchan-gimbal-causal-2.Fu5f5wAk/camera-producer-consumer-probe.ts`

- [ ] **Step 1: Add report-only datagram assertions**

Read `camera_stream status` before stop and retain its `datagram` object. Reject a run if the status contains token-like keys or if `ready` is not true while streaming. Report completed, replaced-incomplete, stale, expired, invalid, and source-mismatch counts alongside the existing device producer/Gateway consumer counts.

- [ ] **Step 2: Run TypeScript static validation without contacting hardware**

Run from the Pico worktree:

```bash
./node_modules/.bin/tsc --noEmit \
  --target ES2023 --module NodeNext --moduleResolution NodeNext \
  /Users/monsoon/.pico/field-runs/stackchan-gimbal-causal-2.Fu5f5wAk/camera-producer-consumer-probe.ts
```

Expected: zero TypeScript errors. Do not execute the probe yet.

### Task 11: Attended deployment and A/B validation

This task starts only after explicitly confirming the user is present. Announce every reset and flash before executing it.

**Files:**
- Generate: a private report beside the existing field evidence.

- [ ] **Step 1: Verify the six firmware pre-test conditions**

Confirm USB, Gateway listener, LAN path, Docker, secret-bearing local config alignment without printing values, and `build/xiaozhi.bin` freshness. Verify the current device state is camera stopped, auto-sleep false, and home command yaw 0 / pitch 33.

- [ ] **Step 2: Restart the Gateway with the new UDP listener**

Source `/Users/monsoon/.pico/stackchan-mcp/local-gateway.env` without echoing values. Verify TCP ports and the UDP listener, then perform a normal USB reset only if the device does not reconnect.

- [ ] **Step 3: Flash only the active OTA application slot**

Re-read the partition/boot state before writing. The retained field evidence says the active image is at `0x410000`; verify this again rather than using the generic `0x20000` instruction. Write only `build/xiaozhi.bin`, preserve NVS, and never write `merged-binary.bin`.

- [ ] **Step 4: Run camera-only and small-motion gates**

Run one camera-only 40-frame probe, then three consecutive pitch-33 yaw `15 → 0 → -15` 40-frame probes. Require each motion probe to have maximum camera wait at most 500 ms, WebSocket disconnects 0, servo command failures 0, encode failures 0, and no legacy TCP camera binary frames.

- [ ] **Step 5: Restore and verify safety after every run**

After each run, command yaw 0 / pitch 33, wait for physical settling, verify actual pose, camera stopped, subscribers 0, physical stream stopped, and auto-sleep false. Never command pitch below 23.

- [ ] **Step 6: Run one 20-second person-follow trial**

Use the frozen 8 fps/controller baseline and ask the user to judge smoothness, tracking speed, reverse motion, jumps, and freezes. Treat that rating as primary; do not substitute frame counts for acceptance.
