import { CLIPS } from './game.js';

export { CLIPS };
export const SKIP_MULTIPLIER = 0.8;
export function clipStepFor(elapsed, unlockedStep = 0) {
  return Math.min(CLIPS.length - 1, Math.max(0, Math.floor(elapsed / 10000), unlockedStep));
}
export function pointsFor(elapsed, skips = 0) {
  const base = Math.max(100, 1000 - Math.floor(Math.max(0, elapsed) / 60000 * 900));
  return Math.floor(base * SKIP_MULTIPLIER ** skips);
}
