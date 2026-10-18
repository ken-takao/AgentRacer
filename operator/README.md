# Local race operator

This Node 22 server launches **two independent Agents API hosted Computer Use sessions**. Each agent joins its own capability URL and drives through the visible game controls. The public race clock is independent of the agents' turns. Decisions API (`gpt-6-luna`) is the driving strategist: it selects one action from the latest screenshot, and the Computer Use agent executes that action. The operator never sends direct player inputs or substitutes a scripted bot.

## Run

From the `agent-grand-prix` site folder:

```sh
node operator/server.mjs
```

Open <http://127.0.0.1:4180> to monitor and control the races. While this local server is running, the public viewing page can request a new race automatically when none is active. The dashboard's **2つのエージェントを起動** also starts a race manually. Either path starts billable API work. Stop from the dashboard or press Ctrl+C; both paths cancel and delete known browser sessions.

The server reads `OPENAI_API_KEY` from the project's `.env.local`, and `RACE_ADMIN_KEY` from this site's `.dev.vars`. Existing environment variables take precedence. Secrets are read only into process memory and are never returned to the dashboard. Do not put secret files in source control.

Optional environment settings:

- `GAME_ORIGIN`: required HTTPS origin of your deployed game; no default.
- `OPERATOR_PORT`: default `4180`; the server binds only `127.0.0.1`.
- `OPENAI_ENV_FILE`, `RACE_ENV_FILE`: optional absolute paths to existing local configuration files instead of `.env.local` / `.dev.vars`. They are read without copying credentials.
- `NARRATION_ENABLED`: default enabled; set `0` to run without GPT-Live commentary.
- `NARRATION_VOICE`: default `shida`, the Japanese masculine GPT-Live voice.
- `AUTO_START_RACES`: default enabled; set `0` to disable public viewing-page requests and use manual starts only.
- `DRIVING_MODE`: default `visual`. `telemetry` is an **experimental**, opt-in text-observation decision loop; it is not an established latency or accuracy improvement. Keep it off for public races pending the validation in [the measurement report](../docs/driving-latency.md).
- `RACE_PACE`: unset retains classic speed. `sprint-2x` requires `DRIVING_MODE=telemetry` and requests an explicit new v2 race with twice the travel speed, a 120-unit driver horizon and a 60-unit minimum obstacle placement distance. It does not modify existing races or jump/spin durations. This mode remains experimental and disabled by default.

Deploy the public game and configure its matching `RACE_ADMIN_KEY` before launching. The game and its state API must be reachable from the hosted browsers. A localhost game cannot be reached by OpenAI-hosted sessions.

## Automatic start from the viewing page

The public page writes a coalesced request to the game's launch API. The local operator sends an authenticated heartbeat and polls for that request every two seconds. Only one operator can claim it. Room creation, the two Computer Use sessions, Decisions and narration still run from this local process; no OpenAI key is sent to the public site or browser. Closing the local operator makes automatic start unavailable after the heartbeat expires.

The manual and automatic paths share the same start lock. An existing race is reused, concurrent visitors share one request, and a new run waits for the prior run's session cleanup and proof write. A failed session deletion keeps starts blocked until the operator resets successfully. Stop invalidates the current polling generation and withdraws queued requests before accepting new demand, including when configuration loading or claiming is in flight. Shutdown also sends a final withdrawal; a disconnected operator's heartbeat expires. A failed start is reported to the page; polling does not replay that request or continuously create new races. A later visit or explicit new request is needed to retry.

The server acknowledges the new room as soon as its URLs are validated, so visitors can watch AI preparation immediately. A temporary failure to publish this acknowledgement is retried without recreating the room. The dashboard's `/api/status` includes public-safe `autoStart` connectivity information. Injected test configurations do not poll automatically unless the test explicitly enables `autoStart`.

## Replay and reset

After completion or cancellation, **新しいレースを開始** creates a new match and two new sessions and opens its spectator page. **表示をリセット** clears the local dashboard to idle without starting API work or deleting public results. Active runs must finish stopping first. If session deletion failed, reset retries cleanup and retains the run until deletion is confirmed; start stays blocked. The server also waits for the prior run task to settle before replacing it.

## Behavior and evidence

- Uses `gpt-6-astra`, `computer_use`, `include_screenshots: true`, and one isolated hosted environment per driver.
- Opens both SSE streams before submitting the player URLs.
- Approves only the configured game origin, as authorized for this demo. Other origins are denied; login prompts are cancelled.
- Each agent calls `decide_drive({})` after a fresh screenshot. The operator passes only that image and fixed driving rules to Decisions API, which chooses one enumerated lane, speed, route, jump or wait action. It also estimates immediate obstacle and rival risk. Only fixed, validated instructions return to Computer Use; the full game state and future obstacle map are never model inputs. Repeat calls on the same frame or stale results are rejected. Three consecutive API failures stop the race instead of silently returning to autonomous CU decisions.
- The screenshot comes from that player's own session, selected by the server, not tool arguments. Instructions prohibit DOM inspection, scripts, direct network calls, and state manipulation; the hosted API does not provide a separately enforceable image-only mode.
- A session that completes its turn before the game ends can receive up to three continuation messages in the same browser.
- Browser screenshots arrive after tool activities and may be absent for some activities. They are snapshots, not a video stream.
- Stops on game completion, cancellation, stream/API failure, or an eight-minute preparation-and-race limit.
- Saves a credential-free result record to the project's ignored `work/race-live-check.json`, including the two session IDs, captured image counts, observed game result, and confirmed deletion status. `finalState` retains the public server state, player progress/collisions, and recent control history. `drivingInputs` counts lane/speed/route changes and accepted jumps in that history, separately from READY and browser activity; `computerUseVerified`, `drivingVerified`, and `decisionsVerified` are distinct checks. Per-player `decisions`, `decisionErrors`, and `lastDecision` record Decisions invocations separately from observed game inputs. A returned decision is not itself proof that a click succeeded.

The dashboard is a local operator surface. Its start, stop and obstacle actions require same-origin JSON POST requests; Host headers outside localhost are rejected. The public launch queue grants no stop, obstacle or arbitrary API forwarding access. The public game does not receive the OpenAI API key.

## Human obstacle placement

During an active race, **コースに障害物を設置** lets the operator choose an asset, a lane, a course distance and, inside a junction, its left or right branch. The preview and map use the actual 2D images from `public/roadster-circuit/props/manifest.json`; only entries with `kind: "obstacle"` appear. Click the map to select a lane and position, or use **先頭の20先** to follow the leading car. The field is an absolute course distance, not a distance from a car. The local positions refresh once per second; the server checks the current positions again when the request arrives.

The server requires placement at least 12 track units ahead of both cars, at least 3 units before the finish and at least 4 units from another obstacle on the same lane and road. It permits 20 operator obstacles per race and one placement every 1.5 seconds. Rejections display their server-provided reason without recording a placement. A banana stops a car at the contact point for a 1.2-second spin; an airborne jump avoids it. Other catalog obstacles apply the standard collision slowdown.

The browser submits only `{assetId, lane, progress, route?}` to the local `/api/obstacles` endpoint. It cannot pick a race ID, remote origin or credential. The operator forwards this body to the current active race's admin-authenticated API using its existing server-side `RACE_ADMIN_KEY`. The dashboard receives only allowlisted public positions, course data and asset images; it never receives the admin key. The hosted API performs the authoritative validation and records accepted placements in race history. AI sessions can use the driver's **JUMP** control, but cannot access this local operator surface or place obstacles.

## GPT-Live race commentary

Each race opens one additional `gpt-live-1` session, independent of the two driving sessions. `operator/narration-director.mjs` contains the original Japanese commentator's system prompt and selects verified start, contact, obstacle slowdown, recovery, route, lead-change and final-result facts. It alternates brief encouragement for Scarlet and Cobalt. Race facts are sent with `session.commentary.append`; no separate TTS or text-generation call is used. The voice is a built-in voice, not a clone of a real announcer.

The operator sends paced silent PCM to maintain GPT-Live's input timeline. Spectators never need microphone permission. Actual `session.output_transcript.delta` text becomes subtitles; system prompts and input facts are not used as substitute captions. Audio is packaged into short 24 kHz WAV chunks and uploaded to the game's R2 bucket with an admin-authenticated feed. All viewers share these same generated chunks, so viewer count does not create more model sessions.

The spectator reserves roughly three seconds of published audio, displays a character speech bubble even with sound off, and enables audio after the viewer presses **実況を聴く**. GPT-Live transcript timestamps describe approximate session time, not PCM sample positions; captions are mapped to the received audio position for approximate phrase synchronization. The audio itself stays in its original order and is not stretched or padded. A monotonic input clock avoids accumulating timer drift, and a playback buffer absorbs publication jitter. BGM is reduced during audible commentary. Playback rejoins the live edge after interruption rather than replaying old calls. `/preview/narration` provides an explicitly labeled recorded GPT-Live sample without starting an API session.

Commentary has a five-minute maximum and closes when the race finishes or stops. A normal finish allows a short final call before closing and records whether `session.closed` and final usage were received. Narrator failures do not stop the drivers. The feed uses generations and monotonically increasing revisions so delayed uploads cannot replace a newer ending. Voice duration is billable during preparation and silence as well as speaking. Archived audio is retained with race assets; R2 retention is a separate operational policy.

## Decisions API

The visual decision client is `operator/drive-decisions.mjs`. It uses `POST /v1/decisions` with an action choice and obstacle-risk predicate. New ghost races skip the rival-risk predicate and tell the model that cars cannot block or slow each other. The saved public race state selects this rule; old solid races retain the third, rival-risk question. Text observations also omit rival positions from the API payload in ghost mode. An unasked rival risk is published as `null`, not a measured zero. This is in addition to each Agents API session and optional GPT-Live session. The screenshot expires after 12 seconds and a request times out after 8 seconds. These limits do not remove Computer Use latency, so this mode is not guaranteed faster than a direct CU strategy. Course-obstacle collisions remain deterministic in the game engine.

The public `/api/races/:id/decisions` feed contains only allowlisted decisions and metrics; writes require the race admin key and are ordered by timestamp/count. Older races can have no decision feed. Deploy the site update before starting this operator.

Jump strategy is shared by visual/text and ghost/solid decisions. The model first
checks the **JUMP** control (not the race-joining READY button), the obstacle's
lane/route and distance divided by speed, then considers the delayed click and
0.8-second airborne window. A feasible imminent jump is preferred over needless
lane changes or braking, even when another lane is clear. A distant obstacle,
cooldown, spin, airborne state or non-racing phase must not trigger a jump.
Selecting JUMP still means one immediate Computer Use click; it does not arm an
automatic or scheduled jump. These priorities do not remove variable CU latency
or establish a measured improvement in real-race obstacle avoidance. The server
still owns jump eligibility, 0.8-second duration and the two-second cooldown.
Restart the local operator to load changed driving instructions for new sessions.

References: [Decisions API](https://developers.openai.com/api/docs/guides/decisions), [Agents API functions](https://developers.openai.com/api/docs/guides/agents-api/tools/functions).

### Text-observation experiment

`drive-observation.mjs` creates a fixed-schema observation from the public state:
own lane/speed/control availability, visible obstacle distances, the displayed
rival radar and available branch choices. It excludes credentials, raw text,
history and the full future obstacle map. `text-driver.mjs` calls the same
Decisions model directly, then re-reads and validates the state before asking the
separate hosted CU session to press one visible control. No game input POST is
sent by the operator. Each driver runs independently; commands never queue.

Observations expire after 2 seconds and decisions before dispatch after 3 seconds.
Those limits **do not bound the subsequent CU action time**. A late CU click can
still be strategically stale. The 15-second actor deadline aborts local waiting
and triggers race/session cleanup; transport abort alone cannot guarantee that a
hosted click was cancelled. An ambiguous action is not retried. READY must be
confirmed in the server state, and successful actions require a new matching
history event and current control state. Unacknowledged actions fail closed,
including a control that becomes unavailable while the CU turn is in flight.

`/api/status` and the ignored proof file include per-player `timing` records in
this mode. `firstComputerAt` is receipt of a CU **tool-done** event, not browser
execution start. `ackObservedAt` is the later state-read time, not input time.
`endToEndMs` includes state reads, decision generation and the complete actor
turn. Waiting/expired decisions and failed actions have separate trace records;
do not count them as successful controls. Review the actual input history too.

For isolated experiments, use a separate `OPERATOR_PORT` and `AUTO_START_RACES=0`;
never replace an already running operator. The deterministic `/preview/driving`
page can test CU button latency without creating or mutating a race.
