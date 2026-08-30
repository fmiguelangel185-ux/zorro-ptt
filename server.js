'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const helmet = require('helmet');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = Number(process.env.PORT || 10000);
const PTT_PASSWORD = process.env.PTT_PASSWORD || '';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

if (!PTT_PASSWORD) {
  console.warn('WARNING: PTT_PASSWORD is not set. Login will be disabled until you configure it.');
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      mediaSrc: ["'self'", 'blob:'],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const sessions = new Map();
const clients = new Map(); // ws -> { id, token }
let currentTalkerId = null;

function safeEqual(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function issueSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function validSession(token) {
  if (!token || !sessions.has(token)) return false;
  const expires = sessions.get(token);
  if (Date.now() > expires) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function json(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload, except = null) {
  for (const ws of clients.keys()) {
    if (ws !== except) json(ws, payload);
  }
}

function sendChannelState() {
  const count = clients.size;
  for (const [ws, meta] of clients) {
    const state = currentTalkerId
      ? (currentTalkerId === meta.id ? 'transmitting' : 'busy')
      : 'free';
    json(ws, { type: 'channel-state', state, peers: count });
  }
}

function pairPeers() {
  const sockets = [...clients.keys()];
  if (sockets.length === 2) {
    json(sockets[0], { type: 'peer-ready', initiator: true });
    json(sockets[1], { type: 'peer-ready', initiator: false });
  } else if (sockets.length < 2) {
    for (const ws of sockets) json(ws, { type: 'peer-waiting' });
  }
  sendChannelState();
}

app.post('/api/login', (req, res) => {
  if (!PTT_PASSWORD) {
    return res.status(503).json({ ok: false, error: 'Servidor sin contraseña configurada.' });
  }

  const password = req.body?.password;
  if (typeof password !== 'string' || !safeEqual(password, PTT_PASSWORD)) {
    return res.status(401).json({ ok: false, error: 'Contraseña incorrecta.' });
  }

  const token = issueSession();
  res.json({ ok: true, token });
});

app.get('/api/config', (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map(v => v.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }

  res.json({ iceServers });
});

app.get('/health', (_req, res) => res.status(200).send('ok'));

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    socket.destroy();
    return;
  }

  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token');
  if (!validSession(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  if (clients.size >= 2) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, token);
  });
});

wss.on('connection', (ws, _req, token) => {
  const id = crypto.randomUUID();
  clients.set(ws, { id, token });
  json(ws, { type: 'welcome', id });
  pairPeers();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const meta = clients.get(ws);
    if (!meta) return;

    if (msg.type === 'signal' && msg.data) {
      broadcast({ type: 'signal', data: msg.data }, ws);
      return;
    }

    if (msg.type === 'ptt-down') {
      if (!currentTalkerId) {
        currentTalkerId = meta.id;
        json(ws, { type: 'ptt-granted' });
        sendChannelState();
      } else if (currentTalkerId === meta.id) {
        json(ws, { type: 'ptt-granted' });
      } else {
        json(ws, { type: 'ptt-denied' });
      }
      return;
    }

    if (msg.type === 'ptt-up' && currentTalkerId === meta.id) {
      currentTalkerId = null;
      sendChannelState();
    }
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    if (meta && currentTalkerId === meta.id) currentTalkerId = null;
    clients.delete(ws);
    pairPeers();
  });

  ws.on('error', () => {});
});

setInterval(() => {
  const now = Date.now();
  for (const [token, expires] of sessions) {
    if (now > expires) sessions.delete(token);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ZORRO PTT listening on port ${PORT}`);
});
