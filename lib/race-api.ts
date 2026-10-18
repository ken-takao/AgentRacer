/** JSON transport shared by the race screens. It never retries a control POST. */
export class RaceApiError extends Error {
  status: number;
  retryable: boolean;
  retryAfterMs?: number;

  constructor(message: string, status: number, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.name = "RaceApiError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

const knownErrors: Record<string, string> = {
  "Unknown route": "進路はLEFTかRIGHTを選んでください。",
  "Unknown junction": "この分岐は見つかりません。画面を更新してください。",
  "The route is locked after entering the junction": "分岐に入りました。次の分岐で進路を選んでください。",
  "The race simulation could not advance": "レースを進められませんでした。オペレーター画面から新しいレースを開始してください。",
  "Race not found": "レースが見つかりません。URLを確認してください。",
  "Player link expired": "参加用URLの有効期限が切れています。新しいレースに参加してください。",
  "Player authentication required": "参加用URLから開き直してください。",
  "Wrong player link": "参加用URLが正しくありません。オペレーターから受け取ったURLを確認してください。",
  "Operator authentication required": "オペレーターの認証を確認してください。",
  "Operator is not configured": "オペレーターの設定を確認しています。しばらくしてから再試行してください。",
  "Database unavailable": "レースのサーバーに一時的に接続できません。再接続しています。",
  "Another control arrived at the same time. Please retry.": "操作が重なりました。もう一度操作してください。",
  "The race was cancelled": "このレースは中止されました。",
  "The race has finished": "このレースは終了しました。",
  "The race has already started": "このレースはすでに始まっています。",
  "The race is no longer in the lobby": "このレースは準備期間を終了しています。",
  "Join the race before using controls": "参加用URLからレースに接続してから操作してください。",
  "Invalid player or input": "操作を送信できませんでした。もう一度操作してください。",
  "Unknown control": "操作を送信できませんでした。もう一度操作してください。",
  "Lane must be 0, 1, or 2": "選択したレーンを確認してください。",
  "Unknown speed mode": "選択した速度を確認してください。",
};

function statusMessage(status: number): string {
  if (status === 401 || status === 403) return "レースへのアクセスが拒否されました。少し待ってから再試行してください。";
  if (status === 404) return "レースが見つかりません。URLを確認してください。";
  if (status === 410) return "このURLの有効期限が切れています。新しいレースに参加してください。";
  if (status === 429) return "接続が混み合っています。少し待ってから再接続します。";
  if (status === 408 || status === 504) return "サーバーからの応答に時間がかかっています。再接続しています。";
  if (status >= 500) return "レースのサーバーに一時的に接続できません。再接続しています。";
  if (status >= 400) return "リクエストを受け付けられませんでした。URLや操作を確認してください。";
  return "レースデータを正しく受信できませんでした。再接続しています。";
}

function readRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.min(30_000, Math.max(0, delay)) : undefined;
}

function responseError(response: Response, payload?: unknown): RaceApiError {
  const known = payload && typeof payload === "object" && "error" in payload
    && typeof payload.error === "string" && Object.hasOwn(knownErrors, payload.error)
    ? knownErrors[payload.error] : undefined;
  const status = response.status;
  const retryable = response.ok || status === 408 || status === 425 || status === 429 || status >= 500;
  return new RaceApiError(known ?? statusMessage(status), status, retryable, readRetryAfter(response.headers.get("retry-after")));
}

export async function requestRaceJson<T>(
  url: string,
  init: RequestInit = {},
  validate?: (value: unknown) => boolean,
): Promise<T> {
  const caller = init.signal;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(caller?.reason);
  if (caller?.aborted) throw caller.reason ?? new DOMException("Aborted", "AbortError");
  caller?.addEventListener("abort", abortFromCaller, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Timed out", "TimeoutError"));
  }, 10_000);

  try {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    const method = (init.method ?? "GET").toUpperCase();
    const response = await fetch(url, {
      ...init,
      ...(method === "GET" ? { cache: "no-store" as const } : {}),
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    if (contentType !== "application/json" && !/^application\/[\w.+-]+\+json$/.test(contentType)) {
      throw responseError(response);
    }
    let payload: unknown;
    try { payload = JSON.parse(text); }
    catch { throw responseError(response); }
    if (!response.ok) throw responseError(response, payload);
    if (validate) {
      let valid = false;
      try { valid = validate(payload); } catch { /* Treat validation failures as invalid data. */ }
      if (!valid) throw responseError(response);
    }
    return payload as T;
  } catch (error) {
    if (caller?.aborted) throw caller.reason ?? new DOMException("Aborted", "AbortError");
    if (timedOut) throw new RaceApiError(statusMessage(408), 408, true);
    if (error instanceof RaceApiError) throw error;
    throw new RaceApiError("ネットワークに接続できません。再接続しています。", 0, true);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", abortFromCaller);
  }
}

/** Recovery polling remains possible after an access or missing-race response. */
export function raceRetryDelay(failures: number, error: unknown, normalInterval: number): number {
  if (failures <= 0) return normalInterval;
  if (error instanceof RaceApiError && !error.retryable) return 15_000;
  const count = Number.isFinite(failures) ? Math.max(1, failures) : 5;
  const backoff = Math.min(10_000, 1000 * 2 ** Math.min(count - 1, 4));
  const retryAfter = error instanceof RaceApiError && Number.isFinite(error.retryAfterMs)
    ? Math.max(0, Math.min(30_000, error.retryAfterMs!)) : 0;
  return Math.max(backoff, retryAfter);
}
