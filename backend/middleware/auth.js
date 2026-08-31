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

module.exports = { requireAuth, requireRole };
