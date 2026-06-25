#!/usr/bin/env node
/* ============================================================================
   Word Lava — LAN companion server
   ----------------------------------------------------------------------------
   A tiny zero-dependency server that does two jobs:
     1. Serves WordLava.html to anyone on your local network.
     2. Relays game messages between two players in the same "room" so they can
        play Head-to-Head over the LAN.

   This same relay also backs ONLINE matchmaking: a matchmaking service can pair
   strangers and hand both players a room on this relay (see wordlava-matchmaker.js).
   It contains NO game logic and stores nothing — it just pairs two browsers and
   forwards JSON between them. The browsers do all the actual game work.

   HOW TO RUN (see the in-game "Connect to LAN game" help for the friendly
   version):
     1. Install Node.js (https://nodejs.org) if you don't have it.
     2. Put this file in the SAME folder as WordLava.html.
     3. Open a terminal in that folder and run:   node wordlava-lan-server.js
     4. It prints the address to share, e.g.  http://192.168.1.23:8080
     5. Both players open that address in their browser, pick
        Head-to-Head → "Play a Friend", and use the same room code.

   Change the port with:   node wordlava-lan-server.js 9000
   ============================================================================ */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// PORT precedence: explicit CLI arg → platform-injected env (Railway/Render/Fly) → 8080 for local.
const PORT = parseInt(process.argv[2], 10) || parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '0.0.0.0';   // bind all interfaces (required by PaaS)
const ROOT = __dirname;
const GAME_FILE = path.join(ROOT, 'WordLava.html');

/* ---------- Minimal static file serving (just the game) ---------- */
const server = http.createServer((req, res) => {
    // Serve the game at / and /WordLava.html; everything else 404s.
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

    // Always-200 health check for hosting platforms (Railway/Render/Fly ping this).
    if (urlPath === '/health' || urlPath === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Word Lava relay OK');
        return;
    }

    if (urlPath === '/' || urlPath === '/index.html') urlPath = '/WordLava.html';

    if (urlPath === '/WordLava.html') {
        fs.readFile(GAME_FILE, (err, data) => {
            if (err) {
                // No game file present (hosted as a pure WebSocket relay — the app bundles its
                // own copy). Return a 200 status page so platform health checks pass.
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('Word Lava relay is running (WebSocket endpoint only).');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
        return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

/* ---------- Tiny WebSocket implementation (RFC 6455, no dependencies) ---------- */
// We implement just enough of the WebSocket protocol to do the handshake and
// send/receive text frames. This keeps the server dependency-free.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const rooms = new Map(); // roomCode -> [socketInfo, socketInfo]

function send(sock, obj) {
    try {
        const payload = Buffer.from(JSON.stringify(obj));
        const len = payload.length;
        let header;
        if (len < 126) {
            header = Buffer.from([0x81, len]);
        } else if (len < 65536) {
            header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x81; header[1] = 127;
            header.writeUInt32BE(Math.floor(len / 4294967296), 2);
            header.writeUInt32BE(len >>> 0, 6);
        }
        sock.write(Buffer.concat([header, payload]));
    } catch (e) { /* socket closed */ }
}

function decodeFrames(buffer) {
    // Returns { messages: [string], rest: Buffer }
    const messages = [];
    let offset = 0;
    while (offset + 2 <= buffer.length) {
        const b0 = buffer[offset];
        const b1 = buffer[offset + 1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let p = offset + 2;
        if (len === 126) { if (p + 2 > buffer.length) break; len = buffer.readUInt16BE(p); p += 2; }
        else if (len === 127) { if (p + 8 > buffer.length) break; len = Number(buffer.readBigUInt64BE(p)); p += 8; }
        let mask;
        if (masked) { if (p + 4 > buffer.length) break; mask = buffer.slice(p, p + 4); p += 4; }
        if (p + len > buffer.length) break; // wait for more data
        let data = buffer.slice(p, p + len);
        if (masked) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = data[i] ^ mask[i & 3]; data = out; }
        offset = p + len;
        if (opcode === 0x8) { messages.push({ close: true }); break; }   // close
        if (opcode === 0x9 || opcode === 0xa) { continue; }              // ping/pong: ignore
        if (opcode === 0x1) messages.push({ text: data.toString('utf8') });
    }
    return { messages, rest: buffer.slice(offset) };
}

function leaveRoom(info) {
    const arr = rooms.get(info.room);
    if (!arr) return;
    const idx = arr.indexOf(info);
    if (idx >= 0) arr.splice(idx, 1);
    // Notify the remaining peer that the other side left.
    arr.forEach(o => send(o.sock, { type: 'peer-left' }));
    if (arr.length === 0) rooms.delete(info.room);
}

server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );

    const info = { sock: socket, room: null, role: null };
    let buf = Buffer.alloc(0);

    socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const { messages, rest } = decodeFrames(buf);
        buf = rest;
        for (const m of messages) {
            if (m.close) { leaveRoom(info); socket.end(); return; }
            let msg;
            try { msg = JSON.parse(m.text); } catch (e) { continue; }

            if (msg.type === 'join') {
                const code = String(msg.room || '').trim().toUpperCase() || 'LAVA';
                info.room = code;
                let arr = rooms.get(code);
                if (!arr) { arr = []; rooms.set(code, arr); }
                if (arr.length >= 2) { console.log(`  ✗ A third player tried to join full room "${code}" — refused.`); send(socket, { type: 'room-full' }); socket.end(); return; }
                arr.push(info);
                info.role = arr.length === 1 ? 'host' : 'guest';
                console.log(`  • Player joined room "${code}" as ${info.role} (${arr.length}/2).`);
                send(socket, { type: 'joined', role: info.role, room: code, players: arr.length });
                // When the second player joins, tell both the room is ready.
                if (arr.length === 2) { console.log(`  ✓ Room "${code}" is full — both players notified to start.`); arr.forEach(o => send(o.sock, { type: 'ready', players: 2 })); }
                continue;
            }

            // Any other message is relayed verbatim to the OTHER peer in the room.
            const arr = rooms.get(info.room);
            const others = arr ? arr.filter(o => o !== info) : [];
            if (msg.type === 'deal') console.log(`  → Relaying host's deal to the guest (${others.length} recipient).`);
            others.forEach(o => send(o.sock, msg));
        }
    });

    socket.on('close', () => leaveRoom(info));
    socket.on('error', () => leaveRoom(info));
});

/* ---------- Boot + print the share address ---------- */
function lanAddresses() {
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
        }
    }
    return out;
}

server.listen(PORT, HOST, () => {
    const onPaaS = !!(process.env.PORT || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME || process.env.RENDER);
    if (onPaaS) {
        console.log('\n  🌋  Word Lava relay is running (hosted).');
        console.log('  Listening on ' + HOST + ':' + PORT + '  ·  health: /health');
        console.log('  Point the game at this service:  MM_CONFIG.relayUrl = "wss://<your-public-url>"\n');
        return;
    }
    const addrs = lanAddresses();
    console.log('\n  🌋  Word Lava LAN server is running!\n');
    if (!fs.existsSync(GAME_FILE)) {
        console.log('  ⚠️  WARNING: WordLava.html is NOT in this folder.');
        console.log('      Put this server file next to WordLava.html, then restart.\n');
    }
    console.log('  Share ONE of these addresses with the other player(s) on your network:');
    if (addrs.length === 0) {
        console.log(`     http://localhost:${PORT}   (no LAN address found — are you on a network?)`);
    } else {
        addrs.forEach(a => console.log(`     http://${a}:${PORT}`));
    }
    console.log('\n  Both players open the address, choose Ranked → "Play a Friend",');
    console.log('  and enter the SAME room code. First in is the host.');
    console.log('\n  Press Ctrl+C to stop the server.\n');
});
