import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OUTPUT_DIR } from "./config.js";
import type { InputMedia } from "./schemas.js";

const UPLOAD_ID = /^[a-f0-9]{32}$/;
const SAFE_EXTENSION = /^\.[a-z0-9]{1,8}$/;
const MAX_INPUT_BYTES = 30 * 1024 * 1024;

function extensionFor(name: string, mimeType: string): string {
  const fromName = path.extname(name).toLowerCase();
  if (SAFE_EXTENSION.test(fromName)) return fromName;
  const subtype = mimeType.split("/")[1]?.split(";")[0]?.replace(/[^a-z0-9]/g, "");
  return subtype ? `.${subtype.slice(0, 8)}` : "";
}

export function storeInputMedia(body: Buffer, name: string, mimeType: string): InputMedia {
  if (!Buffer.isBuffer(body) || body.length === 0) throw new Error("The uploaded file is empty.");
  if (body.length > MAX_INPUT_BYTES) throw new Error("Input media must be 30 MB or smaller.");
  const kind = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : null;
  if (!kind) throw new Error("Only image and audio files are supported.");

  const id = randomUUID().replaceAll("-", "");
  const directory = path.join(OUTPUT_DIR, "input_media");
  mkdirSync(directory, { recursive: true });
  const filename = `${id}${extensionFor(name, mimeType)}`;
  writeFileSync(path.join(directory, filename), body);
  return {
    id,
    kind,
    name: path.basename(name).slice(0, 200) || filename,
    mime_type: mimeType,
    url: `/media/input_media/${filename}`,
  };
}

export function inputMediaPath(media: Pick<InputMedia, "id">): string {
  if (!UPLOAD_ID.test(media.id)) throw new Error(`Invalid input media id: ${media.id}`);
  const directory = path.join(OUTPUT_DIR, "input_media");
  const filename = existsSync(directory)
    ? readdirSync(directory).find((entry) => entry === media.id || entry.startsWith(`${media.id}.`))
    : null;
  if (!filename) throw new Error(`Uploaded media ${media.id} is no longer available.`);
  return path.join(directory, filename);
}

