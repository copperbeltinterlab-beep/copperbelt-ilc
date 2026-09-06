function toDateOnly(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

// A round package is closed either because an admin explicitly closed it, or because its
// deadline has passed. Every place that needs to know "is this round still open" — the
// listing endpoint, the result-submission endpoint — should go through this single function
// so they can never disagree with each other.
function computeStatus(p) {
  if (p.closed_at) return 'closed';
  if (p.deadline) {
    const deadlinePassed = new Date(toDateOnly(p.deadline) + 'T23:59:59') < new Date();
    if (deadlinePassed) return 'closed';
  }
  return 'active';
}

module.exports = { computeStatus, toDateOnly };
