import { createHash } from "node:crypto";

/** Deterministic uniform [0,1) from the given parts. */
export function seededUnit(...parts: string[]): number {
  return createHash("sha256").update(parts.join("|")).digest().readUInt32BE(0) / 2 ** 32;
}

export function seededBetween(lo: number, hi: number, ...parts: string[]): number {
  return lo + (hi - lo) * seededUnit(...parts);
}
