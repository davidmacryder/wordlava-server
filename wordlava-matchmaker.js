#!/usr/bin/env node
/* ============================================================================
   Word Lava — Matchmaking service (REFERENCE skeleton for the FUTURE backend)
   ----------------------------------------------------------------------------
   This is the "persistent hosted backend with a player queue" the game is built
   around. It keeps a queue of players looking for an online Head-to-Head match,
   pairs the two closest by rating, and hands BOTH players the same room on the
   RELAY (wordlava-lan-server.js). From that point the game's existing shared-board
   engine runs exactly as it does for room-code play.

   The browser (Matchmaker / MM_CONFIG in WordLava.html) already speaks this
   protocol. To switch online matchmaking ON, with ZERO client code changes:
     1. Host the RELAY publicly        (wordlava-lan-server.js on a public URL).
     2. Host THIS matchmaker publicly  (set RELAY_PUBLIC_URL below to the relay).
     3. In WordLava.html set:  MM_CONFIG.matchmakerUrl = 'wss://your-matchmaker'
        (and optionally MM_CONFIG.relayUrl = 'wss://your-relay').

   ── PROTOCOL (WebSocket, JSON text frames) ─────────────────────────────────
     client → { type:'enqueue', v:1, rating, region, name }
     server → { type:'queued',  position, estWaitSec }            // 0+ progress
     server → { type:'match-found', relay:'<host:port|wss url>',
                room:'<unique code>', role:'host'|'guest',
                opponent:{ name, rating } }
     client → { type:'cancel' }                                   // leave queue
     server → { type:'error', message }

   NOTE: role is advisory — the relay assigns host/guest by join order, so the
   only thing that matters is that BOTH players receive the SAME unique room.

   This reference is intentionally minimal (in-memory queue, single process). A
   production service would add: authentication, rating persistence, regional
   pools, anti-abuse/rate-limiting, reconnection, horizontal scaling (shared
   queue via Redis), and health checks. It is a SEPARATE service to build, host,
   and pay for — the game ships ready for it but does not require it.

   RUN:   node wordlava-matchmaker.js [port]
   ENV:   RELAY_PUBLIC_URL   the relay address handed to matched players
                             (e.g. "wss://relay.yourgame.com" or "1.2.3.4:8080")
   ============================================================================ */

'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.argv[2], 10) || process.env.PORT || 8090;
// The relay players are sent to once matched. MUST be reachable by both clients.
// For LAN testing this can be the relay's LAN address; for internet play, a public wss URL.
const RELAY_PUBLIC_URL = process.env.RELAY_PUBLIC_URL || 'localhost:8080';
// Pair players whose ratings are within this band first; widens as they wait.
const BASE_RATING_BAND = 150;

/* ---------- Tiny zero-dependency WebSocket (RFC 6455) — same as the relay ---------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function send(sock, obj) {
    try {
        const payload = Buffer.from(JSON.stringify(obj));
        const len = payload.length;
        let header;
        if (len < 126) header = Buffer.from([0x81, len]);
        else if (len < 65536) header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
        else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeUInt32BE(Math.floor(len / 4294967296), 2); header.writeUInt32BE(len >>> 0, 6); }
        sock.write(Buffer.concat([header, payload]));
    } catch (e) { /* closed */ }
}

function decodeFrames(buffer) {
    const messages = [];
    let offset = 0;
    while (offset + 2 <= buffer.length) {
        const b0 = buffer[offset], b1 = buffer[offset + 1];
        const opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f, p = offset + 2;
        if (len === 126) { if (p + 2 > buffer.length) break; len = buffer.readUInt16BE(p); p += 2; }
        else if (len === 127) { if (p + 8 > buffer.length) break; len = Number(buffer.readBigUInt64BE(p)); p += 8; }
        let mask;
        if (masked) { if (p + 4 > buffer.length) break; mask = buffer.slice(p, p + 4); p += 4; }
        if (p + len > buffer.length) break;
        let data = buffer.slice(p, p + len);
        if (masked) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = data[i] ^ mask[i & 3]; data = out; }
        offset = p + len;
        if (opcode === 0x8) { messages.push({ close: true }); break; }
        if (opcode === 0x9 || opcode === 0xa) continue;
        if (opcode === 0x1) messages.push({ text: data.toString('utf8') });
    }
    return { messages, rest: buffer.slice(offset) };
}

/* ---------- Matchmaking queue ---------- */
// Each waiting player: { sock, rating, region, name, since }
const queue = [];
let roomSeq = 0;

function uniqueRoom() {
    roomSeq++;
    return 'M' + Date.now().toString(36).toUpperCase().slice(-5) + roomSeq.toString(36).toUpperCase();
}

function broadcastPositions() {
    queue.forEach((p, i) => send(p.sock, { type: 'queued', position: i + 1, estWaitSec: Math.max(0, (i) * 5) }));
}

// Try to pair the front of the queue with the nearest-rated waiting player.
function tryMatch() {
    while (queue.length >= 2) {
        const a = queue[0];
        // Widen the acceptable band the longer 'a' has waited.
        const waited = (Date.now() - a.since) / 1000;
        const band = BASE_RATING_BAND + Math.floor(waited / 5) * 100;
        let bestIdx = -1, bestDiff = Infinity;
        for (let i = 1; i < queue.length; i++) {
            const diff = Math.abs((queue[i].rating || 1000) - (a.rating || 1000));
            if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
        }
        if (bestIdx === -1 || bestDiff > band) break; // no acceptable partner yet
        const b = queue.splice(bestIdx, 1)[0];
        queue.splice(0, 1); // remove a
        const room = uniqueRoom();
        console.log(`  ✓ Matched ${a.name} (${a.rating}) ↔ ${b.name} (${b.rating}) → room ${room}`);
        send(a.sock, { type: 'match-found', relay: RELAY_PUBLIC_URL, room, role: 'host', opponent: { name: b.name, rating: b.rating } });
        send(b.sock, { type: 'match-found', relay: RELAY_PUBLIC_URL, room, role: 'guest', opponent: { name: a.name, rating: a.rating } });
    }
    broadcastPositions();
}

function removeFromQueue(sock) {
    const i = queue.findIndex(p => p.sock === sock);
    if (i >= 0) { queue.splice(i, 1); broadcastPositions(); }
}

/* ---------- HTTP + WebSocket upgrade ---------- */
const server = http.createServer((req, res) => {
    // Lightweight health check for hosting platforms.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Word Lava matchmaker OK. Players in queue: ' + queue.length);
});

server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const { messages, rest } = decodeFrames(buf);
        buf = rest;
        for (const m of messages) {
            if (m.close) { removeFromQueue(socket); try { socket.end(); } catch (e) {} return; }
            let msg; try { msg = JSON.parse(m.text); } catch (e) { continue; }

            if (msg.type === 'enqueue') {
                removeFromQueue(socket); // avoid duplicates
                queue.push({ sock: socket, rating: Number(msg.rating) || 1000, region: msg.region || 'auto', name: String(msg.name || 'Player').slice(0, 24), since: Date.now() });
                console.log(`  • Enqueued ${msg.name} (rating ${msg.rating}) — queue size ${queue.length}.`);
                tryMatch();
            } else if (msg.type === 'cancel') {
                removeFromQueue(socket);
                console.log('  • A player left the queue.');
            }
        }
    });
    socket.on('close', () => removeFromQueue(socket));
    socket.on('error', () => removeFromQueue(socket));
});

// Periodically re-attempt matches so widening rating bands eventually pair lonely players.
setInterval(tryMatch, 5000);

const HOST = process.env.HOST || '0.0.0.0';   // bind all interfaces (required by PaaS)
server.listen(PORT, HOST, () => {
    console.log('\n  🌋  Word Lava matchmaker is running on ' + HOST + ':' + PORT + '.');
    console.log('  Handing matched players to relay: ' + RELAY_PUBLIC_URL);
    console.log('  Point the game at it:  MM_CONFIG.matchmakerUrl = "wss://<your-public-url>"');
    console.log('  (Set RELAY_PUBLIC_URL so matched players can reach your relay.)\n');
});
