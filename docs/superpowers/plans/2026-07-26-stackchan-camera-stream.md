# StackChan Camera Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace repeated StackChan `take_photo` uploads with a bounded, in-memory GC0308 JPEG stream that feeds Pico face following and on-demand scene vision.

**Architecture:** The StackChan firmware captures QVGA frames at an explicitly requested rate, encodes JPEG, and sends `SCL1` binary frames only while media credit is available. The gateway demultiplexes camera frames from raw Opus, keeps one latest frame in memory, exposes an authenticated long-poll JPEG endpoint, and reference-counts stream users. Pico acquires the stream with an MCP tool, reads only the latest JPEG over loopback HTTP, and releases the stream on interaction cleanup.

**Tech Stack:** ESP-IDF 5.5.2, esp-video, esp_new_jpeg, C++20/FreeRTOS, Python 3.14/aiohttp/Starlette, TypeScript/Vitest, MCP Streamable HTTP

---

## Task 1: Gateway latest-frame store and `SCL1` demultiplexing

**Files (relative to the sibling `stackchan-mcp` repository):**
- Create: `gateway/stackchan_mcp/camera_stream.py`
- Modify: `gateway/stackchan_mcp/esp32_client.py`
- Test: `gateway/tests/test_camera_stream.py`
- Test: `gateway/tests/test_esp32_client.py`

- [ ] **Step 1: Write failing parser and latest-only store tests**

  Cover the exact `SCL1` envelope (`magic`, kind byte, two-byte big-endian JSON length, bounded JSON metadata, JPEG payload), malformed frames, sequence replacement, stale-sequence rejection, waiter wake-up, timeout, and memory clearing.

- [ ] **Step 2: Run focused tests and verify RED**

  Run:

  ```bash
  cd gateway
  uv run pytest tests/test_camera_stream.py tests/test_esp32_client.py -q
  ```

  Expected: imports or assertions fail because `camera_stream.py` and binary demultiplexing do not exist.

- [ ] **Step 3: Implement the store and route camera binary before audio**

  The public contract is:

  ```python
  @dataclass(frozen=True, slots=True)
  class CameraFrame:
      sequence: int
      captured_at_ms: int
      encoded_at_ms: int
      received_at_ms: int
      width: int
      height: int
      quality: int
      jpeg: bytes

  def parse_camera_frame(payload: bytes, *, max_frame_bytes: int) -> CameraFrame | None: ...

  class LatestCameraFrameStore:
      async def publish(self, frame: CameraFrame) -> bool: ...
      async def wait_for_frame(self, *, after_sequence: int | None, timeout_s: float) -> CameraFrame | None: ...
      async def clear(self) -> None: ...
      def status(self) -> dict[str, int | bool | None]: ...
  ```

  `ESP32Manager._handler` must call the parser only when the binary payload starts with `SCL1`; other binary payloads remain raw Opus. Invalid `SCL1` is logged and never forwarded to STT.

  Every claimed media credit has exactly one terminal disposition. Invalid or stale frames rejected before a transport send, unsent latest-slot replacements, and unsent frames discarded during disconnect or quiesce restore one credit exactly once. A published frame consumes its credit. Once a transport send has been attempted, either success or failure also consumes the credit; failed sends are not refunded or retried, preventing a failed transport from creating a self-amplifying retry loop. Subsequent bounded grants restore forward progress. Host tests cover invalid/stale input, latest-slot replacement, pre-send disconnect, send failure, and successful publication, and assert that no disposition restores or consumes a credit twice.

- [ ] **Step 4: Run focused tests and verify GREEN**

  Run the same focused pytest command and require zero failures.

## Task 2: Gateway stream lifecycle and authenticated latest-frame HTTP route

**Files (relative to the sibling `stackchan-mcp` repository):**
- Modify: `gateway/stackchan_mcp/camera_stream.py`
- Modify: `gateway/stackchan_mcp/protocol.py`
- Modify: `gateway/stackchan_mcp/esp32_client.py`
- Modify: `gateway/stackchan_mcp/http_server.py`
- Modify: `gateway/stackchan_mcp/stdio_server.py`
- Test: `gateway/tests/test_camera_stream.py`
- Test: `gateway/tests/test_http_server.py`
- Test: `gateway/tests/test_stdio_server.py`

- [ ] **Step 1: Write failing lifecycle and HTTP tests**

  Test `camera_stream(action=start|stop|status)`, first-subscriber device start, last-subscriber device stop, two initial credits, disconnected-device errors, `/camera/latest` long-poll behavior, JPEG headers, bearer protection, maximum response size, and clearing the latest frame after the final release.

- [ ] **Step 2: Run focused tests and verify RED**

  ```bash
  cd gateway
  uv run pytest tests/test_camera_stream.py tests/test_http_server.py tests/test_stdio_server.py -q
  ```

- [ ] **Step 3: Implement reference-counted lifecycle**

  Add one gateway-owned service with:

  ```python
  async def acquire(self, *, fps: int, quality: int) -> dict[str, Any]: ...
  async def release(self) -> dict[str, Any]: ...
  async def stop_all(self) -> None: ...
  def status(self) -> dict[str, Any]: ...
  ```

  Validate `fps` in `1..20` and JPEG quality in `1..100`. The first acquire calls `self.camera.start_stream`; subsequent acquires only increment the subscriber count. The final release calls `self.camera.stop_stream`, clears the in-memory frame, and retains aggregate counters only. No image is written to disk.

- [ ] **Step 4: Implement the authenticated frame endpoint**

  Register:

  ```python
  Route("/camera/latest", endpoint=camera_latest, methods=["GET"])
  Route("/camera/status", endpoint=camera_status, methods=["GET"])
  ```

  `GET /camera/latest?after_sequence=N&timeout_ms=M` returns `image/jpeg` plus `X-Camera-Sequence`, `X-Camera-Captured-At-Ms`, `X-Camera-Encoded-At-Ms`, and `X-Camera-Received-At-Ms`, or `204` after a bounded wait. Existing host/origin/bearer guards protect both routes.

- [ ] **Step 5: Run focused tests and verify GREEN**

  Run the same focused pytest command and require zero failures.

## Task 3: Firmware media-credit JPEG producer

**Files (relative to the sibling `stackchan-mcp` repository):**
- Modify: `firmware/main/boards/common/camera.h`
- Modify: `firmware/main/boards/common/esp_video.h`
- Modify: `firmware/main/boards/common/esp_video.cc`
- Modify: `firmware/main/protocols/protocol.h`
- Modify: `firmware/main/protocols/websocket_protocol.h`
- Modify: `firmware/main/protocols/websocket_protocol.cc`
- Modify: `firmware/main/application.h`
- Modify: `firmware/main/application.cc`
- Modify: `firmware/main/mcp_server.cc`
- Create: `firmware/main/camera_stream_protocol.h`
- Test: `firmware/host_test/test_camera_stream_protocol.cc`
- Modify: `firmware/host_test/CMakeLists.txt`

- [ ] **Step 1: Write a failing host test for the wire envelope and latest slot**

  Assert the byte-exact `SCL1` prefix, kind `1`, reserved `0`, big-endian header length, JSON metadata fields, JPEG SOI/EOI preservation, and replacement of one unsent packet by a newer sequence.

- [ ] **Step 2: Build the host test and verify RED**

  ```bash
  cd firmware
  docker run --rm --cpus=4 --ulimit nofile=65536:65536 \
    -v "$PWD":/project -w /project espressif/idf:v5.5.2 \
    bash -lc 'cmake -S host_test -B host_test/build && cmake --build host_test/build && ctest --test-dir host_test/build --output-on-failure'
  ```

- [ ] **Step 3: Implement the wire packet and protocol send boundary**

  `Protocol` gains a default-false `SendBinary(const uint8_t*, size_t)` method; `WebsocketProtocol` sends a binary WebSocket frame only when physically connected. `Application::SendCameraJpeg` constructs the `SCL1` packet and stores only one unsent packet; a single scheduled drain sends it on the main task and counts replacements.

- [ ] **Step 4: Implement credit-gated capture and firmware tools**

  `Camera` gains optional `StartStream`, `StopStream`, `GrantStreamCredits`, and `GetStreamStatus` methods. `EspVideo`:

  - accepts `fps=1..20`, `quality=1..100`;
  - starts one producer thread;
  - waits without capturing when credit is zero;
  - dequeues one V4L2 buffer, encodes through `image_to_jpeg`, requeues the buffer, consumes one credit, and passes JPEG metadata to `Application::SendCameraJpeg`;
  - stops and joins cleanly before destruction;
  - does not allow single-photo capture to race the stream.

  Add `self.camera.start_stream`, `self.camera.stop_stream`, and `self.camera.stream_status` MCP tools. Add `camera_stream=true` to the device hello features and handle `{"type":"camera_stream_credit","credits":N}` in `Application::OnIncomingJson`.

- [ ] **Step 5: Verify host tests and build the StackChan firmware**

  Run the host-test command, then:

  ```bash
  cd firmware
  docker run --rm --cpus=4 --ulimit nofile=65536:65536 \
    -v "$PWD":/project -w /project espressif/idf:v5.5.2 \
    python ./scripts/release.py stackchan
  ```

  Require both commands to exit zero before flashing.

## Task 4: Pico stream lease and latest-frame reader

**Files (relative to this Pico repository):**
- Modify: `src/config/index.ts`
- Modify: `config/pico.example.yaml`
- Modify: `src/modules/stackchan/index.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/stackchan.test.ts`
- Modify: `tests/stackchan-attention-runtime.test.ts`

- [ ] **Step 1: Write failing config and adapter tests**

  Test defaults `streamFps=20`, `streamJpegQuality=60`, bounds, authenticated `/camera/latest` reads, `after_sequence` progression, response-size/JPEG validation, stream acquire on connect, release on close, and containment of raw HTTP/MCP errors.

- [ ] **Step 2: Run focused tests and verify RED**

  ```bash
  npm test -- tests/config.test.ts tests/stackchan.test.ts tests/stackchan-attention-runtime.test.ts
  ```

- [ ] **Step 3: Implement the thin stream adapter**

  `createStackChanAdapterFromConfig` derives the loopback frame URL from the configured `/mcp` URL, sends the same bearer token, and uses an abort timeout. `connect` invokes:

  ```ts
  client.callTool({
    name: "camera_stream",
    arguments: { action: "start", fps: config.streamFps, quality: config.streamJpegQuality }
  });
  ```

  `captureJpeg` long-polls only the latest sequence and never touches the capture directory. `close` releases the stream before closing MCP. The existing attention controller, PINTO model, and servo logic are unchanged.

- [ ] **Step 4: Run focused tests and verify GREEN**

  Run the same focused Vitest command and require zero failures.

## Task 5: Full verification and bounded hardware measurement

**Files (relative to this Pico repository):**
- Modify: `scripts/field/stackchan-face-follow.ts`
- Modify: `tests/stackchan-face-follow-field.test.ts`
- Modify: `docs/field-tests/2026-07-26-stackchan-face-follow-vlm-routing.md`

- [ ] **Step 1: Write failing aggregate-metric tests**

  Require the private report to include requested stream FPS, received FPS, P50/P95 frame age, sequence gaps, maximum JPEG bytes, inference P50/P95, and move rate, without image bytes or paths.

- [ ] **Step 2: Implement aggregate reporting and verify focused tests**

  Run:

  ```bash
  npm test -- tests/stackchan-face-follow-field.test.ts
  ```

- [ ] **Step 3: Run full software gates**

  ```bash
  cd gateway && uv run pytest && uv run ruff check .
  just check
  ```

- [ ] **Step 4: Flash only after announcing the destructive device action**

  Preserve NVS and flash only `firmware/build/xiaozhi.bin` at `0x20000` with the detected `/dev/cu.usbmodem*` device.

- [ ] **Step 5: Run bounded live measurements**

  First validate 15fps for ten minutes, then 20fps. Require no unbounded queue growth, no audio-frame misclassification, bounded memory, P95 frame age under 200ms, clean stream release, and successful on-demand scene capture from the latest frame. Keep 30fps as a separate experiment because the current GC0308 preset is 20fps.
