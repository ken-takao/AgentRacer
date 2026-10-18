# Agent Grand Prix development guide

These instructions apply to the entire repository. Read `README.md` for the
product and `operator/README.md` before changing the operator or AI integrations.

## Development and operations boundary

- Codex Cloud is for implementation, local previews, tests, and reviewable commits/PRs.
- Actual AI races and Sites publication remain in the existing local environment.
  Do not run `npm run operator`, start paid API sessions, deploy, or change the
  production Site from a Cloud task. Hand off the tested changes for local operation.
- Do not stop or restart existing servers or races. Use a task-owned preview
  process/port and only clean up processes started by this task.
- Preserve the existing Site identity, production bindings, and public origin.
  `.openai/hosting.json` in this repository intentionally contains only storage
  declarations; do not replace it with credentials or a local deployment config.

## Setup and checks

- Use Node.js **22.13 or newer** and npm. Install from the committed lockfile:

  ```sh
  npm run install:ci
  ```

  A fresh clone selects the portable execution profile automatically. This helper
  runs `npm ci` with dev/optional dependencies and checks the local Vinext binary.
  Do not copy `.sites-runtime` from another checkout or select `managed-linux`
  merely because the Cloud environment is Linux. Plain `npm ci` also uses the
  lockfile, but the helper is the preferred setup command.
- Tests and builds do not need real API keys. Do not copy local `.env.local`,
  `.dev.vars`, credentials, or runtime data into Cloud; do not request production
  secrets for routine development. Use fake values only in isolated test fixtures.
- After code changes, run the relevant focused tests, then the required checks:

  ```sh
  npm test
  npx tsc --noEmit
  npm run build
  ```

- Investigate failures; never change expected values merely to make tests pass.
  Report a blocked check with its actual error, rather than claiming success.
- Keep dependency updates intentional and commit the matching lockfile. Avoid
  unrelated formatting, generated build output, logs, and large screenshot files.

## Architecture and invariants

- `lib/race-engine.ts` owns deterministic wall-clock simulation, collisions,
  winner decisions, jumps, spins, obstacle placement, and history. Rendering must
  reflect server `progress`, `lane`, and `routeChoices`, never simulate a different
  race or change its speed to improve the appearance.
- Preserve existing rules unless the task explicitly changes them. In particular:
  routes lock on entry; default routes come from `lib/race-course.ts`; separate
  branches do not collide; legacy v1 races retain their existing behavior.
- Jumps last 0.8 seconds, with 2 seconds of cooldown after landing. Airborne,
  spinning, pre-race, and post-race jumps are rejected. Banana contact stops progress
  for 1.2 seconds and spins at the contact position; queued lane/speed changes take
  effect after recovery. Airborne passage avoids the obstacle.
- Keep dynamic obstacles ordered by progress and maintain `nextObstacleIndex`
  correctly when inserting. Never skip or double-process existing obstacles.
- `app/api/races/[[...path]]/route.ts` persists mutations through D1 version checks.
  Preserve atomic retries for simultaneous player/operator requests. Rejected
  actions must not change saved state or add successful-action history.
- Operator obstacle placement is admin-only. Keep all bounds, spacing, forward
  distance, count, rate, and asset-kind checks server-side. Drivers and spectators
  must not gain placement privileges.
- `RACE_ADMIN_KEY` and `OPENAI_API_KEY` stay server-side. Preserve the local
  operator's loopback binding, same-origin/Host checks, fixed destination forwarding,
  and race/player-scoped capability authentication. Do not log or commit secrets.
- AI drivers use the **2D** controls; spectators use **3D**. Keep lane selection
  distinct from fork selection. Decisions use the driver's current screenshot;
  Computer Use performs the resulting visible control action. Do not substitute
  direct game API calls or expose hidden/future game state to the driver.
- `lib/circuit-geometry.ts` and `lib/model-contact.ts` place models on the road.
  Preserve continuity and separate overpass levels. Ground assets from their actual
  bounds and road frame, not a universal height offset. Preserve timeline buffering
  and interpolation without projecting through stopped/spinning states.

## Visual verification and handoff

- Run `npm run dev` and use deterministic previews without starting a real race:
  `/preview/routes`, `/preview/effects`, `/preview/roadster`, `/preview/assets`.
  `/preview/narration` plays a recorded sample, not a new AI session.
- Route/geometry changes must cover harbor, alpine, and metro; both forks and both
  routes; approach, entry, middle, merge, exit, and overpass. Check chase/spectator
  cameras as well as overview, and preserve evidence of relevant before/after views.
  See `app/preview/routes/fixture.ts` for supported fixture query parameters.
- Add meaningful regression tests for changed physics, concurrency, authentication,
  route mapping, or model grounding. Use mocked AI/network behavior in tests.
- Review the diff for secrets and unrelated files. Summarize the problem, changes,
  exact checks run, and remaining limits in the handoff. Distinguish automated tests
  and preview screenshots from an actual AI race or a verified public deployment.
