// Minimal, dependency-free iCalendar (RFC 5545) writer tailored to this feed.

import { ALARM_MINUTES } from './config.js';

const CRLF = '\r\n';
const MATCH_DURATION_MINUTES = 120;
const HOME_VENUE = { name: 'Olympiastadion Berlin', geo: '52.514722;13.239444' };
// Base date for SEQUENCE so the counter stays a small, monotonic integer.
const SEQUENCE_EPOCH = Date.UTC(2020, 0, 1);

/** Escapes a TEXT value. Per RFC 5545 a colon must NOT be escaped. */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Folds a content line to 75 octets. Folding happens on octet boundaries, so
 * the split point is moved back off UTF-8 continuation bytes (10xxxxxx) to
 * avoid cutting a multi-byte character in half — names like "1. FC Nürnberg"
 * or "SpVgg Greuther Fürth" would otherwise corrupt.
 */
export function foldLine(line) {
  const buffer = Buffer.from(line, 'utf8');
  if (buffer.length <= 75) return line;

  const chunks = [];
  let start = 0;
  let limit = 75;
  while (start < buffer.length) {
    const hardEnd = Math.min(start + limit, buffer.length);
    let end = hardEnd;
    if (end < buffer.length) {
      while (end > start && (buffer[end] & 0xc0) === 0x80) end -= 1;
      // Unreachable for valid UTF-8 (a sequence is at most four octets), but
      // backing off to zero progress would spin forever — split instead.
      if (end === start) end = hardEnd;
    }
    chunks.push((start === 0 ? '' : ' ') + buffer.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines spend one octet on the leading space
  }
  return chunks.join(CRLF);
}

/** Formats a Date as a UTC timestamp, e.g. 20260807T183000Z. */
export function formatUtc(date) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * OpenLigaDB reports `lastUpdateDateTime` without a UTC offset. JavaScript would
 * read such a value as server-local time, which would make the rendered output
 * depend on the host's timezone. Pinning it to UTC keeps the feed byte-identical
 * on every machine, so ETags stay comparable.
 */
export function parseApiTimestamp(value) {
  if (!value) return Number.NaN;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  return Date.parse(hasZone ? value : `${value}Z`);
}

let berlinFormatter;
function getBerlinFormatter() {
  // Built lazily: a Node build without full ICU would otherwise throw at import
  // time and take the whole server down over a cosmetic date string.
  if (berlinFormatter === undefined) {
    try {
      berlinFormatter = new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin',
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      berlinFormatter = null;
    }
  }
  return berlinFormatter;
}

/** Human-readable kickoff in local Berlin time, e.g. "Fr., 07.08.2026, 20:30 Uhr". */
export function formatBerlin(isoString) {
  const formatter = getBerlinFormatter();
  if (!formatter) return isoString;
  try {
    return `${formatter.format(new Date(isoString))} Uhr`;
  } catch {
    return isoString;
  }
}

function scoreSuffix(kind) {
  if (kind === 'AfterPenalties') return ' n.E.';
  if (kind === 'AfterExtraTime') return ' n.V.';
  return '';
}

/**
 * Event title: competition emoji and the pairing, nothing else. The result
 * stays out of it deliberately and lives in the description, so a glance at the
 * calendar never spoils a match that has not been watched yet.
 */
function matchTitle(match) {
  const prefix = match.emoji ? `${match.emoji} ` : '';
  return `${prefix}${match.homeTeam} – ${match.awayTeam}`;
}

function matchVenue(match) {
  if (match.stadium) return [match.stadium, match.city].filter(Boolean).join(', ');
  return match.isHome ? HOME_VENUE.name : null;
}

function matchDescription(match, { siteUrl }) {
  const lines = [
    `${match.competitionLabel}${match.round ? ` · ${match.round}` : ''}`,
    `${match.isHome ? 'Heimspiel' : 'Auswärtsspiel'} gegen ${match.opponent}`,
    `Anstoß: ${formatBerlin(match.kickoffUtc)}`,
  ];
  if (match.finished && match.score) {
    lines.push(`Endstand: ${match.score.home}:${match.score.away}${scoreSuffix(match.score.kind)}`);
  } else {
    lines.push('Anstoßzeiten späterer Spieltage sind vorläufig und werden automatisch aktualisiert.');
  }
  lines.push('', 'Daten: OpenLigaDB', siteUrl);
  return lines.join('\n');
}

function sequenceFor(match) {
  const updated = parseApiTimestamp(match.lastUpdate);
  if (!Number.isFinite(updated)) return 0;
  return Math.max(0, Math.floor((updated - SEQUENCE_EPOCH) / 3_600_000)); // hours
}

function buildEvent(match, options) {
  const { uidDomain, siteUrl } = options;
  const start = new Date(match.kickoffUtc);
  const end = new Date(start.getTime() + MATCH_DURATION_MINUTES * 60_000);
  // Derived from the data, never from the wall clock, so identical data always
  // produces byte-identical output and ETag/304 handling stays meaningful.
  const stamp = new Date(parseApiTimestamp(match.lastUpdate) || start.getTime());
  const venue = matchVenue(match);

  const lines = [
    'BEGIN:VEVENT',
    `UID:match-${match.id}@${uidDomain}`,
    `DTSTAMP:${formatUtc(stamp)}`,
    `DTSTART:${formatUtc(start)}`,
    `DTEND:${formatUtc(end)}`,
    `SEQUENCE:${sequenceFor(match)}`,
    `SUMMARY:${escapeText(matchTitle(match))}`,
    `DESCRIPTION:${escapeText(matchDescription(match, { siteUrl }))}`,
    `CATEGORIES:${escapeText('Fußball')},${escapeText('Hertha BSC')},${escapeText(match.competitionLabel)}`,
    'STATUS:CONFIRMED',
    // A subscribed sports feed should not make the subscriber look busy.
    'TRANSP:TRANSPARENT',
    `URL:${siteUrl}`,
  ];
  if (venue) lines.push(`LOCATION:${escapeText(venue)}`);
  if (!match.stadium && match.isHome) lines.push(`GEO:${HOME_VENUE.geo}`);

  for (const minutes of ALARM_MINUTES) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `TRIGGER:-PT${minutes}M`,
      `DESCRIPTION:${escapeText(`${matchTitle(match)} — Anstoß in ${minutes} Minuten`)}`,
      'END:VALARM',
    );
  }

  lines.push('END:VEVENT');
  return lines;
}

/**
 * Renders the full VCALENDAR document.
 * @param {object[]} matches normalised matches, sorted by kickoff
 * @param {object} options  { calendarName, uidDomain, siteUrl }
 */
export function buildCalendar(matches, options) {
  const { calendarName } = options;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//hertha-cal//Hertha BSC Spielplan//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `NAME:${escapeText(calendarName)}`,
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `DESCRIPTION:${escapeText('Alle Pflichtspiele von Hertha BSC. Daten: OpenLigaDB.')}`,
    `X-WR-CALDESC:${escapeText('Alle Pflichtspiele von Hertha BSC. Daten: OpenLigaDB.')}`,
    'X-WR-TIMEZONE:Europe/Berlin',
    'COLOR:navy',
    // Tells well-behaved clients how often to poll for updates.
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ];

  for (const match of matches) lines.push(...buildEvent(match, options));
  lines.push('END:VCALENDAR');

  return lines.map(foldLine).join(CRLF) + CRLF;
}
