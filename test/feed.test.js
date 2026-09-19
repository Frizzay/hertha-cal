import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { ALARM_MINUTES, COMPETITIONS, currentSeason, seasonsToFetch } from '../src/config.js';
import { MatchCache } from '../src/cache.js';
// Importing the server must not start a listener. If the entrypoint guard in
// server.js ever regresses, this test file stops exiting and the run hangs.
import { app, landingPage } from '../src/server.js';

describe('server module', () => {
  test('exposes an express app without listening', () => {
    assert.equal(typeof app, 'function');
    assert.equal(typeof app.listen, 'function');
  });
});

describe('landing page', () => {
  test('never serves an unsubstituted placeholder', () => {
    assert.ok(!landingPage.includes('{{'), 'no template placeholder survives');
  });

  test('carries a usable subscription address', () => {
    // PUBLIC_BASE_URL is unset in the test environment, so the relative path
    // stays put and the browser resolves it against its own origin.
    assert.match(landingPage, /id="abonnieren"[^>]*data-feed="[^"]+"/);
  });

  test('ships the JavaScript-only controls hidden', () => {
    // They cannot work before app.js runs, so they must not be visible then.
    for (const id of ['google-btn', 'outlook-btn', 'copy-btn']) {
      assert.match(landingPage, new RegExp(`id="${id}"[^>]*hidden`), id);
    }
  });

  test('gives the primary control a real href rather than a dead anchor', () => {
    assert.match(landingPage, /id="apple-btn" href="[^"#]+"/);
  });
});

describe('competitions', () => {
  test('covers league and cup', () => {
    assert.deepEqual(Object.keys(COMPETITIONS).sort(), ['liga', 'pokal']);
  });

  test('assigns each competition its own emoji', () => {
    assert.equal(COMPETITIONS.liga.emoji, '⚽');
    assert.equal(COMPETITIONS.pokal.emoji, '🏆');
  });

  test('reads the expected OpenLigaDB leagues', () => {
    assert.equal(COMPETITIONS.liga.shortcut, 'bl2');
    assert.equal(COMPETITIONS.pokal.shortcut, 'dfb');
  });
});

describe('alarms', () => {
  test('are two reminders, 30 and 5 minutes before kickoff', () => {
    assert.deepEqual(ALARM_MINUTES, [30, 5]);
  });
});

describe('season detection', () => {
  test('treats July onwards as the new season', () => {
    assert.equal(currentSeason(new Date('2026-07-01T00:00:00Z')), 2026);
    assert.equal(currentSeason(new Date('2026-09-19T00:00:00Z')), 2026);
  });

  test('keeps spring on the season that started the previous summer', () => {
    assert.equal(currentSeason(new Date('2027-03-15T00:00:00Z')), 2026);
    assert.equal(currentSeason(new Date('2027-06-30T00:00:00Z')), 2026);
  });

  test('probes the upcoming season once fixture lists start appearing', () => {
    assert.deepEqual(seasonsToFetch(new Date('2027-05-20T00:00:00Z')), [2026, 2027]);
    assert.deepEqual(seasonsToFetch(new Date('2027-06-10T00:00:00Z')), [2026, 2027]);
  });

  test('sticks to a single season during the running year', () => {
    assert.deepEqual(seasonsToFetch(new Date('2026-09-19T00:00:00Z')), [2026]);
    assert.deepEqual(seasonsToFetch(new Date('2027-02-01T00:00:00Z')), [2026]);
  });
});

describe('MatchCache', () => {
  test('hits the loader once per TTL', async () => {
    let calls = 0;
    const cache = new MatchCache(async () => ({ matches: [], calls: ++calls }), 60_000);

    await cache.get();
    await cache.get();
    assert.equal(calls, 1);
  });

  test('collapses concurrent misses into a single request', async () => {
    let calls = 0;
    const cache = new MatchCache(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { matches: [] };
    }, 60_000);

    await Promise.all([cache.get(), cache.get(), cache.get()]);
    assert.equal(calls, 1);
  });

  test('keeps serving the last good snapshot when upstream fails', async () => {
    let shouldFail = false;
    const cache = new MatchCache(async () => {
      if (shouldFail) throw new Error('OpenLigaDB down');
      return { matches: [{ id: 1 }] };
    }, 0); // TTL 0 forces a refresh on every call

    const fresh = await cache.get();
    assert.equal(fresh.stale, false);

    shouldFail = true;
    const stale = await cache.get();
    assert.equal(stale.matches.length, 1, 'previous fixtures survive an outage');
    assert.equal(stale.stale, true);
  });

  test('propagates the failure when there is nothing cached yet', async () => {
    const cache = new MatchCache(async () => {
      throw new Error('OpenLigaDB down');
    }, 60_000);

    await assert.rejects(() => cache.get(), /OpenLigaDB down/);
  });

  test('warm() swallows errors so start-up never crashes', async () => {
    const cache = new MatchCache(async () => {
      throw new Error('OpenLigaDB down');
    }, 60_000);

    await cache.warm();
    assert.equal(cache.snapshot, null);
  });
});
