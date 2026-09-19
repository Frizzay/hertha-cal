import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

import { config } from './config.js';
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

const CALENDAR_NAME = 'Hertha BSC – Spielplan';
// Canonical feed path. The other two are kept as aliases.
const FEED_PATH = '/hertha.ics';

app.get([FEED_PATH, '/calendar.ics', '/hertha-bsc.ics'], async (req, res) => {
  // Express 4 does not catch rejections from async handlers, so everything that
  // can throw stays inside this block — otherwise the request would just hang.
  try {
    const snapshot = await cache.get();
    const site = baseUrl(req);

    // One feed, every competitive fixture of the season, played ones included.
    const body = buildCalendar(snapshot.matches, {
      calendarName: CALENDAR_NAME,
      uidDomain: uidDomain(site),
      siteUrl: site,
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
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      updatedAt: snapshot.fetchedAt,
      stale: Boolean(snapshot.stale),
      seasons: snapshot.seasons,
      matches: snapshot.matches,
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

/** Escapes a value for use inside a double-quoted HTML attribute. */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/*
 * The address shown on the landing page has to be the canonical public one, not
 * whatever host the browser happened to reach the container on. PUBLIC_BASE_URL
 * is set by the operator, so it is baked into the page once at start-up.
 *
 * When it is unset the placeholder falls back to the relative path, which still
 * reads sensibly without JavaScript, and app.js turns it into an absolute URL
 * using the page's own origin. The request's Host header is deliberately NOT
 * used here: it is attacker-controlled, and this value lands in the markup.
 */
const landingPage = readFileSync(path.join(publicDir, 'index.html'), 'utf8').replaceAll(
  '{{FEED_URL}}',
  config.publicBaseUrl ? escapeAttr(`${config.publicBaseUrl}${FEED_PATH}`) : FEED_PATH,
);

// Registered ahead of express.static, which would otherwise serve the raw file.
app.get(['/', '/index.html'], (req, res) => {
  res.type('html').send(landingPage);
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

export { app, cache, landingPage };
