export type IrodoriStreamResponseOptions = {
  readonly chunks?: readonly Uint8Array[];
  readonly elapsed?: number | readonly number[];
  readonly splitAt?: number;
};

export function buildIrodoriStreamResponse(
  wav: ArrayBuffer | Uint8Array,
  options: IrodoriStreamResponseOptions = {}
): Response {
  const wavBytes = wav instanceof Uint8Array ? wav : new Uint8Array(wav);
  const chunks = buildChunks(wavBytes, options);
  const frames: Uint8Array[] = [
    Buffer.from(`${JSON.stringify({ kind: "handshake", v: 1, max_chunk_size: 4 * 1024 * 1024 })}\n`)
  ];

  for (const [index, chunk] of chunks.entries()) {
    frames.push(
      Buffer.from(
        `${JSON.stringify({
          kind: "chunk",
          v: 1,
          index,
          nbytes: chunk.byteLength,
          final: index === chunks.length - 1,
          elapsed: readElapsed(options.elapsed, index)
        })}\n`
      ),
      chunk
    );
  }

  return new Response(bytesToArrayBuffer(Buffer.concat(frames)), {
    headers: {
      "content-type": "application/octet-stream"
    }
  });
}

function buildChunks(
  wavBytes: Uint8Array,
  options: IrodoriStreamResponseOptions
): readonly Uint8Array[] {
  if (options.chunks !== undefined) {
    return options.chunks;
  }

  const splitAt = options.splitAt ?? wavBytes.byteLength;
  return splitAt < wavBytes.byteLength
    ? [wavBytes.slice(0, splitAt), wavBytes.slice(splitAt)]
    : [wavBytes];
}

function readElapsed(elapsed: number | readonly number[] | undefined, index: number): number {
  return typeof elapsed === "number" ? elapsed : (elapsed?.[index] ?? 0.25);
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);

  return arrayBuffer;
}
