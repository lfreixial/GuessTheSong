export const CLIPS = [1, 2, 4, 7, 11, 16];
export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);
export const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function sameSong(a, b) {
  const title = song => normalize(song.title.split(/\s*[([]|\s+-\s+|\s+feat\.?\s/i)[0]);
  return a.id === b.id || (normalize(a.artist) === normalize(b.artist) && title(a) === title(b));
}
export function newRound(track, date) { return { trackId: track.id, date, attempts: [] }; }
export const hasWon = round => round.attempts.some(a => a.id === round.trackId);
export const isFinished = round => round.passed === true || hasWon(round) || round.attempts.length >= CLIPS.length;
export const clipLength = round => CLIPS[round.passed ? CLIPS.length - 1 : Math.min(round.attempts.length, CLIPS.length - 1)];
export function makeGuess(round, id) {
  if (isFinished(round)) return false;
  if (id !== null && round.attempts.some(a => a.id === id)) return false;
  round.attempts.push({ id });
  return true;
}
export function passSong(round) {
  if (isFinished(round)) return false;
  round.passed = true;
  return true;
}
export function restoreRound(value, track, date, catalog) {
  if (!value || value.date !== date || value.trackId !== track.id || !Array.isArray(value.attempts) || value.attempts.length > 6) return newRound(track, date);
  const restored = newRound(track, date);
  for (const a of value.attempts) {
    if (!a || (a.id !== null && !catalog.some(s => s.id === a.id)) || !makeGuess(restored, a.id)) return newRound(track, date);
  }
  if (value.passed === true && !hasWon(restored)) restored.passed = true;
  return restored;
}
