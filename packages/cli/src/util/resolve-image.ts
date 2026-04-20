import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Read a local file and return a data URI, or return a URL as-is */
export function resolveImage(input: string): string | null {
  // Already a URL
  if (input.startsWith("http://") || input.startsWith("https://") || input.startsWith("data:")) {
    return input;
  }
  // Local file — read and convert to base64 data URI
  const abs = resolve(input);
  if (!existsSync(abs)) return null;
  const buf = readFileSync(abs);
  const ext = abs.split(".").pop()?.toLowerCase() ?? "";
  const mime =
    ext === "png" ? "image/png"
    : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
    : ext === "gif" ? "image/gif"
    : ext === "webp" ? "image/webp"
    : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
