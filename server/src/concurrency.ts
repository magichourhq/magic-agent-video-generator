import { ENV } from "./config.js";

type QueuedTask<T> = {
  label: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

export class AsyncLimiter {
  private active = 0;
  private readonly queue: Array<QueuedTask<any>> = [];

  constructor(
    readonly name: string,
    readonly limit: number,
  ) {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error(`Invalid concurrency limit for ${name}: ${limit}`);
    }
  }

  run<T>(label: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ label, run: task, resolve, reject });
      this.drain();
    });
  }

  snapshot() {
    return {
      name: this.name,
      active: this.active,
      queued: this.queue.length,
      limit: this.limit,
      queued_labels: this.queue.map((task) => task.label),
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.active += 1;
      void task
        .run()
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active = Math.max(0, this.active - 1);
          this.drain();
        });
    }
  }
}

function envLimit(name: string, fallback: number): number {
  const value = Number.parseInt(String(ENV[name] ?? ""), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const providerConcurrency = {
  humeTts: new AsyncLimiter("hume_tts", envLimit("HUME_TTS_CONCURRENCY", 1)),
  fishTts: new AsyncLimiter("fish_tts", envLimit("FISH_TTS_CONCURRENCY", 2)),
  elevenLabsTts: new AsyncLimiter("elevenlabs_tts", envLimit("ELEVENLABS_TTS_CONCURRENCY", 2)),
  magicHourSubmit: new AsyncLimiter("magic_hour_submit", envLimit("MAGIC_HOUR_SUBMIT_CONCURRENCY", 5)),
};

export function providerConcurrencySnapshot() {
  return {
    hume_tts: providerConcurrency.humeTts.snapshot(),
    fish_tts: providerConcurrency.fishTts.snapshot(),
    elevenlabs_tts: providerConcurrency.elevenLabsTts.snapshot(),
    magic_hour_submit: providerConcurrency.magicHourSubmit.snapshot(),
  };
}

