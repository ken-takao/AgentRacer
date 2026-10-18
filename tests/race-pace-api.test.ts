import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import type { RaceState } from "../lib/race-engine.ts";

const routeFile = new URL("../app/api/races/[[...path]]/route.ts", import.meta.url);
const source = (await readFile(routeFile, "utf8"))
  .replace("import { env } from 'cloudflare:workers';", "const env = globalThis.__paceTestEnv;")
  .replace(/from '(\.\.[^']+)'/g, (_, path) => `from '${new URL(path + ".ts", routeFile).href}'`);
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
type Stored = { id: string; state: string; version: number; expires_at: number; red_hash: string; blue_hash: string };

async function harness() {
  const rows = new Map<string, Stored>();
  const env = { RACE_ADMIN_KEY: "pace-test-admin", DB: {
    prepare(sql: string) {
      return {
        sql, values: [] as unknown[],
        bind(...values: unknown[]) { this.values = values; return this; },
        async first() { return rows.get(this.values[0] as string) ?? null; },
        async all() { return { results: [] }; },
        async run() {
          assert.match(sql, /UPDATE races SET state/);
          const row = rows.get(this.values[1] as string)!;
          if (row.version !== this.values[2]) return { meta: { changes: 0 } };
          row.state = this.values[0] as string; row.version++;
          return { meta: { changes: 1 } };
        },
      };
    },
    async batch(statements: { sql: string; values: unknown[] }[]) {
      for (const statement of statements) {
        if (!statement.sql.startsWith("INSERT INTO races")) continue;
        const [id, , expires_at, version, state, red_hash, blue_hash] = statement.values;
        rows.set(id as string, { id: id as string, expires_at: expires_at as number, version: version as number, state: state as string, red_hash: red_hash as string, blue_hash: blue_hash as string });
      }
      return statements.map(() => ({ success: true }));
    },
  } };
  (globalThis as any).__paceTestEnv = env;
  const route = await import("data:text/javascript;base64," + Buffer.from(compiled + "\n//" + crypto.randomUUID()).toString("base64"));
  delete (globalThis as any).__paceTestEnv;
  const post = async (body: unknown, token = "pace-test-admin", path: string[] = []) => {
    const response = await route.POST(new Request(`https://race.test/api/races/${path.join("/")}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ path }) }) as Response;
    return { status: response.status, data: await response.json() as any };
  };
  return { rows, post, state: (id: string) => JSON.parse(rows.get(id)!.state) as RaceState };
}

test("admin creation alone can explicitly persist sprint; omitted pace remains classic", async () => {
  const h = await harness();
  const classic = await h.post({ seed: "same-course" });
  const sprint = await h.post({ seed: "same-course", pace: "sprint-2x" });
  assert.equal(classic.status, 201); assert.equal(sprint.status, 201);
  assert.equal(Object.hasOwn(h.state(classic.data.id), "pace"), false);
  assert.equal(h.state(sprint.data.id).pace, "sprint-2x");
  assert.deepEqual(h.state(sprint.data.id).course, h.state(classic.data.id).course);
});

test("unauthenticated and driver-key callers cannot create a sprint; invalid pace never writes", async () => {
  const h = await harness();
  const created = await h.post({});
  const driverToken = new URL(created.data.playerUrls.red).hash.slice(1);
  for (const token of ["", driverToken, "wrong-admin"]) {
    assert.equal((await h.post({ pace: "sprint-2x" }, token)).status, 401);
  }
  for (const pace of ["classic", "turbo", "sprint-3x", 2, null, {}, ["sprint-2x"]]) {
    assert.equal((await h.post({ pace })).status, 400);
  }
  assert.equal(h.rows.size, 1);
});

test("driver inputs cannot change an existing race's pace", async () => {
  const h = await harness();
  for (const requested of [undefined, "sprint-2x"]) {
    const created = await h.post({ pace: requested });
    const id = created.data.id, driverToken = new URL(created.data.playerUrls.red).hash.slice(1);
    const response = await h.post({ player: "red", input: { type: "join", pace: requested ? null : "sprint-2x" }, pace: requested ? null : "sprint-2x" }, driverToken, [id, "input"]);
    assert.equal(response.status, 200);
    assert.equal(h.state(id).pace, requested);
    assert.equal(response.data.state.paceRules.speedMultiplier, requested ? 2 : 1);
  }
});

test("new admin-created races persist ghost by default and allow explicit solid rules", async () => {
  const h = await harness();
  for (const requested of [undefined, "ghost", "solid"] as const) {
    const created = await h.post({ carInteraction: requested });
    assert.equal(created.status, 201);
    assert.equal(h.state(created.data.id).carInteraction, requested ?? "ghost");
    assert.equal(h.state(created.data.id).pace, undefined);
  }
  const before = h.rows.size;
  for (const carInteraction of [null, true, "off", {}, ["ghost"]]) {
    assert.equal((await h.post({ carInteraction })).status, 400);
  }
  assert.equal(h.rows.size, before, "invalid rules cannot create any race");
});

test("driver inputs cannot change saved car interactions; legacy missing fields remain missing", async () => {
  const h = await harness();
  for (const requested of [undefined, "ghost", "solid"] as const) {
    const created = await h.post({ carInteraction: requested });
    const id = created.data.id, driverToken = new URL(created.data.playerUrls.red).hash.slice(1);
    if (requested === undefined) {
      const legacy = h.state(id); delete legacy.carInteraction;
      h.rows.get(id)!.state = JSON.stringify(legacy);
    }
    const change = requested === "ghost" ? "solid" : "ghost";
    const response = await h.post({ player: "red", input: { type: "join", carInteraction: change }, carInteraction: change }, driverToken, [id, "input"]);
    assert.equal(response.status, 200);
    assert.equal(h.state(id).carInteraction, requested);
    assert.equal(response.data.state.carInteraction, requested ?? "solid");
    assert.equal((await h.post({ carInteraction: "ghost" }, driverToken)).status, 401);
  }
});
