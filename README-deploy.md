# Word Lava — online Ranked backend (deploy guide)

Two tiny, **zero-dependency** Node servers power online Ranked:

- **`wordlava-lan-server.js`** — the **relay**. Two matched players connect here
  (by room code) and it forwards their moves. Also doubles as your old LAN server.
- **`wordlava-matchmaker.js`** — the **matchmaker**. Players queue here; it pairs the
  nearest ratings and hands both the same relay room, then they connect to the relay.

You host these as **two separate services**. Everything offline (Practice, Daily,
Climb) needs none of this — only Ranked does.

There is also a **third, optional** server:

- **`wordlava-stats.js`** — the **Climb stats server**. It records the highest camp
  each climber reaches and serves, per camp, how many players got that far (the game
  shows it as "🌍 X% cleared") and which of your friends did ("👥 N/M friends"). Until
  you deploy it and set `CLIMB_STATS.statsUrl`, the Climb ascent ladder simply shows
  "—" instead of any numbers. It's independent of Ranked — deploy it whenever you like.

Both are already PaaS-ready: they read `process.env.PORT`, bind `0.0.0.0`, and answer
health checks (`/health` on the relay, `/` on the matchmaker). The relay returns a
200 status page when no game file is bundled, so platform health checks pass.

> **Important:** platforms give you an `https://` URL — connect the game with the
> **`wss://`** form of that same host (secure WebSocket). Plain `ws://` is blocked on
> iOS, so always use `wss://`.

---

## Option A — Railway (easiest)

1. Put this folder in a GitHub repo (or use `railway init` with the Railway CLI).
2. **Relay service:** New Project → Deploy from repo. Set the start command to
   `node wordlava-lan-server.js`. Deploy. Open Settings → Networking → **Generate
   Domain**. You'll get something like `wordlava-relay.up.railway.app`.
   - Your relay URL for the game is: `wss://wordlava-relay.up.railway.app`
3. **Matchmaker service:** in the same project, New Service → same repo. Set the start
   command to `node wordlava-matchmaker.js`. Add a variable:
   - `RELAY_PUBLIC_URL = wss://wordlava-relay.up.railway.app`
   Deploy, then Generate Domain → e.g. `wordlava-matchmaker.up.railway.app`.
4. Railway injects `PORT` automatically — nothing else to set.

(Railway supports WebSockets on all plans. A starter setup runs ~\$5/mo; the signup
credit covers your first while.)

---

## Option B — Fly.io (cheapest always-on, lowest latency)

Install the Fly CLI and `fly auth login`, then from this folder:

```bash
# 1. RELAY
fly launch --copy-config --config fly.relay.toml --no-deploy
fly deploy --config fly.relay.toml
# note the URL it prints, e.g. https://wordlava-relay.fly.dev  → use wss://wordlava-relay.fly.dev

# 2. MATCHMAKER (point it at the relay you just deployed)
fly launch --copy-config --config fly.matchmaker.toml --no-deploy
fly secrets set RELAY_PUBLIC_URL="wss://wordlava-relay.fly.dev" --config fly.matchmaker.toml
fly deploy --config fly.matchmaker.toml
```

Edit `primary_region` in both `.toml` files to your nearest region first
(`iad` = US-East, `lhr` = London, `sjc` = US-West, etc.). A small always-on VM is
about \$2/mo each; Fly's free allowances may cover early usage.

> The `.toml` files keep the relay always-on (`auto_stop_machines = false`) so live
> games aren't dropped mid-match. Don't set this to `true` for the relay.

---

## Option C — Render

Create **two** Web Services from this repo. Use the **Starter** plan (\$7/mo) — the
free tier spins down when idle, which drops live WebSocket connections.
- Relay: start command `node wordlava-lan-server.js`, health check path `/health`.
- Matchmaker: start command `node wordlava-matchmaker.js`, env
  `RELAY_PUBLIC_URL = wss://<your-relay>.onrender.com`.

---

## Final step — turn on Ranked in the game

Once both are live, edit `www/index.html` in your Capacitor app (search for
`MM_CONFIG`) and set:

```js
MM_CONFIG.relayUrl = 'wss://wordlava-relay.up.railway.app';        // your relay
MM_CONFIG.matchmakerUrl = 'wss://wordlava-matchmaker.up.railway.app'; // your matchmaker
```

Then `npx cap sync` and rebuild. "Find Match" and "Play a Friend" will go live.

**Quick test:** open `https://<your-relay-url>/health` in a browser — you should see
`Word Lava relay OK`. Open `https://<your-matchmaker-url>/` — you should see
`Word Lava matchmaker OK. Players in queue: 0`.

---

## Run locally (no hosting)

```bash
node wordlava-lan-server.js          # relay on http://localhost:8080 (also serves the game on LAN)
node wordlava-matchmaker.js          # matchmaker on :8090
node wordlava-stats.js               # Climb stats on :8082
# or pick ports:  node wordlava-lan-server.js 9000
```

---

## Climb stats server (worldwide % + friends per camp)

This one is **HTTP, not WebSocket**, so it's simpler — any always-on host works
(Railway / Fly / Render). It exposes:

- `POST /report` — body `{ "player": "<id-or-name>", "level": <camp> }`. The game
  sends this automatically when you clear a camp; the server keeps your best.
- `GET /stats?friends=a,b,c` — returns `{ total, reached: {camp: count}, friends: {name: bestCamp} }`.
- `GET /health` — returns `ok`.

**Railway:** New Service → same repo → start command `node wordlava-stats.js` →
Generate Domain. **Fly:** `fly deploy --config fly.stats.toml` (the included config
mounts an optional volume at `/data` so the board survives restarts). **Render:**
new Web Service, start command `node wordlava-stats.js`.

**Turn it on in the game:** edit `www/index.html` (search for `CLIMB_STATS`) and set:

```js
CLIMB_STATS.statsUrl = 'https://wordlava-stats.up.railway.app';   // your stats host (https)
```

Then `npx cap sync` and rebuild. The Climb ascent ladder will fill in live numbers.
(Unlike the relay, this is plain `https://`, not `wss://`.)

**Quick test:** open `https://<your-stats-url>/health` → `ok`. Then
`https://<your-stats-url>/stats?friends=` → `{"total":0,"reached":{},"friends":{}}`
until climbers start reporting.

**Privacy note:** because you chose to reuse the existing friends list, friends are
matched by display **name**, so names are used as identifiers here. For a public
launch, consider hashing names or moving to opt-in friend codes so play data isn't
tied to real identities.
