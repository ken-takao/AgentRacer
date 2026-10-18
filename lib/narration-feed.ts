/** Public, credential-free contract between the race broadcaster and spectators. */
export type NarrationChunk = { seq: number; url: string; startMs: number; durationMs: number };
export type NarrationCaption = { id: string; text: string; startMs: number; endMs: number };
export type NarrationFeed = {
  version: 1; raceId: string; generationId: string; revision: number;
  status: "connecting" | "live" | "ended" | "error";
  voice: string; sampleRate: 24000; startedAt: number; updatedAt: number;
  chunks: NarrationChunk[]; captions: NarrationCaption[]; error?: string;
};

export function validGeneration(value: string) {
  return /^[a-zA-Z0-9_-]{8,80}$/.test(value);
}

function bounded(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** Rebuild from an allowlist: neither arbitrary audio URLs nor private fields are published. */
export function sanitizeNarrationFeed(input: unknown, raceId: string): NarrationFeed {
  const data = input as NarrationFeed;
  if (!data || data.version !== 1 || data.raceId !== raceId || !validGeneration(data.generationId ?? "") ||
    !["connecting", "live", "ended", "error"].includes(data.status) || data.sampleRate !== 24000 ||
    !bounded(data.startedAt, 1, 9e15) || !bounded(data.updatedAt, data.startedAt, 9e15) ||
    !Array.isArray(data.chunks) || data.chunks.length > 120 || !Array.isArray(data.captions) || data.captions.length > 160) {
    throw new Error("Invalid narration feed");
  }
  const revision = data.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > 1000000) throw new Error("Invalid narration revision");
  let lastSeq = -1;
  let lastEnd = -1;
  const chunks = data.chunks.map(chunk => {
    if (!chunk || !Number.isSafeInteger(chunk.seq) || chunk.seq <= lastSeq || chunk.seq > 100000 ||
      !bounded(chunk.startMs, 0, 900000) || !bounded(chunk.durationMs, 0.01, 5000) || chunk.startMs < lastEnd - 2) {
      throw new Error("Invalid narration audio timeline");
    }
    lastSeq = chunk.seq;
    lastEnd = chunk.startMs + chunk.durationMs;
    return { seq: chunk.seq, startMs: chunk.startMs, durationMs: chunk.durationMs,
      url: `/api/races/${raceId}/narration/audio/${data.generationId}/${chunk.seq}` };
  });
  const ids = new Set<string>();
  const captions = data.captions.map(caption => {
    if (!caption || typeof caption.id !== "string" || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(caption.id) || ids.has(caption.id) ||
      typeof caption.text !== "string" || caption.text.length > 1600 ||
      !bounded(caption.startMs, 0, 900000) || !bounded(caption.endMs, caption.startMs, 910000)) {
      throw new Error("Invalid narration captions");
    }
    ids.add(caption.id);
    return { id: caption.id, text: caption.text, startMs: caption.startMs, endMs: caption.endMs };
  });
  return { version: 1, raceId, generationId: data.generationId, revision, status: data.status,
    voice: String(data.voice ?? "marin").slice(0, 40), sampleRate: 24000,
    startedAt: data.startedAt, updatedAt: data.updatedAt, chunks, captions,
    ...(data.status === "error" ? { error: "実況音声への接続が途切れました。レースは続行しています。" } : {}) };
}

/** Only accept the canonical PCM WAV emitted by our broadcaster. */
export function isNarrationWav(buffer: ArrayBuffer) {
  if (buffer.byteLength < 46 || buffer.byteLength > 240044 || buffer.byteLength % 2) return false;
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
  return ascii(0, "RIFF") && ascii(8, "WAVE") && ascii(12, "fmt ") && ascii(36, "data") &&
    view.getUint32(4, true) === buffer.byteLength - 8 && view.getUint32(16, true) === 16 &&
    view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1 && view.getUint32(24, true) === 24000 &&
    view.getUint32(28, true) === 48000 && view.getUint16(32, true) === 2 && view.getUint16(34, true) === 16 &&
    view.getUint32(40, true) === buffer.byteLength - 44;
}
