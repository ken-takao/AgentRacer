import assert from "node:assert/strict";
import { test } from "node:test";
import { RaceApiError, raceRetryDelay, requestRaceJson } from "../lib/race-api.ts";

async function withFetch(runFetch: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = runFetch;
  try { await run(); } finally { globalThis.fetch = original; }
}

function checkError(status: number, retryable: boolean, message?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof RaceApiError);
    assert.equal(error.status, status);
    assert.equal(error.retryable, retryable);
    assert.doesNotMatch(error.message, /DOCTYPE|secret-marker|Unexpected token|SyntaxError/);
    if (message) assert.match(error.message, message);
    return true;
  };
}

test("valid JSON responses preserve payload and request headers", async () => {
  await withFetch(async (_url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("x-request-test"), "yes");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json({ id: "race-test" });
  }, async () => {
    assert.deepEqual(await requestRaceJson("/api/races/latest", { headers: { "X-Request-Test": "yes" } }), { id: "race-test" });
  });
});

test("HTML errors and HTML success pages never expose server markup", async () => {
  for (const [status, retryable] of [[503, true], [403, false], [200, true]] as const) {
    await withFetch(async () => new Response("<!DOCTYPE html><p>secret-marker</p>", { status, headers: { "Content-Type": "text/html" } }), async () => {
      await assert.rejects(requestRaceJson("/api/races/test"), checkError(status, retryable));
    });
  }
});

test("known errors are localized and unknown server messages are hidden", async () => {
  await withFetch(async () => Response.json({ error: "Race not found" }, { status: 404 }), async () => {
    await assert.rejects(requestRaceJson("/api/races/test"), checkError(404, false, /レースが見つかりません/));
  });
  await withFetch(async () => Response.json({ error: "secret-marker <!DOCTYPE>" }, { status: 500 }), async () => {
    await assert.rejects(requestRaceJson("/api/races/test"), checkError(500, true));
  });
  // An inherited property must never be mistaken for a localized message.
  await withFetch(async () => Response.json({ error: "constructor" }, { status: 400 }), async () => {
    await assert.rejects(requestRaceJson("/api/races/test"), checkError(400, false));
  });
});

test("JSON MIME suffixes work; malformed JSON and unexpected shapes are rejected", async () => {
  await withFetch(async () => new Response('{"ok":true}', { headers: { "Content-Type": "Application/Problem+JSON; charset=utf-8" } }), async () => {
    assert.deepEqual(await requestRaceJson("/api/races/test"), { ok: true });
  });
  for (const body of ['{"broken":', '<!DOCTYPE html>secret-marker']) {
    await withFetch(async () => new Response(body, { headers: { "Content-Type": "application/json" } }), async () => {
      await assert.rejects(requestRaceJson("/api/races/test"), checkError(200, true));
    });
  }
  await withFetch(async () => Response.json({ state: null }), async () => {
    await assert.rejects(requestRaceJson("/api/races/test", {}, () => false), checkError(200, true));
    await assert.rejects(requestRaceJson("/api/races/test", {}, () => { throw new Error("secret-marker"); }), checkError(200, true));
  });
});

test("Retry-After seconds and HTTP dates are respected and capped", async () => {
  for (const [header, minimum, maximum] of [["7", 7000, 7000], ["999", 30_000, 30_000], [new Date(Date.now() + 20_000).toUTCString(), 18_000, 20_000], ["invalid", 0, 0]] as const) {
    await withFetch(async () => Response.json({ error: "Busy" }, { status: 429, headers: { "Retry-After": header } }), async () => {
      await assert.rejects(requestRaceJson("/api/races/test"), (error: unknown) => {
        checkError(429, true)(error);
        const delay = (error as RaceApiError).retryAfterMs ?? 0;
        assert.ok(delay >= minimum && delay <= maximum, `${header}: ${delay}`);
        return true;
      });
    });
  }
});

test("POST controls preserve authorization and body, and are never retried", async () => {
  let calls = 0;
  const body = JSON.stringify({ player: "red", input: { type: "ready" } });
  await withFetch(async (_url, init) => {
    calls++;
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, body);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
    assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
    return new Response("<!DOCTYPE html>", { status: 503, headers: { "Content-Type": "text/html" } });
  }, async () => {
    await assert.rejects(requestRaceJson("/api/races/test/input", { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" }, body }), checkError(503, true));
    assert.equal(calls, 1);
  });
});

test("network failures are sanitized and retryable", async () => {
  await withFetch(async () => { throw new TypeError("secret-marker internal transport failure"); }, async () => {
    await assert.rejects(requestRaceJson("/api/races/test"), checkError(0, true, /ネットワーク/));
  });
});

test("caller cancellation remains AbortError and is forwarded to the request", async () => {
  const caller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  await withFetch(async (_url, init) => {
    requestSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true }));
  }, async () => {
    const pending = requestRaceJson("/api/races/test", { signal: caller.signal });
    caller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(requestSignal?.aborted, true);
    assert.notEqual(requestSignal, caller.signal);
  });
  await withFetch(async () => { assert.fail("a cancelled request must not start"); }, async () => {
    await assert.rejects(requestRaceJson("/api/races/test", { signal: caller.signal }), { name: "AbortError" });
  });
});

test("a stalled request times out in ten seconds using its own controller", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  await withFetch(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  }), async () => {
    const pending = requestRaceJson("/api/races/test");
    context.mock.timers.tick(10_000);
    await assert.rejects(pending, checkError(408, true, /時間がかかっています/));
  });
});

test("polling backoff caps, respects Retry-After, and resets after success", () => {
  const transient = new RaceApiError("temporary", 503, true);
  assert.deepEqual([1, 2, 3, 4, 5, 100].map(count => raceRetryDelay(count, transient, 500)), [1000, 2000, 4000, 8000, 10_000, 10_000]);
  assert.equal(raceRetryDelay(0, transient, 300), 300);
  assert.equal(raceRetryDelay(1, new RaceApiError("forbidden", 403, false), 500), 15_000);
  assert.equal(raceRetryDelay(1, new RaceApiError("busy", 429, true, 25_000), 500), 25_000);
  assert.equal(raceRetryDelay(1, new RaceApiError("busy", 429, true, 60_000), 500), 30_000);
  assert.equal(raceRetryDelay(2, new Error("network"), 500), 2000);
});
