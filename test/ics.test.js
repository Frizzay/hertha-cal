import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { buildCalendar, escapeText, foldLine, formatUtc, parseApiTimestamp } from '../src/ics.js';

const options = {
  calendarName: 'Hertha BSC – Spielplan',
  uidDomain: 'hertha-kalender.example.de',
  siteUrl: 'https://hertha-kalender.example.de',
};

function makeMatch(overrides = {}) {
  return {
    id: 83509,
    competition: 'liga',
    competitionLabel: '2. Bundesliga',
    emoji: '⚽',
    season: 2026,
    round: '1. Spieltag',
    kickoffUtc: '2026-08-07T18:30:00Z',
    isHome: false,
    homeTeam: 'VfL Bochum',
    awayTeam: 'Hertha BSC',
    opponent: 'VfL Bochum',
    opponentShort: 'Bochum',
    finished: false,
    score: null,
    stadium: null,
    city: null,
    lastUpdate: '2026-08-07T22:26:29.493',
    ...overrides,
  };
}

/** Unfolds a rendered calendar back into logical lines for assertions. */
function logicalLines(ics) {
  return ics.replace(/\r\n[ \t]/g, '').split('\r\n');
}

describe('escapeText', () => {
  test('escapes the characters RFC 5545 requires', () => {
    assert.equal(escapeText('a;b,c\\d'), 'a\\;b\\,c\\\\d');
  });

  test('turns line breaks into literal \\n', () => {
    assert.equal(escapeText('one\r\ntwo\nthree'), 'one\\ntwo\\nthree');
  });

  test('leaves the colon untouched', () => {
    assert.equal(escapeText('Endstand 2:1'), 'Endstand 2:1');
  });

  test('escapes the backslash before anything else', () => {
    assert.equal(escapeText('\\;'), '\\\\\\;');
  });
});

describe('foldLine', () => {
  test('leaves short lines alone', () => {
    assert.equal(foldLine('SUMMARY:kurz'), 'SUMMARY:kurz');
  });

  test('folds at 75 octets with a leading space on continuations', () => {
    const folded = foldLine('X'.repeat(200));
    const parts = folded.split('\r\n');
    assert.ok(parts.length > 1);
    assert.equal(Buffer.byteLength(parts[0]), 75);
    for (const part of parts.slice(1)) {
      assert.equal(part[0], ' ');
      assert.ok(Buffer.byteLength(part) <= 75);
    }
  });

  test('never splits a multi-byte character', () => {
    // "ü" is two octets; padding puts one straddling the 75-octet boundary.
    const line = `${'a'.repeat(74)}üöä ${'b'.repeat(40)}`;
    const folded = foldLine(line);
    assert.equal(folded.split('\r\n').map((p, i) => (i ? p.slice(1) : p)).join(''), line);
    assert.ok(!folded.includes('�'), 'no replacement characters');
  });

  test('never splits a four-octet emoji across a fold', () => {
    // 🏆 is four octets; the padding lands it exactly on the 75-octet boundary.
    const line = `${'a'.repeat(73)}🏆${'b'.repeat(40)}`;
    const folded = foldLine(line);
    assert.equal(folded.replace(/\r\n /g, ''), line);
    assert.ok(!folded.includes('�'), 'no replacement characters');
  });

  test('round-trips German club names', () => {
    const line = `SUMMARY:1. FC Nürnberg – SpVgg Greuther Fürth im Fußball-Wettbewerb ${'x'.repeat(40)}`;
    const unfolded = foldLine(line).replace(/\r\n /g, '');
    assert.equal(unfolded, line);
  });
});

describe('parseApiTimestamp', () => {
  test('reads an offset-less API timestamp as UTC, not as server-local time', () => {
    assert.equal(
      parseApiTimestamp('2026-08-07T22:26:29.493'),
      Date.parse('2026-08-07T22:26:29.493Z'),
    );
  });

  test('respects an offset when the value carries one', () => {
    assert.equal(parseApiTimestamp('2026-08-07T18:30:00Z'), Date.parse('2026-08-07T18:30:00Z'));
    assert.equal(
      parseApiTimestamp('2026-08-07T20:30:00+02:00'),
      Date.parse('2026-08-07T18:30:00Z'),
    );
  });

  test('reports missing or unusable values as NaN', () => {
    assert.ok(Number.isNaN(parseApiTimestamp(null)));
    assert.ok(Number.isNaN(parseApiTimestamp('')));
    assert.ok(Number.isNaN(parseApiTimestamp('irgendwann')));
  });
});

describe('formatUtc', () => {
  test('renders the compact UTC form', () => {
    assert.equal(formatUtc(new Date('2026-08-07T18:30:00Z')), '20260807T183000Z');
  });

  test('zero-pads single digit components', () => {
    assert.equal(formatUtc(new Date('2027-01-02T03:04:05Z')), '20270102T030405Z');
  });
});

describe('buildCalendar', () => {
  test('emits a well-formed, CRLF-terminated VCALENDAR', () => {
    const ics = buildCalendar([makeMatch()], options);
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.ok(!/(?<!\r)\n/.test(ics), 'every line break is a CRLF');
  });

  test('pairs every BEGIN with an END', () => {
    const ics = buildCalendar([makeMatch(), makeMatch({ id: 2 })], options);
    const lines = logicalLines(ics);
    assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 2);
    assert.equal(lines.filter((l) => l === 'END:VEVENT').length, 2);
  });

  test('gives each match a stable, unique UID', () => {
    const ics = buildCalendar([makeMatch({ id: 1 }), makeMatch({ id: 2 })], options);
    const uids = logicalLines(ics).filter((l) => l.startsWith('UID:'));
    assert.deepEqual(uids, [
      'UID:match-1@hertha-kalender.example.de',
      'UID:match-2@hertha-kalender.example.de',
    ]);
  });

  test('is deterministic so ETags stay stable across requests', () => {
    const first = buildCalendar([makeMatch()], options);
    const second = buildCalendar([makeMatch()], options);
    assert.equal(first, second);
  });

  test('schedules a two hour slot from kickoff', () => {
    const lines = logicalLines(buildCalendar([makeMatch()], options));
    assert.ok(lines.includes('DTSTART:20260807T183000Z'));
    assert.ok(lines.includes('DTEND:20260807T203000Z'));
  });

  test('keeps subscribers free rather than busy', () => {
    assert.ok(logicalLines(buildCalendar([makeMatch()], options)).includes('TRANSP:TRANSPARENT'));
  });

  test('prefixes league matches with the football emoji', () => {
    const summary = logicalLines(buildCalendar([makeMatch()], options)).find((l) =>
      l.startsWith('SUMMARY:'),
    );
    assert.equal(summary, 'SUMMARY:⚽ VfL Bochum – Hertha BSC');
  });

  test('prefixes cup matches with the trophy emoji', () => {
    const cup = makeMatch({ competition: 'pokal', competitionLabel: 'DFB-Pokal', emoji: '🏆' });
    const summary = logicalLines(buildCalendar([cup], options)).find((l) => l.startsWith('SUMMARY:'));
    assert.equal(summary, 'SUMMARY:🏆 VfL Bochum – Hertha BSC');
  });

  test('omits the prefix when a match carries no emoji', () => {
    const summary = logicalLines(buildCalendar([makeMatch({ emoji: undefined })], options)).find(
      (l) => l.startsWith('SUMMARY:'),
    );
    assert.equal(summary, 'SUMMARY:VfL Bochum – Hertha BSC');
  });

  test('keeps the result out of the title of a finished match', () => {
    const match = makeMatch({ finished: true, score: { home: 0, away: 1, kind: 'After90Minutes' } });
    const summary = logicalLines(buildCalendar([match], options)).find((l) => l.startsWith('SUMMARY:'));
    assert.equal(summary, 'SUMMARY:⚽ VfL Bochum – Hertha BSC');
  });

  test('titles a finished match exactly like an upcoming one', () => {
    const title = (match) =>
      logicalLines(buildCalendar([match], options)).find((l) => l.startsWith('SUMMARY:'));
    const played = makeMatch({ finished: true, score: { home: 4, away: 0, kind: 'After90Minutes' } });
    assert.equal(title(played), title(makeMatch()));
  });

  test('reports the result in the description instead', () => {
    const match = makeMatch({ finished: true, score: { home: 0, away: 1, kind: 'After90Minutes' } });
    const description = logicalLines(buildCalendar([match], options)).find((l) =>
      l.startsWith('DESCRIPTION:'),
    );
    assert.ok(description.includes('Endstand: 0:1'), description);
  });

  test('marks results decided after extra time or penalties', () => {
    const shootout = makeMatch({ finished: true, score: { home: 3, away: 4, kind: 'AfterPenalties' } });
    const description = logicalLines(buildCalendar([shootout], options)).find((l) =>
      l.startsWith('DESCRIPTION:'),
    );
    assert.ok(description.includes('Endstand: 3:4 n.E.'), description);
  });

  test('does not leak the score into the reminder text', () => {
    const match = makeMatch({ finished: true, score: { home: 2, away: 1, kind: 'After90Minutes' } });
    const alarmLines = logicalLines(buildCalendar([match], options)).filter(
      (l) => l.startsWith('DESCRIPTION:') && l.includes('Anstoß in'),
    );
    assert.equal(alarmLines.length, 2);
    for (const line of alarmLines) assert.ok(!line.includes('2:1'), line);
  });

  test('gives every event a reminder 30 and 5 minutes before kickoff', () => {
    const lines = logicalLines(buildCalendar([makeMatch()], options));
    assert.equal(lines.filter((l) => l === 'BEGIN:VALARM').length, 2);
    assert.equal(lines.filter((l) => l === 'END:VALARM').length, 2);
    assert.ok(lines.includes('TRIGGER:-PT30M'));
    assert.ok(lines.includes('TRIGGER:-PT5M'));
  });

  test('reminds about played matches too, so the rule has no exceptions', () => {
    const played = makeMatch({ finished: true, score: { home: 1, away: 1, kind: 'After90Minutes' } });
    const lines = logicalLines(buildCalendar([played], options));
    assert.equal(lines.filter((l) => l === 'BEGIN:VALARM').length, 2);
  });

  test('nests both alarms inside the event', () => {
    const lines = logicalLines(buildCalendar([makeMatch()], options));
    assert.ok(lines.lastIndexOf('END:VALARM') < lines.indexOf('END:VEVENT'));
  });

  test('falls back to the Olympiastadion for home matches without venue data', () => {
    const lines = logicalLines(buildCalendar([makeMatch({ isHome: true })], options));
    assert.ok(lines.includes('LOCATION:Olympiastadion Berlin'));
    assert.ok(lines.some((l) => l.startsWith('GEO:')));
  });

  test('never invents a venue for away matches', () => {
    const lines = logicalLines(buildCalendar([makeMatch({ isHome: false })], options));
    assert.ok(!lines.some((l) => l.startsWith('LOCATION:')));
    assert.ok(!lines.some((l) => l.startsWith('GEO:')));
  });

  test('prefers the venue reported by the API', () => {
    const match = makeMatch({ isHome: true, stadium: 'Olympiastadion', city: 'Berlin' });
    const lines = logicalLines(buildCalendar([match], options));
    assert.ok(lines.includes('LOCATION:Olympiastadion\\, Berlin'));
  });

  test('handles an empty fixture list without producing junk', () => {
    const ics = buildCalendar([], options);
    assert.ok(!ics.includes('BEGIN:VEVENT'));
    assert.ok(ics.includes('END:VCALENDAR'));
  });

  test('folds long lines so no physical line exceeds 75 octets', () => {
    const match = makeMatch({
      homeTeam: 'SpVgg Greuther Fürth',
      awayTeam: '1. FC Kaiserslautern Betzenberg Traditionsverein',
    });
    for (const line of buildCalendar([match], options).split('\r\n')) {
      assert.ok(Buffer.byteLength(line) <= 75, `too long: ${line}`);
    }
  });
});
