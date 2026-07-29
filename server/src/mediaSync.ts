import { execaSync } from "execa";

export function probeMediaDurationSync(filePath: string): number {
  const result = execaSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    { reject: false },
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "no command output";
    throw new Error(`ffprobe duration failed for ${filePath}:\n${detail}`);
  }
  const duration = Number.parseFloat(result.stdout.trim());
  if (!(duration > 0)) {
    throw new Error(`Media has invalid duration ${duration}: ${filePath}`);
  }
  return duration;
}
