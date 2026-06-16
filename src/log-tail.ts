import { closeSync, openSync, readSync, statSync } from "fs";

export interface ReadTailLinesOptions {
  maxBytes?: number;
  maxLines?: number;
}

export const DEFAULT_TAIL_MAX_BYTES = 2 * 1024 * 1024;

export function readTailLines(
  filePath: string,
  opts: ReadTailLinesOptions = {}
): string[] {
  if (opts.maxLines !== undefined && opts.maxLines <= 0) return [];

  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return [];
  }

  if (size <= 0) return [];

  const boundedMaxBytes =
    opts.maxBytes !== undefined && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
      ? Math.floor(opts.maxBytes)
      : DEFAULT_TAIL_MAX_BYTES;
  const bytesToRead = Math.min(size, boundedMaxBytes);
  const startOffset = Math.max(0, size - bytesToRead);
  const buffer = Buffer.alloc(bytesToRead);
  let fd: number | undefined;
  let bytesRead = 0;

  try {
    fd = openSync(filePath, "r");
    bytesRead = readSync(fd, buffer, 0, bytesToRead, startOffset);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }

  if (bytesRead <= 0) return [];

  const lines = buffer.subarray(0, bytesRead).toString("utf-8").split(/\r?\n/);
  if (startOffset > 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  if (opts.maxLines !== undefined) return lines.slice(-opts.maxLines);
  return lines;
}
