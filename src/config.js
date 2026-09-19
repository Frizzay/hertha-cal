const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: int(process.env.PORT, 3000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  cacheTtlMs: int(process.env.CACHE_TTL_MINUTES, 30) * 60_000,
  trustProxy: process.env.TRUST_PROXY === '1',
};

// Hertha BSC as identified by OpenLigaDB.
export const HERTHA_TEAM_ID = 54;

// Competitions the feed covers. `shortcut` is the OpenLigaDB league key, and
// `emoji` prefixes the event title so the competition is obvious at a glance in
// a month view.
export const COMPETITIONS = {
  liga: { shortcut: 'bl2', label: '2. Bundesliga', emoji: '⚽' },
  pokal: { shortcut: 'dfb', label: 'DFB-Pokal', emoji: '🏆' },
};

// Every event carries these reminders, in minutes before kickoff.
export const ALARM_MINUTES = [30, 5];

// A football season labelled 2026 runs from summer 2026 into spring 2027.
// From July onwards the new season is the current one.
export function currentSeason(now = new Date()) {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? year : year - 1;
}

// From May onwards the fixture list for the next season starts to appear, so we
// probe it as well and merge whatever is already published.
export function seasonsToFetch(now = new Date()) {
  const season = currentSeason(now);
  const month = now.getUTCMonth();
  return month >= 4 && month <= 5 ? [season, season + 1] : [season];
}
