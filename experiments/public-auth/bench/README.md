# Load and CPU profiling

`bench/run.mjs` stress-tests the built proxy (`dist/`) against an owned HTTP/WebSocket
fixture. The load generator and fixture run in separate processes, so the proxy CPU
profile contains only proxy work; model and network latency are excluded.

```sh
pnpm build
pnpm bench                          # all scenarios, 5 s each, with CPU profiles
node bench/run.mjs --only api-get,ws-connect --duration 3000 --no-profile
node bench/profile-report.mjs bench/results/<stamp>/profiles/api-get.cpuprofile --top=20
```

Scenarios: `api-get` (authenticated API through the upstream), `session-check`
(authentication without upstream forwarding), `document-get`, `asset-js` (hashed
300 KiB asset), `anonymous-get`, `login` (wrong password, unique client IP per
attempt), `ws-connect`, and `ws-echo`.

Options: `--only a,b`, `--duration MS`, `--concurrency N`, `--profile-interval US`,
`--session-cache-seconds N` (`0` disables the cache), `--no-profile`, `--out DIR`,
`--top N`. The runner refuses to measure a `dist/` older than `src/`.

Each run writes `report.txt` and `summary.json` under `bench/results/<stamp>/`, with one
`.cpuprofile` per profiled scenario. The report prints latency percentiles, throughput,
event-loop delay, CPU time, RSS, and a profile summary. Profiles are attributed to the
owning package or module so native SQLite and socket frames are charged to their caller.

Endpoint verification runs before measurement: authenticated requests, hashed-asset
caching, anonymous refusal, and document redirect must pass or the run aborts.
All processes share the host CPU, so compare runs on the same machine and avoid
concurrent CPU-heavy work.
