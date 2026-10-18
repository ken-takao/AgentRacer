# Local race operator

This Node 22 server launches **two independent Agents API hosted Computer Use sessions**. Each agent joins its own capability URL and drives through the visible game controls. The public race clock is independent of the agents' turns. The operator never supplies a driving policy, sends direct player inputs, or substitutes a scripted bot.

## Run

From the `agent-grand-prix` site folder:

```sh
node operator/server.mjs
```

Open <http://127.0.0.1:4180> and click **2つのエージェントを起動**. This starts billable API work. Stop from the dashboard or press Ctrl+C; both paths cancel and delete known browser sessions.

The server reads `OPENAI_API_KEY` from the project's `.env.local`, and `RACE_ADMIN_KEY` from this site's `.dev.vars`. Existing environment variables take precedence. Secrets are read only into process memory and are never returned to the dashboard. Do not put secret files in source control.

Optional environment settings:

- `GAME_ORIGIN`: required HTTPS origin of your deployed game; no default.
- `OPERATOR_PORT`: default `4180`; the server binds only `127.0.0.1`.
- `OPENAI_ENV_FILE`, `RACE_ENV_FILE`: optional absolute paths to existing local configuration files instead of `.env.local` / `.dev.vars`. They are read without copying credentials.
- `NARRATION_ENABLED`: default enabled; set `0` to run without GPT-Live commentary.
- `NARRATION_VOICE`: default `shida`, the Japanese masculine GPT-Live voice.

Deploy the public game and configure its matching `RACE_ADMIN_KEY` before launching. The game and its state API must be reachable from the hosted browsers. A localhost game cannot be reached by OpenAI-hosted sessions.

## Replay and reset

After completion or cancellation, **新しいレースを開始** creates a new match and two new sessions and opens its spectator page. **表示をリセット** clears the local dashboard to idle without starting API work or deleting public results. Active runs must finish stopping first. If session deletion failed, reset retries cleanup and retains the run until deletion is confirmed; start stays blocked. The server also waits for the prior run task to settle before replacing it.

## Behavior and evidence

- Uses `gpt-6-astra`, `computer_use`, `include_screenshots: true`, and one isolated hosted environment per driver.
- Opens both SSE streams before submitting the player URLs.
- Approves only the configured game origin, as authorized for this demo. Other origins are denied; login prompts are cancelled.
- Lane and speed decisions come from each agent's visible browser interaction. Instructions prohibit DOM inspection, scripts, direct network calls, and state manipulation; the hosted API does not provide a separately enforceable image-only mode.
- A session that completes its turn before the game ends can receive up to three continuation messages in the same browser.
- Browser screenshots arrive after tool activities and may be absent for some activities. They are snapshots, not a video stream.
- Stops on game completion, cancellation, stream/API failure, or an eight-minute preparation-and-race limit.
- Saves a credential-free result record to the project's ignored `work/race-live-check.json`, including the two session IDs, captured image counts, observed game result, and confirmed deletion status. `finalState` retains the public server state, player progress/collisions, and recent control history. `drivingInputs` counts lane/speed changes in that history, separately from READY and browser activity; `computerUseVerified` and `drivingVerified` are distinct checks.

The dashboard is a local operator surface. Only same-origin JSON POST requests can start or stop a race; Host headers outside localhost are rejected. The public game does not receive the OpenAI API key.

## GPT-Live race commentary

Each race opens one additional `gpt-live-1` session, independent of the two driving sessions. `operator/narration-director.mjs` contains the original Japanese commentator's system prompt and selects verified start, contact, obstacle slowdown, recovery, route, lead-change and final-result facts. It alternates brief encouragement for Scarlet and Cobalt. Race facts are sent with `session.commentary.append`; no separate TTS or text-generation call is used. The voice is a built-in voice, not a clone of a real announcer.

The operator sends paced silent PCM to maintain GPT-Live's input timeline. Spectators never need microphone permission. Actual `session.output_transcript.delta` text becomes subtitles; system prompts and input facts are not used as substitute captions. Audio is packaged into short 24 kHz WAV chunks and uploaded to the game's R2 bucket with an admin-authenticated feed. All viewers share these same generated chunks, so viewer count does not create more model sessions.

The spectator reserves roughly three seconds of published audio, displays a character speech bubble even with sound off, and enables audio after the viewer presses **実況を聴く**. GPT-Live transcript timestamps describe approximate session time, not PCM sample positions; captions are mapped to the received audio position for approximate phrase synchronization. The audio itself stays in its original order and is not stretched or padded. A monotonic input clock avoids accumulating timer drift, and a playback buffer absorbs publication jitter. BGM is reduced during audible commentary. Playback rejoins the live edge after interruption rather than replaying old calls. `/preview/narration` provides an explicitly labeled recorded GPT-Live sample without starting an API session.

Commentary has a five-minute maximum and closes when the race finishes or stops. A normal finish allows a short final call before closing and records whether `session.closed` and final usage were received. Narrator failures do not stop the drivers. The feed uses generations and monotonically increasing revisions so delayed uploads cannot replace a newer ending. Voice duration is billable during preparation and silence as well as speaking. Archived audio is retained with race assets; R2 retention is a separate operational policy.
