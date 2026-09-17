require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const authRoutes = require('./routes/auth');
const facilityRoutes = require('./routes/facilities');
const userRoutes = require('./routes/users');
const roundRoutes = require('./routes/rounds');
const roundPackageRoutes = require('./routes/roundPackages');
const submissionRoutes = require('./routes/submissions');

const app = express();
app.set('trust proxy', 1);

app.use(helmet());
// Allow the configured frontend origin (and common local dev). Exact match required by browsers.
const allowedOrigins = [
  process.env.FRONTEND_ORIGIN,
  'https://copperbeltinterlab-beep.github.io',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
].filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // Non-browser clients (no Origin header) — allow
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) return cb(null, true);
    // If FRONTEND_ORIGIN unset, fall back to reflecting any origin in development only
    if (!process.env.FRONTEND_ORIGIN) return cb(null, true);
    // Do not pass Error to cb — that becomes a 500 and shows as "Failed to fetch"
    return cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/facilities', facilityRoutes);
app.use('/api/users', userRoutes);
app.use('/api/rounds', roundRoutes);
app.use('/api/round-packages', roundPackageRoutes);
app.use('/api/rounds', submissionRoutes); // adds /:roundId/submissions... under /api/rounds

// Basic error handler so unexpected errors return JSON, not an HTML crash page.
// Multer/file-filter errors (bad file type, too large) get their real message and a 400;
// everything else stays a generic 500 so internals aren't leaked.
app.use((err, req, res, next) => {
  console.error(err);
  if (err && (err.name === 'MulterError' || /file type/i.test(err.message || ''))) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Copperbelt ILC API listening on port ${PORT}`));
