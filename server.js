const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const webpush = require('web-push');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ORGANIZER_PIN = process.env.ORGANIZER_PIN || '1234';
const PORT = process.env.PORT || 3000;

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || 'BI5UKKYXtUMWH0bYK-UrKPfeNwjAKXFzH3bcLckpvoKjjFYvdYjLOhUtFfUmagi_DqRXDK_pld-REAa7LgY7VeQ';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'GN0J72K1E9Yi30TBzZDcvvLeuBXTT11JW692ftfF2pk';
webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL || 'admin@example.com'}`,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

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
      id                SERIAL PRIMARY KEY,
      name              VARCHAR(40)  NOT NULL,
      mobile            VARCHAR(30)  NOT NULL,
      token             VARCHAR(64)  UNIQUE NOT NULL,
      status            VARCHAR(20)  DEFAULT 'pending',
      status_updated_at TIMESTAMPTZ,
      joined_at         TIMESTAMPTZ  DEFAULT NOW(),
      last_seen         TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE(mobile)
    )
  `);
  // Safe migrations for existing tables
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'`);
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ`);
}

// --- In-memory online tracking: socketId -> { token, name, mobile, status, number } ---
const onlineSockets = new Map();
let participantCounter = 0; // used when no DB

// --- Push subscriptions: token -> PushSubscription ---
const pushSubscriptions = new Map();

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

async function dbSetStatus(token, status) {
  if (!pool) return;
  await pool.query(
    'UPDATE participants SET status = $1, status_updated_at = NOW() WHERE token = $2',
    [status, token]
  );
}

async function getParticipantsList() {
  const onlineTokens = new Map(
    [...onlineSockets.entries()].map(([sid, p]) => [p.token, sid])
  );

  if (pool) {
    const r = await pool.query(
      'SELECT id, name, mobile, token, status, status_updated_at, joined_at FROM participants ORDER BY joined_at ASC'
    );
    return r.rows.map(row => ({
      number:          row.id,
      name:            row.name,
      mobile:          row.mobile,
      token:           row.token,
      status:          row.status || 'pending',
      statusUpdatedAt: row.status_updated_at,
      joinedAt:        row.joined_at,
      online:          onlineTokens.has(row.token),
      socketId:        onlineTokens.get(row.token) || null,
    }));
  }

  // In-memory fallback
  return [...onlineSockets.entries()].map(([sid, p]) => ({
    number:  p.number,
    name:    p.name,
    mobile:  p.mobile,
    token:   p.token,
    status:  p.status || 'pending',
    joinedAt: p.joinedAt,
    online:  true,
    socketId: sid,
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
            message: 'This mobile number is already registered.',
          });
          return;
        }
        const participant = await dbCreate(trimName, trimMobile);
        onlineSockets.set(socket.id, {
          number:  participant.id,
          token:   participant.token,
          name:    participant.name,
          mobile:  participant.mobile,
          status:  participant.status || 'pending',
          joinedAt: participant.joined_at,
        });
        socket.join('participants');
        socket.emit('registered', { name: participant.name, token: participant.token, number: participant.id, returning: false });
      } else {
        const dup = [...onlineSockets.values()].find(p => p.mobile === trimMobile);
        if (dup) {
          socket.emit('register-error', { field: 'mobile', message: 'This mobile number is already registered.' });
          return;
        }
        const token = crypto.randomBytes(32).toString('hex');
        participantCounter++;
        const entry = { token, name: trimName, mobile: trimMobile, status: 'pending', joinedAt: new Date(), number: participantCounter };
        onlineSockets.set(socket.id, entry);
        socket.join('participants');
        socket.emit('registered', { name: trimName, token, number: participantCounter, returning: false });
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
      if (pool) {
        const participant = await dbFindByToken(token);
        if (!participant) { socket.emit('token-invalid'); return; }
        await dbTouchLastSeen(token);
        onlineSockets.set(socket.id, {
          number:  participant.id,
          token:   participant.token,
          name:    participant.name,
          mobile:  participant.mobile,
          status:  participant.status || 'pending',
          joinedAt: participant.joined_at,
        });
        socket.join('participants');
        socket.emit('registered', { name: participant.name, token: participant.token, number: participant.id, status: participant.status || 'pending', returning: true });
        io.to('organizers').emit('participants-update', await getParticipantsList());
      } else {
        socket.emit('token-invalid');
      }
    } catch (err) {
      console.error('reconnect error:', err);
      socket.emit('token-invalid');
    }
  });

  // Save push subscription from a participant
  socket.on('save-push-subscription', ({ token, subscription }) => {
    if (token && subscription) {
      pushSubscriptions.set(token, subscription);
    }
  });

  // Participant responds to a buzz
  socket.on('buzz-response', async ({ token, status }) => {
    if (!['coming', 'declined'].includes(status)) return;

    const p = onlineSockets.get(socket.id);
    if (!p) return;

    // Update status
    if (pool) {
      await dbSetStatus(token, status);
    }
    // Update in-memory entry
    if (onlineSockets.has(socket.id)) {
      onlineSockets.get(socket.id).status = status;
    }

    // Notify organizers
    io.to('organizers').emit('buzz-response-received', {
      name: p.name,
      status,
      token,
      time: new Date(),
    });
    io.to('organizers').emit('participants-update', await getParticipantsList());
  });

  // Participant leaves the queue
  socket.on('leave-queue', async ({ token }) => {
    try {
      if (pool) {
        await pool.query('DELETE FROM participants WHERE token = $1', [token]);
      }
      pushSubscriptions.delete(token);
      onlineSockets.delete(socket.id);
      socket.leave('participants');
      socket.emit('left-queue');
      io.to('organizers').emit('participants-update', await getParticipantsList());
    } catch (err) {
      console.error('leave-queue error:', err);
    }
  });

  // Organiser sets a participant's status (check-in, done, etc.)
  socket.on('organizer-set-status', async ({ token, status }) => {
    if (!['pending', 'coming', 'checked-in', 'done', 'declined'].includes(status)) return;
    try {
      if (pool) {
        await pool.query(
          'UPDATE participants SET status = $1, status_updated_at = NOW() WHERE token = $2',
          [status, token]
        );
      }
      // Notify the participant's socket if online
      for (const [sid, p] of onlineSockets.entries()) {
        if (p.token === token) {
          p.status = status;
          io.to(sid).emit('status-changed', { status });
          break;
        }
      }
      // Send push for 'done' (so they see the thank-you even if app is closed),
      // then delete the participant so they're free to rejoin with the same number
      if (status === 'done') {
        const sub = pushSubscriptions.get(token);
        if (sub) {
          try {
            await webpush.sendNotification(sub, JSON.stringify({
              title: '🙏 Thank you!',
              body: 'You\'ve completed your visit. Thanks for participating!',
              url: '/join',
            }));
          } catch (_) {}
        }
        if (pool) {
          await pool.query('DELETE FROM participants WHERE token = $1', [token]);
        }
        pushSubscriptions.delete(token);
        for (const [sid, p] of onlineSockets.entries()) {
          if (p.token === token) { onlineSockets.delete(sid); break; }
        }
      }
      io.to('organizers').emit('participants-update', await getParticipantsList());
    } catch (err) {
      console.error('organizer-set-status error:', err);
    }
  });

  // Organiser deletes a participant entirely
  socket.on('delete-participant', async ({ token }) => {
    try {
      if (pool) {
        await pool.query('DELETE FROM participants WHERE token = $1', [token]);
      }
      pushSubscriptions.delete(token);
      // Kick them out if they're online
      for (const [sid, p] of onlineSockets.entries()) {
        if (p.token === token) {
          io.to(sid).emit('left-queue');
          onlineSockets.delete(sid);
          break;
        }
      }
      io.to('organizers').emit('participants-update', await getParticipantsList());
    } catch (err) {
      console.error('delete-participant error:', err);
    }
  });

  // Organiser resets a participant's status back to pending
  socket.on('reset-status', async ({ token }) => {
    if (pool) {
      await pool.query(
        "UPDATE participants SET status = 'pending', status_updated_at = NULL WHERE token = $1",
        [token]
      );
    }
    // Update in-memory if online
    for (const [sid, p] of onlineSockets.entries()) {
      if (p.token === token) { p.status = 'pending'; break; }
    }
    io.to('organizers').emit('participants-update', await getParticipantsList());
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

    function sendPush(token, body) {
      const sub = pushSubscriptions.get(token);
      if (!sub) return;
      webpush.sendNotification(sub, JSON.stringify({
        title: '📳 BUZZ!',
        body,
        url: '/join',
      })).catch(() => pushSubscriptions.delete(token));
    }

    if (targetToken === 'all') {
      const list = await getParticipantsList();
      const pending = list.filter(p => p.status === 'pending');
      // Socket buzz for online participants
      pending.filter(p => p.online).forEach(p => {
        io.to(p.socketId).emit('buzzed', { message: 'BUZZ! The organiser is calling everyone!' });
      });
      // Web push for all subscribed pending participants (including offline)
      pending.forEach(p => sendPush(p.token, 'The organiser is calling everyone!'));
      io.to('organizers').emit('buzz-sent', { targetToken: 'all' });
    } else {
      const entry = [...onlineSockets.entries()].find(([, v]) => v.token === targetToken);
      if (entry) {
        io.to(entry[0]).emit('buzzed', { message: 'BUZZ! The organiser is calling you!' });
      }
      sendPush(targetToken, 'The organiser is calling you!');
      io.to('organizers').emit('buzz-sent', { targetToken });
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
app.get('/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

app.get('/qr', async (req, res) => {
  const host = req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const joinUrl = `${protocol}://${host}/join`;
  try {
    const qr = await QRCode.toDataURL(joinUrl, {
      width: 300, margin: 2,
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

initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log('');
    console.log('  📳 BUZZER SERVER');
    console.log(`  Local:     http://localhost:${PORT}`);
    console.log(`  Network:   http://${ip}:${PORT}`);
    console.log(`  Join:      http://${ip}:${PORT}/join`);
    console.log(`  Organiser: http://${ip}:${PORT}/organizer`);
    console.log(`  PIN:       ${ORGANIZER_PIN}`);
    console.log('');
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
