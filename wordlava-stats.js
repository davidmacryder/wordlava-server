#!/usr/bin/env node
/* ============================================================================
 * Word Lava — Climb stats server (reference implementation)
 * ----------------------------------------------------------------------------
 * Zero dependencies. Node >= 18. Records, per player, the highest Climb camp
 * they have reached, and serves:
 *   • worldwide reach counts per camp  → the game turns these into "X% cleared"
 *   • each requested friend's best camp → the game turns these into "N/M friends"
 *
 * It is the backend behind the game's CLIMB_STATS.statsUrl. Deploy it like the
 * relay (Railway / Fly / Render), then set CLIMB_STATS.statsUrl in WordLava.html
 * and run `npx cap sync`.
 *
 * Endpoints
 *   POST /report      body: { "player": "<id-or-name>", "level": <int> }
 *                     Records max(level) for that player. Re-reporting is safe.
 *   GET  /stats?friends=a,b,c
 *                     → { total, reached: { "1": n, "2": n, ... },
 *                         friends: { "a": maxLevel, ... } }   (only known friends)
 *   GET  /health, /healthz   → 200 "ok"
 *   GET  /                   → 200 status page
 *
 * Storage: in-memory, with best-effort JSON persistence to STATS_FILE (so a
 * restart doesn't wipe the board when a volume is mounted). Falls back to
 * memory-only on a read-only / ephemeral filesystem.
 *
 * PRIVACY NOTE: this build matches friends by the same display names used in the
 * game's friends list (per your choice to reuse the existing friends). Names are
 * therefore used as identifiers. For a public launch, consider hashing names or
 * switching to opt-in friend codes so play data isn't tied to real identities.
 * ========================================================================== */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT, 10) || 8082;
const HOST = process.env.HOST || '0.0.0.0';
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, 'wordlava-stats.json');
const MAX_LEVEL = 2000;          // clamp absurd values
const MAX_BODY = 4 * 1024;       // tiny JSON bodies only

// player id -> highest camp reached
/** @type {Map<string, number>} */
const players = new Map();

// ---- persistence (best effort) --------------------------------------------
let canPersist = true;
function load() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            const obj = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
            if (obj && obj.players) {
                for (const k of Object.keys(obj.players)) {
                    const v = parseInt(obj.players[k], 10);
                    if (Number.isFinite(v)) players.set(k, v);
                }
            }
            console.log(`[stats] loaded ${players.size} climbers from ${STATS_FILE}`);
        }
    } catch (e) {
        console.log('[stats] no existing data loaded:', e.message);
    }
}
let saveTimer = null;
function scheduleSave() {
    if (!canPersist || saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            const players_obj = {};
            for (const [k, v] of players) players_obj[k] = v;
            fs.writeFileSync(STATS_FILE, JSON.stringify({ players: players_obj }), 'utf8');
        } catch (e) {
            canPersist = false;   // ephemeral / read-only FS — keep running in memory
            console.log('[stats] persistence disabled (read-only fs):', e.message);
        }
    }, 1500);
}

// ---- helpers ---------------------------------------------------------------
function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function sendJSON(res, code, obj) {
    cors(res);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}
function sendText(res, code, text, type) {
    cors(res);
    res.writeHead(code, { 'Content-Type': type || 'text/plain' });
    res.end(text);
}

// Build the per-camp "reached" histogram: reached[L] = how many players got >= L.
function buildReached() {
    const reached = {};
    let max = 0;
    for (const v of players.values()) if (v > max) max = v;
    if (!max) return reached;
    // exact tally per level, then suffix-sum so reached[L] counts everyone at >= L
    const tally = new Array(max + 1).fill(0);
    for (const v of players.values()) if (v >= 1 && v <= max) tally[v]++;
    let cum = 0;
    for (let L = max; L >= 1; L--) { cum += tally[L]; reached[L] = cum; }
    return reached;
}

// ---- server ----------------------------------------------------------------
const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch (e) { return sendText(res, 400, 'bad request'); }
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

    if (pathname === '/health' || pathname === '/healthz') return sendText(res, 200, 'ok');

    if (req.method === 'GET' && pathname === '/') {
        return sendText(res, 200,
            `Word Lava stats server — ${players.size} climbers tracked.\n` +
            `POST /report {player, level} · GET /stats?friends=a,b,c · GET /health\n`);
    }

    if (req.method === 'GET' && pathname === '/stats') {
        const names = (url.searchParams.get('friends') || '')
            .split(',').map(s => s.trim()).filter(Boolean).slice(0, 200);
        const friends = {};
        for (const n of names) if (players.has(n)) friends[n] = players.get(n);
        return sendJSON(res, 200, { total: players.size, reached: buildReached(), friends });
    }

    if (req.method === 'POST' && pathname === '/report') {
        let body = '';
        let tooBig = false;
        req.on('data', chunk => {
            body += chunk;
            if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
        });
        req.on('end', () => {
            if (tooBig) return;
            let data;
            try { data = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
            const player = (data && typeof data.player === 'string') ? data.player.trim().slice(0, 64) : '';
            let level = (data && parseInt(data.level, 10)) || 0;
            if (!player || level < 1) return sendJSON(res, 400, { ok: false, error: 'need player + level >= 1' });
            if (level > MAX_LEVEL) level = MAX_LEVEL;
            const prev = players.get(player) || 0;
            if (level > prev) { players.set(player, level); scheduleSave(); }
            return sendJSON(res, 200, { ok: true, best: players.get(player) });
        });
        return;
    }

    return sendText(res, 404, 'not found');
});

load();
server.listen(PORT, HOST, () => {
    console.log(`[stats] Word Lava stats server listening on ${HOST}:${PORT}`);
    console.log(`[stats] persistence: ${canPersist ? STATS_FILE : 'memory only'}`);
});
