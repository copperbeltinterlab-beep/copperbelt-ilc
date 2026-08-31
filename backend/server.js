require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const facilityRoutes = require('./routes/facilities');
const userRoutes = require('./routes/users');
const roundRoutes = require('./routes/rounds');
const submissionRoutes = require('./routes/submissions');

const app = express();

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/facilities', facilityRoutes);
app.use('/api/users', userRoutes);
app.use('/api/rounds', roundRoutes);
app.use('/api/rounds', submissionRoutes); // adds /:roundId/submissions... under /api/rounds

// Basic error handler so unexpected errors return JSON, not an HTML crash page
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Copperbelt ILC API listening on port ${PORT}`));
