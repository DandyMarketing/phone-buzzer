const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ORGANIZER_PIN = process.env.ORGANIZER_PIN || '1234';
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Database setup ---
let pool = null;

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  console.log('  PostgreSQL: connected via DATABASE_URL');
} else {
  console.log('  ⚠️  No DATABASE_URL set — running in-memory (no persistence)');
}

async function initDB() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS participants (
      id       SERIAL PRIMARY KEY,
      name     VARCHAR(40)  NOT NULL,
      mobile   VARCHAR(30)  NOT NULL,
      token    VARCHAR(64)  UNIQUE NOT NULL,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(mobile)
    )
  `);
}

// --- In-memory online tracking: socketId -> { token, name, mobile } ---
const onlineSockets = new Map();

// --- DB helpers ---
async function dbFindByMobile(mobile) {
  if (!pool) return null;
  const r = await pool.query('SELECT * FROM participants WHERE mobile = $1', [mobile]);
  return r.rows[0] || null;
}

async function dbFindByToken(token) {
  if (!pool) return null;
  const r = await pool.query('SELECT * FROM participants WHERE token = $1', [token]);
  return r.rows[0] || null;
}

async function dbCreate(name, mobile) {
  const token = crypto.randomBytes(32).toString('hex');
  const r = await pool.query(
    'INSERT INTO participants (name, mobile, token) VALUES ($1, $2, $3) RETURNING *',
    [name, mobile, token]
  );
  return r.rows[0];
}

async function dbTouchLastSeen(token) {
  if (!pool) return;
  await pool.query('UPDATE participants SET last_seen = NOW() WHERE token = $1', [token]);
}

async function getParticipantsList() {
  const onlineTokens = new Map(
    [...onlineSockets.entries()].map(([sid, p]) => [p.token, sid])
  );

  if (pool) {
    const r = await pool.query(
      'SELECT name, mobile, token, joined_at FROM participants ORDER BY joined_at ASC'
    );
    return r.rows.map(row => ({
      name: row.name,
      mobile: row.mobile,
      token: row.token,
      joinedAt: row.joined_at,
      online: onlineTokens.has(row.token),
      socketId: onlineTokens.get(row.token) || null,
    }));
  }

  // In-memory fallback
  return [...onlineSockets.values()].map(p => ({
    name: p.name,
    mobile: p.mobile,
    token: p.token,
    joinedAt: p.joinedAt,
    online: true,
    socketId: [...onlineSockets.entries()].find(([, v]) => v.token === p.token)?.[0],
  }));
}

// --- Socket.io ---
io.on('connection', (socket) => {

  // New registration
  socket.on('register', async ({ name, mobile }) => {
    const trimName   = (name   || '').trim().slice(0, 40);
    const trimMobile = (mobile || '').trim().slice(0, 30);
    if (!trimName || !trimMobile) return;

    try {
      if (pool) {
        const existing = await dbFindByMobile(trimMobile);
        if (existing) {
          socket.emit('register-error', {
            field: 'mobile',
            message: 'This mobile number is already registered. Rejoin using your token link, or contact the organiser.',
          });
          return;
        }
        const participant = await dbCreate(trimName, trimMobile);
        onlineSockets.set(socket.id, {
          token: participant.token,
          name: participant.name,
          mobile: participant.mobile,
          joinedAt: participant.joined_at,
        });
        socket.join('participants');
        socket.emit('registered', { name: participant.name, token: participant.token, returning: false });
      } else {
        // In-memory fallback: check for duplicate mobile
        const dup = [...onlineSockets.values()].find(p => p.mobile === trimMobile);
        if (dup) {
          socket.emit('register-error', {
            field: 'mobile',
            message: 'This mobile number is already registered.',
          });
          return;
        }
        const token = crypto.randomBytes(32).toString('hex');
        const entry = { token, name: trimName, mobile: trimMobile, joinedAt: new Date() };
        onlineSockets.set(socket.id, entry);
        socket.join('participants');
        socket.emit('registered', { name: trimName, token, returning: false });
      }

      io.to('organizers').emit('participants-update', await getParticipantsList());
    } catch (err) {
      console.error('register error:', err);
      socket.emit('register-error', { message: 'Registration failed. Please try again.' });
    }
  });

  // Returning user reconnect via token
  socket.on('reconnect-token', async ({ token }) => {
    try {
      let participant = null;

      if (pool) {
        participant = await dbFindByToken(token);
        if (!participant) { socket.emit('token-invalid'); return; }
        await dbTouchLastSeen(token);
      } else {
        // In-memory: find by token in existing map (won't survive restart)
        socket.emit('token-invalid');
        return;
      }

      onlineSockets.set(socket.id, {
        token: participant.token,
        name: participant.name,
        mobile: participant.mobile,
        joinedAt: participant.joined_at,
      });
      socket.join('participants');
      socket.emit('registered', { name: participant.name, token: participant.token, returning: true });
      io.to('organizers').emit('participants-update', await getParticipantsList());
    } catch (err) {
      console.error('reconnect error:', err);
      socket.emit('token-invalid');
    }
  });

  // Organiser joins
  socket.on('join-organizer', async ({ pin }) => {
    if (pin !== ORGANIZER_PIN) {
      socket.emit('auth-error', 'Invalid PIN');
      return;
    }
    socket.join('organizers');
    socket.emit('auth-ok');
    socket.emit('participants-update', await getParticipantsList());
  });

  // Buzz
  socket.on('buzz', async ({ targetToken }) => {
    if (onlineSockets.has(socket.id)) return; // participants can't buzz

    if (targetToken === 'all') {
      io.to('participants').emit('buzzed', { message: 'BUZZ! The organiser is calling everyone!' });
      // Flash all in organiser view
      io.to('organizers').emit('buzz-sent', { targetToken: 'all' });
    } else {
      const entry = [...onlineSockets.entries()].find(([, v]) => v.token === targetToken);
      if (entry) {
        const [sid, p] = entry;
        io.to(sid).emit('buzzed', { message: `BUZZ! The organiser is calling you!` });
        io.to('organizers').emit('buzz-sent', { targetToken });
      }
    }
  });

  socket.on('disconnect', async () => {
    if (onlineSockets.has(socket.id)) {
      onlineSockets.delete(socket.id);
      io.to('organizers').emit('participants-update', await getParticipantsList());
    }
  });
});

// --- Routes ---
app.get('/qr', async (req, res) => {
  const host = req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const joinUrl = `${protocol}://${host}/join`;
  try {
    const qr = await QRCode.toDataURL(joinUrl, {
      width: 300,
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' },
    });
    res.json({ qr, url: joinUrl });
  } catch {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

app.get('/',          (req, res) => res.redirect('/join'));
app.get('/join',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'join.html')));
app.get('/organizer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'organizer.html')));

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// --- Boot ---
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log('');
    console.log('  📳 BUZZER SERVER');
    console.log('');
    console.log(`  Local:     http://localhost:${PORT}`);
    console.log(`  Network:   http://${ip}:${PORT}`);
    console.log('');
    console.log(`  Join page: http://${ip}:${PORT}/join`);
    console.log(`  Organiser: http://${ip}:${PORT}/organizer`);
    console.log(`  PIN:       ${ORGANIZER_PIN}`);
    console.log('');
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
