import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export async function writePrivateJsonReport(path: string, report: unknown): Promise<void> {
  const outputPath = resolve(path);
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let replaced = false;

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(report, undefined, 2)}\n`, "utf8");
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, outputPath);
    replaced = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!replaced) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
