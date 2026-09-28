import test from 'node:test';
import assert from 'node:assert/strict';
import { newRound, makeGuess, passSong, hasWon, isFinished, clipLength, restoreRound, normalize } from '../dist/game.js';
const songs = [{ id: 1, title: 'One', artist: 'Artist' }, { id: 2, title: 'Two', artist: 'Artist' }];
test('skips unlock all six clips and finish the round', () => {
  const round = newRound(songs[0], '2026-09-26');
  for (const seconds of [1, 2, 4, 7, 11, 16]) { assert.equal(clipLength(round), seconds); assert.equal(isFinished(round), false); makeGuess(round, null); }
  assert.equal(isFinished(round), true); assert.equal(hasWon(round), false); assert.equal(makeGuess(round, 1), false);
});
test('correct answers win and repeated guesses do not consume attempts', () => {
  const round = newRound(songs[0], '2026-09-26'); makeGuess(round, 2);
  assert.equal(makeGuess(round, 2), false); assert.equal(round.attempts.length, 1);
  makeGuess(round, 1); assert.equal(hasWon(round), true); assert.equal(isFinished(round), true);
});
test('saved progress restores only for the same daily song and date', () => {
  const round = newRound(songs[0], '2026-09-26'); makeGuess(round, 2);
  assert.deepEqual(restoreRound(round, songs[0], round.date, songs), round);
  assert.equal(restoreRound(round, songs[0], '2026-09-27', songs).attempts.length, 0);
  assert.equal(restoreRound(round, songs[1], round.date, songs).attempts.length, 0);
  assert.equal(restoreRound({ ...round, attempts: [{ id: 999 }] }, songs[0], round.date, songs).attempts.length, 0);
});
test('normalization ignores accents and punctuation', () => { assert.equal(normalize('Beyoncé'), normalize('beyonce')); assert.equal(normalize('Still D.R.E.'), 'stilldre'); });

test('passing a song ends it without a win, blocks further guesses and survives daily restore', () => {
  const round = newRound(songs[0], '2026-09-28');
  makeGuess(round, 2);
  assert.equal(passSong(round), true);
  assert.equal(isFinished(round), true); assert.equal(hasWon(round), false);
  assert.equal(makeGuess(round, 1), false); assert.equal(passSong(round), false);
  assert.equal(round.attempts.length, 1); assert.equal(clipLength(round), 16);
  assert.deepEqual(restoreRound(round, songs[0], round.date, songs), round);
  assert.equal(isFinished(restoreRound(round, songs[0], '2026-09-29', songs)), false);
});
