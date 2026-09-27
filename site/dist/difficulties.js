// Deezer rank is a popularity score (higher is more popular), not a chart position.
export const DIFFICULTIES = {
  easy: { label: 'Easy', summary: 'Top 100', description: 'Preview-enabled songs from Deezer’s Top 100. Pick a genre for its chart, or All genres for the overall chart.' },
  medium: { label: 'Medium', summary: 'Popular favourites', description: 'Popular tracks from your genre’s stations and artists.', minRank: 500000, maxRank: Infinity },
  hard: { label: 'Hard', summary: 'Lesser-known tracks', description: 'Step away from the hits with less popular tracks.', minRank: 200000, maxRank: 500000 },
  expert: { label: 'Expert', summary: 'Deep cuts', description: 'Dig into rarely played tracks from your genre’s artists.', minRank: 100000, maxRank: 200000 },
  impossible: { label: 'Impossible', summary: 'The obscure stuff', description: 'The lowest-popularity tracks we can find. This one is for the dedicated diggers.', minRank: 0, maxRank: 100000 },
};
export const isDifficulty = value => Object.hasOwn(DIFFICULTIES, value);
export function matchesDifficulty(track, difficulty) {
  const level = DIFFICULTIES[difficulty];
  return !!level && difficulty !== 'easy' && Number.isFinite(track.rank) && track.rank >= level.minRank && track.rank < level.maxRank;
}
