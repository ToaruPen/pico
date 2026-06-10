import { describe, expect, it } from "vitest";

import {
  createRtspSnapshotClient,
  defineRtspSnapshotSource,
  type RtspSnapshotTransport
} from "../src/modules/camera/index.js";

const snapshotSourceInput = {
  id: "playroom-cam-1",
  host: "192.168.10.25",
  username: "camera user",
  password: "pa:ss@word",
  stream: "stream2"
} as const;

describe("RTSP snapshot boundary", () => {
  it("builds one credential-encoded RTSP snapshot URL", () => {
    const source = defineRtspSnapshotSource(snapshotSourceInput);

    expect(source).toEqual({
      id: "playroom-cam-1",
      url: "rtsp://camera%20user:pa%3Ass%40word@192.168.10.25:554/stream2"
    });
  });

  it("builds an RTSP snapshot URL with a custom port", () => {
    const source = defineRtspSnapshotSource({
      ...snapshotSourceInput,
      port: 8554
    });

    expect(source.url).toBe("rtsp://camera%20user:pa%3Ass%40word@192.168.10.25:8554/stream2");
  });

  it.each([
    ["missing source", undefined, "pico camera snapshot source config is required"],
    [
      "missing id",
      {
        ...snapshotSourceInput,
        id: undefined
      },
      "pico camera snapshot source id is required"
    ],
    [
      "empty username",
      {
        ...snapshotSourceInput,
        username: ""
      },
      "pico camera snapshot source username is required"
    ],
    [
      "invalid host",
      {
        ...snapshotSourceInput,
        host: "https://camera.local"
      },
      "pico camera snapshot source host must be a hostname or IP address"
    ],
    [
      "public host",
      {
        ...snapshotSourceInput,
        host: "example.com"
      },
      "pico camera snapshot source host must be a private or local address"
    ],
    [
      "public IP address",
      {
        ...snapshotSourceInput,
        host: "8.8.8.8"
      },
      "pico camera snapshot source host must be a private or local address"
    ],
    [
      "out-of-range private-looking IP address",
      {
        ...snapshotSourceInput,
        host: "10.256.1.1"
      },
      "pico camera snapshot source host must be a private or local address"
    ],
    [
      "non-numeric private-looking IP address",
      {
        ...snapshotSourceInput,
        host: "10.camera.1.1"
      },
      "pico camera snapshot source host must be a private or local address"
    ],
    [
      "invalid stream",
      {
        ...snapshotSourceInput,
        stream: "../stream2"
      },
      "pico camera snapshot source stream must be a relative RTSP path"
    ],
    [
      "zero port",
      {
        ...snapshotSourceInput,
        port: 0
      },
      "pico camera snapshot source port must be a valid TCP port"
    ],
    [
      "out-of-range port",
      {
        ...snapshotSourceInput,
        port: 99_999
      },
      "pico camera snapshot source port must be a valid TCP port"
    ],
    [
      "string port",
      {
        ...snapshotSourceInput,
        port: "554"
      },
      "pico camera snapshot source port must be a valid TCP port"
    ]
  ])("rejects invalid RTSP source config: %s", (_name, input, expectedMessage) => {
    expect(() => defineRtspSnapshotSource(input)).toThrow(expectedMessage);
  });

  it("rejects concurrent snapshots while one request is in flight", async () => {
    const source = defineRtspSnapshotSource(snapshotSourceInput);
    let resolveSnapshot: ((value: Uint8Array) => void) | undefined;
    let requestCount = 0;
    const transport: RtspSnapshotTransport = {
      captureJpeg(url) {
        requestCount += 1;
        return new Promise<Uint8Array>((resolve) => {
          resolveSnapshot = resolve;
          expect(url).toBe(source.url);
        });
      }
    };
    const client = createRtspSnapshotClient(source, transport);

    const firstSnapshot = client.captureSnapshot();
    await Promise.resolve();
    const secondSnapshot = client.captureSnapshot();
    resolveSnapshot?.(Buffer.from("jpeg-frame"));

    await expect(firstSnapshot).resolves.toEqual({
      ok: true,
      sourceId: "playroom-cam-1",
      mimeType: "image/jpeg",
      frame: Buffer.from("jpeg-frame")
    });
    await expect(secondSnapshot).resolves.toEqual({
      ok: false,
      sourceId: "playroom-cam-1",
      reason: "in_flight",
      message: "previous RTSP snapshot capture is still in flight"
    });
    expect(requestCount).toBe(1);
  });

  it("maps snapshot transport failures to explicit failure reasons", async () => {
    const source = defineRtspSnapshotSource(snapshotSourceInput);
    const transport: RtspSnapshotTransport = {
      captureJpeg() {
        return Promise.reject(new Error("ffmpeg exited"));
      }
    };
    const client = createRtspSnapshotClient(source, transport);

    await expect(client.captureSnapshot()).resolves.toEqual({
      ok: false,
      sourceId: "playroom-cam-1",
      reason: "capture_failed",
      message: "ffmpeg exited"
    });
  });

  it("maps synchronous snapshot transport failures to explicit failure reasons", async () => {
    const source = defineRtspSnapshotSource(snapshotSourceInput);
    const transport: RtspSnapshotTransport = {
      captureJpeg() {
        throw new Error("capture constructor failed");
      }
    };
    const client = createRtspSnapshotClient(source, transport);

    await expect(client.captureSnapshot()).resolves.toEqual({
      ok: false,
      sourceId: "playroom-cam-1",
      reason: "capture_failed",
      message: "capture constructor failed"
    });
  });
});
