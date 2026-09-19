import { COMPETITIONS, HERTHA_TEAM_ID, seasonsToFetch } from './config.js';

const API_BASE = 'https://api.openligadb.de';
const REQUEST_TIMEOUT_MS = 12_000;

async function getJson(path) {
  let lastError;
  // One retry: OpenLigaDB occasionally drops a connection under load.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        headers: { accept: 'application/json', 'user-agent': 'hertha-cal/1.0 (+ICS feed)' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // A season that has not been published yet answers with 404 or an empty body.
      if (response.status === 404) return [];
      if (!response.ok) throw new Error(`${path} responded ${response.status}`);
      const body = await response.text();
      if (!body.trim()) return [];
      return JSON.parse(body);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function finalScore(match) {
  const results = Array.isArray(match.matchResults) ? match.matchResults : [];
  const result =
    results.find((r) => r.resultTypeKind === 'AfterPenalties') ??
    results.find((r) => r.resultTypeKind === 'AfterExtraTime') ??
    results.find((r) => r.resultTypeKind === 'After90Minutes') ??
    results.slice().sort((a, b) => (b.resultOrderID ?? 0) - (a.resultOrderID ?? 0))[0];
  if (!result || result.pointsTeam1 == null || result.pointsTeam2 == null) return null;
  return { home: result.pointsTeam1, away: result.pointsTeam2, kind: result.resultTypeKind ?? null };
}

function normalise(match, competitionKey) {
  const home = match.team1 ?? {};
  const away = match.team2 ?? {};
  const isHome = home.teamId === HERTHA_TEAM_ID;
  const opponent = isHome ? away : home;
  const location = match.location ?? null;

  return {
    id: match.matchID,
    competition: competitionKey,
    competitionLabel: COMPETITIONS[competitionKey].label,
    season: match.leagueSeason ?? null,
    round: match.group?.groupName ?? null,
    kickoffUtc: match.matchDateTimeUTC,
    isHome,
    homeTeam: home.teamName ?? 'unbekannt',
    awayTeam: away.teamName ?? 'unbekannt',
    opponent: opponent.teamName ?? 'unbekannt',
    opponentShort: opponent.shortName || opponent.teamName || 'unbekannt',
    finished: Boolean(match.matchIsFinished),
    score: finalScore(match),
    stadium: location?.locationStadium ?? null,
    city: location?.locationCity ?? null,
    lastUpdate: match.lastUpdateDateTime ?? null,
  };
}

function involvesHertha(match) {
  return match?.team1?.teamId === HERTHA_TEAM_ID || match?.team2?.teamId === HERTHA_TEAM_ID;
}

/**
 * Fetches every competitive Hertha BSC fixture of the relevant season(s),
 * sorted by kickoff. Individual competitions are allowed to fail without
 * taking the whole feed down, but a total failure is reported to the caller.
 */
export async function fetchHerthaMatches(now = new Date()) {
  const seasons = seasonsToFetch(now);
  const jobs = [];
  for (const [key, competition] of Object.entries(COMPETITIONS)) {
    for (const season of seasons) {
      jobs.push(
        getJson(`/getmatchdata/${competition.shortcut}/${season}`)
          .then((data) => ({ key, season, data: Array.isArray(data) ? data : [] })),
      );
    }
  }

  const settled = await Promise.allSettled(jobs);
  const failures = settled.filter((r) => r.status === 'rejected');
  if (failures.length === settled.length) {
    throw new Error(`OpenLigaDB unreachable: ${failures[0].reason?.message ?? 'unknown error'}`);
  }

  const byId = new Map();
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const match of result.value.data) {
      if (!involvesHertha(match) || !match.matchDateTimeUTC) continue;
      // A match id is unique across OpenLigaDB, so this also de-duplicates
      // overlapping season windows.
      byId.set(match.matchID, normalise(match, result.value.key));
    }
  }

  const matches = [...byId.values()].sort(
    (a, b) => Date.parse(a.kickoffUtc) - Date.parse(b.kickoffUtc),
  );

  return {
    matches,
    seasons,
    partial: failures.length > 0,
    fetchedAt: new Date().toISOString(),
  };
}
