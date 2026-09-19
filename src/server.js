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

/**
 * Short content hash of a file in public/. It goes into the asset URLs so a
 * changed stylesheet reaches browsers immediately: without it the URL stays
 * identical, the cached copy stays valid for its full max-age, and an edit
 * simply does not show up.
 */
function assetVersion(file) {
  try {
    return createHash('sha256')
      .update(readFileSync(path.join(publicDir, file)))
      .digest('base64url')
      .slice(0, 10);
  } catch {
    return 'dev';
  }
}

/**
 * Fills in the placeholders of a page in public/.
 *
 * FEED_URL: the address shown on the landing page has to be the canonical
 * public one, not whatever host the browser happened to reach the container on.
 * PUBLIC_BASE_URL is set by the operator, so it is baked in here. When it is
 * unset the placeholder falls back to the relative path, which still reads
 * sensibly without JavaScript, and app.js turns it into an absolute URL using
 * the page's own origin. The request's Host header is deliberately NOT used:
 * it is attacker-controlled, and this value lands in the markup.
 */
function renderPage(file) {
  return readFileSync(path.join(publicDir, file), 'utf8')
    .replaceAll(
      '{{FEED_URL}}',
      config.publicBaseUrl ? escapeAttr(`${config.publicBaseUrl}${FEED_PATH}`) : FEED_PATH,
    )
    .replaceAll('{{CSS_V}}', assetVersion('styles.css'))
    .replaceAll('{{JS_V}}', assetVersion('app.js'));
}

// Rendered once in production. In development every request re-reads the file,
// so editing markup or CSS only takes a reload rather than a restart.
const cachePages = process.env.NODE_ENV === 'production';
const rendered = new Map();
function page(file) {
  if (!cachePages) return renderPage(file);
  if (!rendered.has(file)) rendered.set(file, renderPage(file));
  return rendered.get(file);
}

function sendPage(file) {
  return (req, res) => {
    // The HTML carries the asset URLs, so it must never be held without
    // revalidating - otherwise a deploy still serves yesterday's asset links.
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(page(file));
  };
}

// Registered ahead of express.static, which would otherwise serve the raw files
// including their unsubstituted placeholders.
// The .html paths are listed too: express.static would otherwise hand those
// files out raw, placeholders and all.
app.get(['/', '/index.html'], sendPage('index.html'));
app.get(['/impressum', '/impressum.html'], sendPage('impressum.html'));
app.get(['/datenschutz', '/datenschutz.html'], sendPage('datenschutz.html'));

// Assets are addressed by content hash, so they can be cached hard.
app.use(express.static(publicDir, { extensions: ['html'], maxAge: '7d' }));

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

// Exposed so tests can assert no placeholder ever reaches a visitor.
const landingPage = renderPage('index.html');

export { app, cache, landingPage };
