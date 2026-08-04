import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  closeStackChanMcpSession,
  createStackChanAdapter,
  createStackChanAdapterFromConfig,
  type StackChanMcpClient
} from "../src/modules/stackchan/index.js";

const captureRoot = "/Users/test/.stackchan/captures";
const capturePath = `${captureRoot}/capture_001.jpg`;
const jpeg = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

type CaptureReadObservation = {
  readonly offset: number;
  readonly length: number;
  readonly position: number;
  readonly bytesRead: number;
};

function clientWithResults(results: readonly unknown[]): {
  readonly client: StackChanMcpClient;
  readonly calls: Array<{ readonly name: string; readonly arguments?: Record<string, unknown> }>;
} {
  const calls: Array<{
    readonly name: string;
    readonly arguments?: Record<string, unknown>;
  }> = [];
  let resultIndex = 0;

  return {
    calls,
    client: {
      connect: () => Promise.resolve(),
      callTool: (request) => {
        calls.push(request);
        const result = results[resultIndex];
        resultIndex += 1;
        return Promise.resolve(result);
      },
      close: () => Promise.resolve()
    }
  };
}

function captureResult(path = capturePath): unknown {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          image_path: path,
          size_bytes: jpeg.byteLength,
          question: "pico scene capture"
        })
      }
    ]
  };
}

async function createCanonicalTemporaryDirectory(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

function observedCaptureFileAccess(
  content: Uint8Array,
  readSizes: readonly number[]
): {
  readonly access: {
    readonly realpath: (path: string) => Promise<string>;
    readonly open: (
      path: string,
      flags: number
    ) => Promise<{
      readonly stat: () => Promise<{ readonly isFile: () => boolean }>;
      readonly read: (
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number
      ) => Promise<{ readonly bytesRead: number }>;
      readonly close: () => Promise<void>;
    }>;
    readonly unlink: (path: string) => Promise<void>;
  };
  readonly reads: CaptureReadObservation[];
  readonly openedPath: () => string | undefined;
  readonly openFlags: () => number | undefined;
  readonly statCount: () => number;
  readonly unlinkedPaths: readonly string[];
  readonly closeCount: () => number;
} {
  const reads: CaptureReadObservation[] = [];
  let readIndex = 0;
  let openedPath: string | undefined;
  let openFlags: number | undefined;
  let statCount = 0;
  const unlinkedPaths: string[] = [];
  let closeCount = 0;

  return {
    access: {
      realpath: (path) => Promise.resolve(path),
      open: (path, flags) => {
        openedPath = path;
        openFlags = flags;

        return Promise.resolve({
          stat: () => {
            statCount += 1;
            return Promise.resolve({ isFile: () => true });
          },
          read: (buffer, offset, length, position) => {
            const requestedReadSize = readSizes[readIndex] ?? 0;
            readIndex += 1;
            const bytesRead = Math.min(
              requestedReadSize,
              length,
              Math.max(0, content.byteLength - position)
            );
            buffer.set(content.subarray(position, position + bytesRead), offset);
            reads.push({ offset, length, position, bytesRead });
            return Promise.resolve({ bytesRead });
          },
          close: () => {
            closeCount += 1;
            return Promise.resolve();
          }
        });
      },
      unlink: (path) => {
        unlinkedPaths.push(path);
        return Promise.resolve();
      }
    },
    reads,
    openedPath: () => openedPath,
    openFlags: () => openFlags,
    statCount: () => statCount,
    unlinkedPaths,
    closeCount: () => closeCount
  };
}

function expectBoundedReadObservations(
  observations: ReturnType<typeof observedCaptureFileAccess>,
  maxBytes: number
): void {
  for (const read of observations.reads) {
    expect(read.position).toBe(read.offset);
    expect(read.offset + read.length).toBeLessThanOrEqual(maxBytes + 1);
  }
  expect(observations.reads.reduce((total, read) => total + read.bytesRead, 0)).toBeLessThanOrEqual(
    maxBytes + 1
  );
  expect(observations.openedPath()).toBe(capturePath);
  expect(observations.openFlags()).toBe(
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  expect(observations.statCount()).toBe(1);
  expect(observations.closeCount()).toBe(1);
  expect(observations.unlinkedPaths).toEqual([capturePath]);
}

describe("StackChan adapter", () => {
  it("terminates the Streamable HTTP session before closing the client transport", async () => {
    const calls: string[] = [];

    await closeStackChanMcpSession(
      {
        terminateSession: () => {
          calls.push("terminate");
          return Promise.resolve();
        }
      },
      {
        close: () => {
          calls.push("close");
          return Promise.resolve();
        }
      }
    );

    expect(calls).toEqual(["terminate", "close"]);
  });

  it("contains raw MCP connect, tool, and close errors behind fixed messages", async () => {
    const bearerToken = "Bearer stackchan-secret-token";
    const absoluteCapturePath = "/Users/operator/.stackchan/captures/private.jpg";
    const rawToolBody = '{"jsonrpc":"2.0","error":{"message":"servo exploded"}}';
    const dependencyError = () =>
      new Error(`${bearerToken} ${absoluteCapturePath} ${rawToolBody}`, {
        cause: new Error("nested transport cause")
      });
    const createAdapter = (client: StackChanMcpClient) =>
      createStackChanAdapter({
        client,
        readCaptureFile: () => Promise.resolve(jpeg),
        captureRoot,
        maxFrameBytes: 1024
      });
    const cases: ReadonlyArray<{
      readonly operation: (adapter: ReturnType<typeof createStackChanAdapter>) => Promise<unknown>;
      readonly client: StackChanMcpClient;
      readonly message: string;
    }> = [
      {
        operation: (adapter) => adapter.connect(),
        client: {
          connect: () => Promise.reject(dependencyError()),
          callTool: () => Promise.resolve({}),
          close: () => Promise.resolve()
        },
        message: "StackChan MCP connect failed"
      },
      {
        operation: (adapter) => adapter.captureJpeg(),
        client: {
          connect: () => Promise.resolve(),
          callTool: () => Promise.reject(dependencyError()),
          close: () => Promise.resolve()
        },
        message: "StackChan take_photo failed"
      },
      {
        operation: (adapter) => adapter.getHeadAngles(),
        client: {
          connect: () => Promise.resolve(),
          callTool: () => Promise.reject(dependencyError()),
          close: () => Promise.resolve()
        },
        message: "StackChan get_head_angles failed"
      },
      {
        operation: (adapter) => adapter.moveHead({ yaw: 0, pitch: 35 }),
        client: {
          connect: () => Promise.resolve(),
          callTool: () => Promise.reject(dependencyError()),
          close: () => Promise.resolve()
        },
        message: "StackChan move_head failed"
      },
      {
        operation: (adapter) => adapter.close(),
        client: {
          connect: () => Promise.resolve(),
          callTool: () => Promise.resolve({}),
          close: () => Promise.reject(dependencyError())
        },
        message: "StackChan MCP close failed"
      }
    ];

    for (const testCase of cases) {
      const error = await testCase
        .operation(createAdapter(testCase.client))
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(testCase.message);
      expect((error as Error).cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain(bearerToken);
      expect((error as Error).message).not.toContain(absoluteCapturePath);
      expect((error as Error).message).not.toContain(rawToolBody);
      expect((error as Error).message).not.toContain("nested transport cause");
    }
  });

  it("serializes captures across adapters without blocking a concurrent head move", async () => {
    const operations: string[] = [];
    let releaseFollowCapture: (() => void) | undefined;
    let markFollowCaptureReading: (() => void) | undefined;
    const followCaptureReading = new Promise<void>((resolve) => {
      markFollowCaptureReading = resolve;
    });
    const followCaptureGate = new Promise<void>((resolve) => {
      releaseFollowCapture = resolve;
    });
    const followClient: StackChanMcpClient = {
      connect: () => Promise.resolve(),
      callTool: (request) => {
        operations.push(`follow:${request.name}`);
        return Promise.resolve(request.name === "take_photo" ? captureResult() : { content: [] });
      },
      close: () => Promise.resolve()
    };
    const sceneClient: StackChanMcpClient = {
      connect: () => Promise.resolve(),
      callTool: (request) => {
        operations.push(`scene:${request.name}`);
        return Promise.resolve(captureResult());
      },
      close: () => Promise.resolve()
    };
    const followAdapter = createStackChanAdapter({
      client: followClient,
      readCaptureFile: async () => {
        markFollowCaptureReading?.();
        await followCaptureGate;
        return jpeg;
      },
      captureRoot,
      maxFrameBytes: 1024
    });
    const sceneAdapter = createStackChanAdapter({
      client: sceneClient,
      readCaptureFile: () => Promise.resolve(jpeg),
      captureRoot,
      maxFrameBytes: 1024
    });

    const followCapture = followAdapter.captureJpeg();
    await followCaptureReading;
    const sceneCapture = sceneAdapter.captureJpeg();
    const followMove = followAdapter.moveHead({ yaw: 8, pitch: 35 });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const operationsBeforeCaptureRelease = [...operations];
    releaseFollowCapture?.();
    await Promise.all([followCapture, sceneCapture, followMove]);
    expect(operationsBeforeCaptureRelease).toEqual(["follow:take_photo", "follow:move_head"]);
    expect(operations).toEqual(["follow:take_photo", "follow:move_head", "scene:take_photo"]);
  });

  it("captures one bounded JPEG from the authenticated tool result", async () => {
    const { client, calls } = clientWithResults([captureResult()]);
    const adapter = createStackChanAdapter({
      client,
      readCaptureFile: (path, root, maxBytes) => {
        expect(path).toBe(capturePath);
        expect(root).toBe(captureRoot);
        expect(maxBytes).toBe(1024);
        return Promise.resolve(jpeg);
      },
      captureRoot,
      maxFrameBytes: 1024
    });

    await expect(adapter.captureJpeg()).resolves.toEqual({
      bytes: jpeg,
      mimeType: "image/jpeg"
    });
    expect(calls).toEqual([
      {
        name: "take_photo",
        arguments: {
          question: "pico scene capture"
        }
      }
    ]);
  });

  it("finds capture metadata nested in a text JSON envelope", async () => {
    const nested = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            result: {
              content: [{ type: "text", text: JSON.stringify({ image_path: capturePath }) }]
            }
          })
        }
      ]
    };
    const { client } = clientWithResults([nested]);
    const adapter = createStackChanAdapter({
      client,
      readCaptureFile: () => Promise.resolve(jpeg),
      captureRoot,
      maxFrameBytes: 1024
    });

    await expect(adapter.captureJpeg()).resolves.toEqual({
      bytes: jpeg,
      mimeType: "image/jpeg"
    });
  });

  it("fails closed without leaking capture paths", async () => {
    const cases: ReadonlyArray<{
      readonly result: unknown;
      readonly bytes?: Uint8Array;
      readonly message: string;
    }> = [
      {
        result: { isError: true, content: [{ type: "text", text: capturePath }] },
        message: "StackChan take_photo failed"
      },
      {
        result: { content: [{ type: "text", text: "not json" }] },
        message: "StackChan take_photo returned invalid capture metadata"
      },
      {
        result: captureResult("/tmp/outside.jpg"),
        message: "StackChan capture path is outside the allowed directory"
      },
      {
        result: captureResult(),
        bytes: Uint8Array.from([0, 1, 2]),
        message: "StackChan capture is not a JPEG"
      },
      {
        result: captureResult(),
        bytes: Uint8Array.from([0xff, 0xd8, ...new Array<number>(1024).fill(0), 0xff, 0xd9]),
        message: "StackChan capture exceeds the configured byte limit"
      }
    ];

    for (const testCase of cases) {
      const { client } = clientWithResults([testCase.result]);
      const adapter = createStackChanAdapter({
        client,
        readCaptureFile: () => Promise.resolve(testCase.bytes ?? jpeg),
        captureRoot,
        maxFrameBytes: 1024
      });

      const error = await adapter.captureJpeg().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(testCase.message);
      expect((error as Error).message).not.toContain(capturePath);
    }
  });

  it("rejects an oversized capture through the bounded filesystem reader", async () => {
    const temporaryCaptureRoot = await createCanonicalTemporaryDirectory(
      "pico-stackchan-captures-"
    );
    try {
      const temporaryCapturePath = join(temporaryCaptureRoot, "oversized.jpg");
      const oversizedJpeg = Uint8Array.from([
        0xff,
        0xd8,
        ...new Array<number>(4096).fill(1),
        0xff,
        0xd9
      ]);
      await writeFile(temporaryCapturePath, oversizedJpeg);
      const { client } = clientWithResults([captureResult(temporaryCapturePath)]);
      const adapter = createStackChanAdapter({
        client,
        captureRoot: temporaryCaptureRoot,
        maxFrameBytes: 32
      });

      await expect(adapter.captureJpeg()).rejects.toThrow(
        "StackChan capture exceeds the configured byte limit"
      );
      await expect(access(temporaryCapturePath)).rejects.toThrow();
    } finally {
      await rm(temporaryCaptureRoot, { recursive: true, force: true });
    }
  });

  it("reads an ordinary direct capture from its real allowed root", async () => {
    const temporaryCaptureRoot = await createCanonicalTemporaryDirectory("pico-stackchan-direct-");
    try {
      const temporaryCapturePath = join(temporaryCaptureRoot, "direct.jpg");
      const siblingCapturePath = join(temporaryCaptureRoot, "sibling.jpg");
      await writeFile(temporaryCapturePath, jpeg);
      await writeFile(siblingCapturePath, jpeg);
      const { client } = clientWithResults([captureResult(temporaryCapturePath)]);
      const adapter = createStackChanAdapter({
        client,
        captureRoot: temporaryCaptureRoot,
        maxFrameBytes: jpeg.byteLength
      });

      await expect(adapter.captureJpeg()).resolves.toEqual({
        bytes: jpeg,
        mimeType: "image/jpeg"
      });
      await expect(access(temporaryCapturePath)).rejects.toThrow();
      await expect(access(siblingCapturePath)).resolves.toBeUndefined();
    } finally {
      await rm(temporaryCaptureRoot, { recursive: true, force: true });
    }
  });

  it("rejects a capture symlink whose real target is outside the allowed root", async () => {
    const temporaryDirectory = await createCanonicalTemporaryDirectory("pico-stackchan-symlink-");
    try {
      const temporaryCaptureRoot = join(temporaryDirectory, "captures");
      const outsideRoot = join(temporaryDirectory, "outside");
      const outsidePath = join(outsideRoot, "outside.jpg");
      const linkedCapturePath = join(temporaryCaptureRoot, "linked.jpg");
      await mkdir(temporaryCaptureRoot);
      await mkdir(outsideRoot);
      await writeFile(outsidePath, jpeg);
      await symlink(outsidePath, linkedCapturePath);
      const { client } = clientWithResults([captureResult(linkedCapturePath)]);
      const adapter = createStackChanAdapter({
        client,
        captureRoot: temporaryCaptureRoot,
        maxFrameBytes: 1024
      });

      const error = await adapter.captureJpeg().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("StackChan capture could not be read");
      expect((error as Error).message).not.toContain(linkedCapturePath);
      expect((error as Error).message).not.toContain(outsidePath);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked capture root without deleting its external target", async () => {
    const temporaryDirectory = await createCanonicalTemporaryDirectory(
      "pico-stackchan-root-symlink-"
    );
    try {
      const outsideRoot = join(temporaryDirectory, "outside");
      const linkedCaptureRoot = join(temporaryDirectory, "captures");
      const outsideCapturePath = join(outsideRoot, "capture.jpg");
      const linkedCapturePath = join(linkedCaptureRoot, "capture.jpg");
      await mkdir(outsideRoot);
      await writeFile(outsideCapturePath, jpeg);
      await symlink(outsideRoot, linkedCaptureRoot);
      const { client } = clientWithResults([captureResult(linkedCapturePath)]);
      const adapter = createStackChanAdapter({
        client,
        captureRoot: linkedCaptureRoot,
        maxFrameBytes: 1024
      });

      await expect(adapter.captureJpeg()).rejects.toThrow("StackChan capture could not be read");
      await expect(access(outsideCapturePath)).resolves.toBeUndefined();
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a capture symlink whose target is inside the allowed root", async () => {
    const temporaryCaptureRoot = await createCanonicalTemporaryDirectory(
      "pico-stackchan-inner-symlink-"
    );
    try {
      const targetPath = join(temporaryCaptureRoot, "target.jpg");
      const linkedCapturePath = join(temporaryCaptureRoot, "linked.jpg");
      await writeFile(targetPath, jpeg);
      await symlink(targetPath, linkedCapturePath);
      const { client } = clientWithResults([captureResult(linkedCapturePath)]);
      const adapter = createStackChanAdapter({
        client,
        captureRoot: temporaryCaptureRoot,
        maxFrameBytes: 1024
      });

      await expect(adapter.captureJpeg()).rejects.toThrow("StackChan capture could not be read");
      await expect(access(linkedCapturePath)).resolves.toBeUndefined();
      await expect(access(targetPath)).resolves.toBeUndefined();
    } finally {
      await rm(temporaryCaptureRoot, { recursive: true, force: true });
    }
  });

  it("rejects a nested capture without reading or deleting it", async () => {
    const temporaryCaptureRoot = await createCanonicalTemporaryDirectory("pico-stackchan-nested-");
    try {
      const nestedDirectory = join(temporaryCaptureRoot, "nested");
      const nestedCapturePath = join(nestedDirectory, "capture.jpg");
      await mkdir(nestedDirectory);
      await writeFile(nestedCapturePath, jpeg);
      const { client } = clientWithResults([captureResult(nestedCapturePath)]);
      const adapter = createStackChanAdapter({
        client,
        captureRoot: temporaryCaptureRoot,
        maxFrameBytes: 1024
      });

      await expect(adapter.captureJpeg()).rejects.toThrow(
        "StackChan capture path is outside the allowed directory"
      );
      await expect(access(nestedCapturePath)).resolves.toBeUndefined();
    } finally {
      await rm(temporaryCaptureRoot, { recursive: true, force: true });
    }
  });

  it("rejects and removes a FIFO without reading it", async () => {
    const temporaryCaptureRoot = await createCanonicalTemporaryDirectory("pico-stackchan-fifo-");
    try {
      const fifoPath = join(temporaryCaptureRoot, "capture.jpg");
      execFileSync("mkfifo", [fifoPath]);
      const { client } = clientWithResults([captureResult(fifoPath)]);
      const adapter = createStackChanAdapter({
        client,
        captureRoot: temporaryCaptureRoot,
        maxFrameBytes: 1024
      });

      await expect(adapter.captureJpeg()).rejects.toThrow("StackChan capture could not be read");
      await expect(access(fifoPath)).rejects.toThrow();
    } finally {
      await rm(temporaryCaptureRoot, { recursive: true, force: true });
    }
  });

  it("removes an invalid JPEG after its bounded read", async () => {
    const temporaryCaptureRoot = await createCanonicalTemporaryDirectory(
      "pico-stackchan-invalid-jpeg-"
    );
    try {
      const invalidCapturePath = join(temporaryCaptureRoot, "invalid.jpg");
      await writeFile(invalidCapturePath, Uint8Array.of(1, 2, 3, 4));
      const { client } = clientWithResults([captureResult(invalidCapturePath)]);
      const adapter = createStackChanAdapter({
        client,
        captureRoot: temporaryCaptureRoot,
        maxFrameBytes: 1024
      });

      await expect(adapter.captureJpeg()).rejects.toThrow("StackChan capture is not a JPEG");
      await expect(access(invalidCapturePath)).rejects.toThrow();
    } finally {
      await rm(temporaryCaptureRoot, { recursive: true, force: true });
    }
  });

  it("bounds short reads through EOF to one byte beyond the configured limit", async () => {
    const shortJpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const maxBytes = 7;
    const observations = observedCaptureFileAccess(shortJpeg, [1, 2, 1, 0]);
    const { client } = clientWithResults([captureResult()]);
    const adapter = createStackChanAdapter({
      client,
      captureFileAccess: observations.access,
      captureRoot,
      maxFrameBytes: maxBytes
    });

    await expect(adapter.captureJpeg()).resolves.toEqual({
      bytes: shortJpeg,
      mimeType: "image/jpeg"
    });
    expectBoundedReadObservations(observations, maxBytes);
  });

  it("probes EOF without reading past an exact byte limit", async () => {
    const maxBytes = jpeg.byteLength;
    const observations = observedCaptureFileAccess(jpeg, [2, 1, 4, 0]);
    const { client } = clientWithResults([captureResult()]);
    const adapter = createStackChanAdapter({
      client,
      captureFileAccess: observations.access,
      captureRoot,
      maxFrameBytes: maxBytes
    });

    await expect(adapter.captureJpeg()).resolves.toEqual({
      bytes: jpeg,
      mimeType: "image/jpeg"
    });
    expectBoundedReadObservations(observations, maxBytes);
  });

  it("stops after reading one byte beyond the configured limit", async () => {
    const maxBytes = jpeg.byteLength;
    const oversizedJpeg = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]);
    const observations = observedCaptureFileAccess(oversizedJpeg, [1, 2, 5]);
    const { client } = clientWithResults([captureResult()]);
    const adapter = createStackChanAdapter({
      client,
      captureFileAccess: observations.access,
      captureRoot,
      maxFrameBytes: maxBytes
    });

    await expect(adapter.captureJpeg()).rejects.toThrow(
      "StackChan capture exceeds the configured byte limit"
    );
    expectBoundedReadObservations(observations, maxBytes);
    expect(observations.reads.reduce((total, read) => total + read.bytesRead, 0)).toBe(
      maxBytes + 1
    );
  });

  it("replaces capture reader failures with a fixed path-free error", async () => {
    const bearerToken = "stackchan-regression-token";
    const { client } = clientWithResults([captureResult()]);
    const adapter = createStackChanAdapter({
      client,
      readCaptureFile: () =>
        Promise.reject(new Error(`ENOENT: cannot read ${capturePath} with ${bearerToken}`)),
      captureRoot,
      maxFrameBytes: 1024
    });

    const error = await adapter.captureJpeg().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("StackChan capture could not be read");
    expect((error as Error).message).not.toContain(capturePath);
    expect((error as Error).message).not.toContain(bearerToken);
    expect((error as Error).message).not.toContain("ENOENT");
  });

  it("attempts close and unlink and contains either cleanup failure", async () => {
    const cleanupCases = [
      { closeFails: true, unlinkFails: false },
      { closeFails: false, unlinkFails: true }
    ] as const;

    for (const testCase of cleanupCases) {
      let closeCount = 0;
      let unlinkCount = 0;
      const { client } = clientWithResults([captureResult()]);
      const adapter = createStackChanAdapter({
        client,
        captureFileAccess: {
          realpath: (path) => Promise.resolve(path),
          open: () =>
            Promise.resolve({
              stat: () => Promise.resolve({ isFile: () => true }),
              read: (buffer) => {
                buffer.set(jpeg);
                return Promise.resolve({ bytesRead: jpeg.byteLength });
              },
              close: () => {
                closeCount += 1;
                return testCase.closeFails
                  ? Promise.reject(new Error(`close leaked ${capturePath}`))
                  : Promise.resolve();
              }
            }),
          unlink: () => {
            unlinkCount += 1;
            return testCase.unlinkFails
              ? Promise.reject(new Error(`unlink leaked ${capturePath}`))
              : Promise.resolve();
          }
        },
        captureRoot,
        maxFrameBytes: 1024
      });

      const error = await adapter.captureJpeg().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("StackChan capture could not be read");
      expect((error as Error).message).not.toContain(capturePath);
      expect({ closeCount, unlinkCount }).toEqual({ closeCount: 1, unlinkCount: 1 });
    }
  });

  it("parses head angles and sends bounded integer moves", async () => {
    const { client, calls } = clientWithResults([
      {
        content: [{ type: "text", text: JSON.stringify({ yaw: 12, pitch: 34 }) }]
      },
      {
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }]
      },
      {
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }]
      }
    ]);
    const adapter = createStackChanAdapter({
      client,
      readCaptureFile: () => Promise.resolve(jpeg),
      captureRoot,
      maxFrameBytes: 1024
    });

    await expect(adapter.getHeadAngles()).resolves.toEqual({ yaw: 12, pitch: 34 });
    await adapter.moveHead({ yaw: -20, pitch: 40 });
    await adapter.moveHead({ yaw: 12, pitch: 34 }, { speedDps: 90 });
    expect(calls).toEqual([
      { name: "get_head_angles", arguments: {} },
      { name: "move_head", arguments: { yaw: -20, pitch: 40 } },
      { name: "move_head", arguments: { yaw: 12, pitch: 34, speed: 90 } }
    ]);
    await expect(adapter.moveHead({ yaw: 90.5, pitch: 40 })).rejects.toThrow(
      "StackChan yaw must be an integer from -90 through 90"
    );
    await expect(adapter.moveHead({ yaw: 0, pitch: 4 })).rejects.toThrow(
      "StackChan pitch must be an integer from 5 through 85"
    );
    await expect(adapter.moveHead({ yaw: 0, pitch: 35 }, { speedDps: 14 })).rejects.toThrow(
      "StackChan speedDps must be an integer from 15 through 240"
    );
    await expect(adapter.moveHead({ yaw: 0, pitch: 35 }, { speedDps: 241 })).rejects.toThrow(
      "StackChan speedDps must be an integer from 15 through 240"
    );
  });

  it("rejects malformed head results and MCP tool errors", async () => {
    const { client } = clientWithResults([
      { content: [{ type: "text", text: JSON.stringify({ yaw: 0 }) }] },
      { isError: true, content: [{ type: "text", text: "servo detail" }] }
    ]);
    const adapter = createStackChanAdapter({
      client,
      readCaptureFile: () => Promise.resolve(jpeg),
      captureRoot,
      maxFrameBytes: 1024
    });

    await expect(adapter.getHeadAngles()).rejects.toThrow(
      "StackChan get_head_angles returned invalid pose"
    );
    await expect(adapter.moveHead({ yaw: 0, pitch: 35 })).rejects.toThrow(
      "StackChan move_head failed"
    );
  });

  it("requires a non-empty configured bearer token without exposing it", () => {
    const config = {
      mcpUrl: "http://127.0.0.1:18767/mcp",
      bearerTokenEnv: "STACKCHAN_TOKEN",
      timeoutMs: 10_000,
      maxFrameBytes: 1024,
      streamFps: 20,
      streamJpegQuality: 60,
      follow: { enabled: false as const }
    };

    expect(() =>
      createStackChanAdapterFromConfig(config, {
        STACKCHAN_TOKEN: " "
      })
    ).toThrow("StackChan bearer token is missing");
  });

  it("leases the camera stream and advances latest-frame sequence reads", async () => {
    const { client, calls } = clientWithResults([
      { content: [{ type: "text", text: '{"running":true}' }] },
      { content: [{ type: "text", text: '{"running":false}' }] }
    ]);
    const requestedSequences: Array<number | undefined> = [];
    const adapter = createStackChanAdapter({
      client,
      captureRoot,
      maxFrameBytes: 1024,
      stream: {
        fps: 20,
        quality: 60,
        readLatestFrame: (afterSequence) => {
          requestedSequences.push(afterSequence);
          return Promise.resolve({
            sequence: afterSequence === undefined ? 41 : 42,
            capturedAtMs: 1000,
            encodedAtMs: 1010,
            receivedAtMs: 1020,
            bytes: jpeg,
            mimeType: "image/jpeg" as const
          });
        }
      }
    });

    await adapter.connect();
    await expect(adapter.captureJpeg()).resolves.toEqual({
      sequence: 41,
      capturedAtMs: 1000,
      encodedAtMs: 1010,
      receivedAtMs: 1020,
      bytes: jpeg,
      mimeType: "image/jpeg"
    });
    await expect(adapter.captureJpeg()).resolves.toEqual({
      sequence: 42,
      capturedAtMs: 1000,
      encodedAtMs: 1010,
      receivedAtMs: 1020,
      bytes: jpeg,
      mimeType: "image/jpeg"
    });
    await adapter.close();

    expect(requestedSequences).toEqual([undefined, 41]);
    expect(calls).toEqual([
      {
        name: "camera_stream",
        arguments: { action: "start", fps: 20, quality: 60 }
      },
      {
        name: "camera_stream",
        arguments: { action: "stop" }
      }
    ]);
  });

  it("rejects the gateway camera stream error envelope even when MCP isError is false", async () => {
    const { client } = clientWithResults([
      {
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "device does not advertise camera streaming" })
          }
        ]
      }
    ]);
    const adapter = createStackChanAdapter({
      client,
      captureRoot,
      maxFrameBytes: 1024,
      stream: {
        fps: 20,
        quality: 60,
        readLatestFrame: () => Promise.reject(new Error("must not capture"))
      }
    });

    await expect(adapter.connect()).rejects.toThrow("StackChan camera stream start failed");
  });

  it("contains latest-frame and stream release failures behind fixed errors", async () => {
    const dependencyError = new Error("http://127.0.0.1:18767/camera/latest token=private");
    const { client } = clientWithResults([
      { content: [] },
      { isError: true, content: [{ type: "text", text: "private" }] },
      { isError: true, content: [{ type: "text", text: "private" }] },
      { isError: true, content: [{ type: "text", text: "private" }] }
    ]);
    const adapter = createStackChanAdapter({
      client,
      captureRoot,
      maxFrameBytes: 1024,
      stream: {
        fps: 20,
        quality: 60,
        readLatestFrame: () => Promise.reject(dependencyError)
      }
    });

    await adapter.connect();
    await expect(adapter.captureJpeg()).rejects.toThrow("StackChan latest camera frame failed");
    await expect(adapter.close()).rejects.toThrow("StackChan MCP close failed");
  });

  it("retries a transient camera stream release before closing the MCP client", async () => {
    let stopCalls = 0;
    let clientClosed = false;
    const client: StackChanMcpClient = {
      connect: () => Promise.resolve(),
      callTool: (request) => {
        if (request.name === "camera_stream" && request.arguments?.action === "stop") {
          stopCalls += 1;
          return Promise.resolve(
            stopCalls === 1
              ? { isError: true, content: [{ type: "text", text: "temporary" }] }
              : { content: [] }
          );
        }
        return Promise.resolve({ content: [] });
      },
      close: () => {
        clientClosed = true;
        return Promise.resolve();
      }
    };
    const adapter = createStackChanAdapter({
      client,
      captureRoot,
      maxFrameBytes: 1024,
      stream: {
        fps: 20,
        quality: 60,
        readLatestFrame: () => Promise.reject(new Error("must not capture"))
      }
    });

    await adapter.connect();
    await expect(adapter.close()).resolves.toBeUndefined();

    expect(stopCalls).toBe(2);
    expect(clientClosed).toBe(true);
  });

  it("reads authenticated latest frames from the configured gateway origin", async () => {
    const { client } = clientWithResults([{ content: [] }, { content: [] }]);
    const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
    let sequence = 70;
    const adapter = createStackChanAdapterFromConfig(
      {
        mcpUrl: "http://127.0.0.1:18767/mcp",
        bearerTokenEnv: "STACKCHAN_TOKEN",
        timeoutMs: 10_000,
        maxFrameBytes: 1024,
        streamFps: 20,
        streamJpegQuality: 60,
        follow: { enabled: false }
      },
      { STACKCHAN_TOKEN: "private-camera-token" },
      {
        client,
        fetch: (input, init) => {
          if (!(input instanceof URL)) {
            throw new Error("expected URL input");
          }
          const url = new URL(input);
          requests.push({
            url: url.toString(),
            authorization: new Headers(init?.headers).get("authorization")
          });
          sequence += 1;
          return Promise.resolve(
            new Response(jpeg, {
              status: 200,
              headers: {
                "content-type": "image/jpeg",
                "content-length": String(jpeg.byteLength),
                "x-camera-sequence": String(sequence),
                "x-camera-captured-at-ms": "1000",
                "x-camera-encoded-at-ms": "1010",
                "x-camera-received-at-ms": "1020"
              }
            })
          );
        }
      }
    );

    await adapter.connect();
    await adapter.captureJpeg();
    await adapter.captureJpeg();
    await adapter.close();

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18767/camera/latest?timeout_ms=10000",
        authorization: "Bearer private-camera-token"
      },
      {
        url: "http://127.0.0.1:18767/camera/latest?after_sequence=71&timeout_ms=10000",
        authorization: "Bearer private-camera-token"
      }
    ]);
  });

  it("rejects oversized latest-frame bodies before retaining them", async () => {
    const { client } = clientWithResults([{ content: [] }, { content: [] }]);
    const adapter = createStackChanAdapterFromConfig(
      {
        mcpUrl: "http://127.0.0.1:18767/mcp",
        bearerTokenEnv: "STACKCHAN_TOKEN",
        timeoutMs: 10_000,
        maxFrameBytes: 4,
        streamFps: 20,
        streamJpegQuality: 60,
        follow: { enabled: false }
      },
      { STACKCHAN_TOKEN: "private-camera-token" },
      {
        client,
        fetch: () =>
          Promise.resolve(
            new Response(jpeg, {
              status: 200,
              headers: {
                "content-type": "image/jpeg",
                "content-length": String(jpeg.byteLength),
                "x-camera-sequence": "1",
                "x-camera-captured-at-ms": "1000",
                "x-camera-encoded-at-ms": "1010",
                "x-camera-received-at-ms": "1020"
              }
            })
          )
      }
    );

    await adapter.connect();
    await expect(adapter.captureJpeg()).rejects.toThrow("StackChan latest camera frame failed");
    await adapter.close();
  });
});
