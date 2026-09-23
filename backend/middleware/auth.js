const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in.' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, name, role, facilityId }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
  }
}

// Usage: requireRole('superadmin') or requireRole('superadmin', 'facilityadmin')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    next();
  };
}

/**
 * Laboratory result entry (drafts, submit, mine status/feedback).
 * - Facility Users: always allowed.
 * - Facility Admins: only when their facility is participant-only
 *   (can_provide_rounds = false). Sample-provider Facility Admins
 *   prepare/provide rounds and must not enter results.
 */
function requireResultEntry() {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not signed in.' });
    }
    if (req.user.role === 'user') return next();
    if (req.user.role === 'facilityadmin') {
      try {
        const pool = require('../db');
        const { rows } = await pool.query(
          'select can_provide_rounds from facilities where id = $1',
          [req.user.facilityId]
        );
        if (rows[0] && rows[0].can_provide_rounds === false) return next();
        return res.status(403).json({
          error: 'Facility Admins at sample-providing facilities cannot enter results. Result entry is for participant facilities (or Facility Users).',
        });
      } catch (e) {
        console.error('requireResultEntry:', e.message);
        return res.status(500).json({ error: 'Could not verify facility permissions.' });
      }
    }
    return res.status(403).json({ error: 'You do not have permission to enter results.' });
  };
}

module.exports = { requireAuth, requireRole, requireResultEntry };
