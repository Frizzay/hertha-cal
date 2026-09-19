import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

import { COMPETITIONS, config } from './config.js';
import { MatchCache } from './cache.js';
import { fetchHerthaMatches } from './openligadb.js';
import { buildCalendar } from './ics.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const cache = new MatchCache(() => fetchHerthaMatches(), config.cacheTtlMs);

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', true);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=()');
  // The site loads no third-party resources at all — that is what the privacy
  // policy promises, so it is enforced here rather than merely documented.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
      "base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
  );
  next();
});

/** Public origin of this deployment, from config or the incoming request. */
function baseUrl(req) {
  return config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
}

/**
 * Host part used to build iCalendar UIDs. A misconfigured PUBLIC_BASE_URL must
 * not take the feed down, so an unparsable value degrades to a fixed domain —
 * UIDs stay stable, which is all that actually matters to calendar clients.
 */
function uidDomain(site) {
  try {
    return new URL(site).hostname;
  } catch {
    return 'hertha-cal.invalid';
  }
}

/** Parses and clamps the feed query parameters. Unknown values fall back to defaults. */
export function parseFeedOptions(query = {}) {
  const requested = String(query.competition ?? 'all').toLowerCase();
  // hasOwn, not `in`: `in` would also accept inherited names such as "constructor".
  const competition =
    requested === 'all' || Object.hasOwn(COMPETITIONS, requested) ? requested : 'all';

  const rawAlarm = Number.parseInt(query.alarm ?? '', 10);
  const alarmMinutes = Number.isFinite(rawAlarm)
    ? Math.min(Math.max(rawAlarm, 0), 1440)
    : config.defaultAlarmMinutes;

  // past=0 drops matches that have already been played.
  const includePast = !['0', 'false', 'no'].includes(String(query.past ?? '1').toLowerCase());

  return { competition, alarmMinutes, includePast };
}

export function selectMatches(matches, { competition, includePast }, now = new Date()) {
  return matches.filter((match) => {
    if (competition !== 'all' && match.competition !== competition) return false;
    if (!includePast && Date.parse(match.kickoffUtc) < now.getTime()) return false;
    return true;
  });
}

function calendarName({ competition }) {
  if (competition === 'liga') return 'Hertha BSC – 2. Bundesliga';
  if (competition === 'pokal') return 'Hertha BSC – DFB-Pokal';
  return 'Hertha BSC – Spielplan';
}

app.get(['/hertha.ics', '/calendar.ics', '/hertha-bsc.ics'], async (req, res) => {
  // Express 4 does not catch rejections from async handlers, so everything that
  // can throw stays inside this block — otherwise the request would just hang.
  try {
    const options = parseFeedOptions(req.query);
    const snapshot = await cache.get();
    const site = baseUrl(req);

    const body = buildCalendar(selectMatches(snapshot.matches, options), {
      calendarName: calendarName(options),
      uidDomain: uidDomain(site),
      siteUrl: site,
      alarmMinutes: options.alarmMinutes,
    });

    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', `public, max-age=${Math.floor(config.cacheTtlMs / 1000)}`);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="hertha-bsc.ics"');

    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.send(body);
  } catch (error) {
    console.error(`[feed] ${error.message}`);
    res.status(503).type('text/plain; charset=utf-8');
    res.send('Spieldaten sind derzeit nicht verfügbar. Bitte später erneut versuchen.\n');
  }
});

app.get('/api/matches', async (req, res) => {
  try {
    const snapshot = await cache.get();
    const options = parseFeedOptions(req.query);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      updatedAt: snapshot.fetchedAt,
      stale: Boolean(snapshot.stale),
      seasons: snapshot.seasons,
      matches: selectMatches(snapshot.matches, options),
    });
  } catch (error) {
    console.error(`[api] ${error.message}`);
    res.status(503).json({ error: 'Spieldaten sind derzeit nicht verfügbar.' });
  }
});

app.get('/healthz', (req, res) => {
  const snapshot = cache.snapshot;
  res.json({
    status: snapshot ? 'ok' : 'starting',
    matches: snapshot?.matches?.length ?? 0,
    stale: Boolean(snapshot?.stale),
    updatedAt: snapshot?.fetchedAt ?? null,
  });
});

app.get('/impressum', (req, res) => res.sendFile(path.join(publicDir, 'impressum.html')));
app.get('/datenschutz', (req, res) => res.sendFile(path.join(publicDir, 'datenschutz.html')));

app.use(express.static(publicDir, { extensions: ['html'], maxAge: '1h' }));

app.use((req, res) => {
  res.status(404).type('text/plain; charset=utf-8').send('404 – Seite nicht gefunden\n');
});

// Only listen when this file is the process entrypoint. An ESM import runs
// before anything else in the importing module, so a NODE_ENV guard could not
// be set in time by a test file — this check cannot be raced.
const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  app.listen(config.port, () => {
    console.log(`hertha-cal läuft auf http://localhost:${config.port}`);
    if (!config.publicBaseUrl) {
      console.warn('[config] PUBLIC_BASE_URL ist nicht gesetzt – Links werden aus dem Request abgeleitet.');
    }
    cache.warm();
    // Keep the snapshot warm so no subscriber ever pays the upstream latency.
    // Floored at a minute so CACHE_TTL_MINUTES=0 cannot turn this into a busy loop.
    setInterval(() => cache.warm(), Math.max(60_000, config.cacheTtlMs)).unref();
  });
}

export { app, cache };
