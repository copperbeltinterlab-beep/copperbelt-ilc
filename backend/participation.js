// A Facility User may see/act on a round if it's open to everyone ('all'), or if their
// facility is explicitly listed as a participant ('selected'). Facility Admins and Super
// Admins always see every round regardless — they need full visibility to manage/oversee —
// so callers should only apply this check for role 'user'.
function isEligibleParticipant(round, facilityId) {
  if (round.participation_mode !== 'selected') return true;
  const list = round.participant_facility_ids || [];
  return list.map(String).includes(String(facilityId));
}

module.exports = { isEligibleParticipant };
