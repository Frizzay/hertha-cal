import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { currentSeason, seasonsToFetch } from '../src/config.js';
import { MatchCache } from '../src/cache.js';
import { parseFeedOptions, selectMatches } from '../src/server.js';

const match = (id, competition, kickoffUtc) => ({ id, competition, kickoffUtc });

const FIXTURES = [
  match(1, 'liga', '2026-08-07T18:30:00Z'),
  match(2, 'pokal', '2026-08-22T13:30:00Z'),
  match(3, 'liga', '2026-12-05T13:30:00Z'),
];

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

describe('parseFeedOptions', () => {
  test('defaults to everything, no alarm, history included', () => {
    assert.deepEqual(parseFeedOptions({}), {
      competition: 'all',
      alarmMinutes: 0,
      includePast: true,
    });
  });

  test('accepts the known competitions', () => {
    assert.equal(parseFeedOptions({ competition: 'liga' }).competition, 'liga');
    assert.equal(parseFeedOptions({ competition: 'POKAL' }).competition, 'pokal');
  });

  test('falls back to all for an unknown competition', () => {
    assert.equal(parseFeedOptions({ competition: 'champions-league' }).competition, 'all');
  });

  test('clamps the alarm into a sane range', () => {
    assert.equal(parseFeedOptions({ alarm: '60' }).alarmMinutes, 60);
    assert.equal(parseFeedOptions({ alarm: '-30' }).alarmMinutes, 0);
    assert.equal(parseFeedOptions({ alarm: '99999' }).alarmMinutes, 1440);
    assert.equal(parseFeedOptions({ alarm: 'bald' }).alarmMinutes, 0);
  });

  test('understands the ways of saying no to past matches', () => {
    for (const value of ['0', 'false', 'no']) {
      assert.equal(parseFeedOptions({ past: value }).includePast, false, value);
    }
    assert.equal(parseFeedOptions({ past: '1' }).includePast, true);
  });

  test('ignores array-shaped query values instead of crashing', () => {
    // Express turns ?competition=a&competition=b into an array.
    assert.equal(parseFeedOptions({ competition: ['liga', 'pokal'] }).competition, 'all');
  });
});

describe('selectMatches', () => {
  const now = new Date('2026-09-19T12:00:00Z');

  test('returns everything by default', () => {
    const result = selectMatches(FIXTURES, parseFeedOptions({}), now);
    assert.equal(result.length, 3);
  });

  test('filters by competition', () => {
    const liga = selectMatches(FIXTURES, parseFeedOptions({ competition: 'liga' }), now);
    assert.deepEqual(liga.map((m) => m.id), [1, 3]);

    const pokal = selectMatches(FIXTURES, parseFeedOptions({ competition: 'pokal' }), now);
    assert.deepEqual(pokal.map((m) => m.id), [2]);
  });

  test('drops played matches when asked to', () => {
    const upcoming = selectMatches(FIXTURES, parseFeedOptions({ past: '0' }), now);
    assert.deepEqual(upcoming.map((m) => m.id), [3]);
  });

  test('combines both filters', () => {
    const options = parseFeedOptions({ competition: 'pokal', past: '0' });
    assert.deepEqual(selectMatches(FIXTURES, options, now), []);
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
