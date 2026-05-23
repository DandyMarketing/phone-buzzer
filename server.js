const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ORGANIZER_PIN = process.env.ORGANIZER_PIN || '1234';
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory participant store: socketId -> { name, id, joinedAt }
const participants = new Map();
let participantCounter = 0;

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function getParticipantsList() {
  return Array.from(participants.values()).map(({ name, id, joinedAt }) => ({
    name,
    id,
    joinedAt,
    socketId: [...participants.entries()].find(([, v]) => v.id === id)?.[0],
  }));
}

app.get('/qr', async (req, res) => {
  const host = req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const joinUrl = `${protocol}://${host}/join`;
  try {
    const qrDataUrl = await QRCode.toDataURL(joinUrl, {
      width: 300,
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' },
    });
    res.json({ qr: qrDataUrl, url: joinUrl });
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

app.post('/verify-pin', (req, res) => {
  const { pin } = req.body;
  res.json({ valid: pin === ORGANIZER_PIN });
});

io.on('connection', (socket) => {
  // --- Participant events ---
  socket.on('register', ({ name }) => {
    if (!name || name.trim().length === 0) return;
    const trimmed = name.trim().slice(0, 40);
    const id = ++participantCounter;
    participants.set(socket.id, { name: trimmed, id, joinedAt: Date.now() });
    socket.join('participants');
    socket.emit('registered', { id, name: trimmed });
    io.to('organizers').emit('participants-update', getParticipantsList());
  });

  // --- Organizer events ---
  socket.on('join-organizer', ({ pin }) => {
    if (pin !== ORGANIZER_PIN) {
      socket.emit('auth-error', 'Invalid PIN');
      return;
    }
    socket.join('organizers');
    socket.emit('auth-ok');
    socket.emit('participants-update', getParticipantsList());
  });

  socket.on('buzz', ({ targetSocketId }) => {
    // Only organizers can buzz — they won't be in participants map
    if (participants.has(socket.id)) return;

    if (targetSocketId === 'all') {
      io.to('participants').emit('buzzed', { message: 'BUZZ! The organiser is calling everyone!' });
    } else {
      const target = participants.get(targetSocketId);
      if (target) {
        io.to(targetSocketId).emit('buzzed', { message: `BUZZ! The organiser is calling you!` });
      }
    }
  });

  socket.on('disconnect', () => {
    if (participants.has(socket.id)) {
      participants.delete(socket.id);
      io.to('organizers').emit('participants-update', getParticipantsList());
    }
  });
});

// Serve pages
app.get('/', (req, res) => res.redirect('/join'));
app.get('/join', (req, res) => res.sendFile(path.join(__dirname, 'public', 'join.html')));
app.get('/organizer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'organizer.html')));

server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log('');
  console.log('  ██████╗ ██╗   ██╗███████╗███████╗███████╗██████╗ ');
  console.log('  ██╔══██╗██║   ██║╚══███╔╝╚══███╔╝██╔════╝██╔══██╗');
  console.log('  ██████╔╝██║   ██║  ███╔╝   ███╔╝ █████╗  ██████╔╝');
  console.log('  ██╔══██╗██║   ██║ ███╔╝   ███╔╝  ██╔══╝  ██╔══██╗');
  console.log('  ██████╔╝╚██████╔╝███████╗███████╗███████╗██║  ██║');
  console.log('  ╚═════╝  ╚═════╝ ╚══════╝╚══════╝╚══════╝╚═╝  ╚═╝');
  console.log('');
  console.log(`  Server running at:`);
  console.log(`    Local:    http://localhost:${PORT}`);
  console.log(`    Network:  http://${localIP}:${PORT}`);
  console.log('');
  console.log(`  Participant join page: http://${localIP}:${PORT}/join`);
  console.log(`  Organiser dashboard:   http://${localIP}:${PORT}/organizer`);
  console.log('');
  console.log(`  Organiser PIN: ${ORGANIZER_PIN}`);
  console.log('  (Set ORGANIZER_PIN env variable to change)');
  console.log('');
});
