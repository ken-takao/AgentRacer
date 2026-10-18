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
