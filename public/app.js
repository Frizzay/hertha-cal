/* Hertha Kalender — Frontend. Keine Abhängigkeiten, keine externen Requests. */
(function () {
  'use strict';

  var FEED_PATH = '/hertha.ics';
  var MAX_VISIBLE = 12;

  var urlField = document.getElementById('feed-url');
  var copyBtn = document.getElementById('copy-btn');
  var copyStatus = document.getElementById('copy-status');
  var subscribeBtn = document.getElementById('subscribe-btn');
  var googleBtn = document.getElementById('google-btn');
  var list = document.getElementById('match-list');
  var status = document.getElementById('match-status');

  // ---------- Abo-Adressen ----------

  function render() {
    var httpsUrl = window.location.origin + FEED_PATH;
    urlField.value = httpsUrl;
    subscribeBtn.href = httpsUrl.replace(/^https?:/, 'webcal:');
    googleBtn.href = 'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(httpsUrl);
  }

  // ---------- Kopieren ----------

  function flash(message) {
    copyStatus.textContent = message;
    window.setTimeout(function () {
      copyStatus.textContent = '';
    }, 4000);
  }

  copyBtn.addEventListener('click', function () {
    var done = function () {
      flash('Adresse kopiert. Jetzt in deiner Kalender-App als Abo einfügen.');
    };
    var failed = function () {
      urlField.select();
      flash('Kopieren nicht möglich – bitte die markierte Adresse manuell kopieren.');
    };

    // navigator.clipboard braucht einen sicheren Kontext (https oder localhost).
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(urlField.value).then(done, failed);
    } else {
      failed();
    }
  });

  // ---------- Spielliste ----------

  var dateFormat = new Intl.DateTimeFormat('de-DE', {
    weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Picks the window of matches worth showing: a little history, then upcoming. */
  function visibleSlice(matches) {
    var now = Date.now();
    var nextIndex = matches.findIndex(function (match) {
      return Date.parse(match.kickoffUtc) >= now;
    });
    if (nextIndex === -1) return matches.slice(-MAX_VISIBLE);
    var start = Math.max(0, nextIndex - 2);
    return matches.slice(start, start + MAX_VISIBLE);
  }

  function teamsNode(match) {
    var node = el('div', 'match-teams');
    if (match.emoji) {
      var icon = el('span', 'match-emoji', match.emoji);
      icon.setAttribute('aria-hidden', 'true');
      node.appendChild(icon);
      node.appendChild(document.createTextNode(' '));
    }
    node.appendChild(el('span', match.isHome ? 'me' : null, match.homeTeam));
    node.appendChild(document.createTextNode(' – '));
    node.appendChild(el('span', match.isHome ? null : 'me', match.awayTeam));
    if (match.competitionLabel) {
      // Trägt die Information, die das Emoji nur visuell vermittelt.
      node.appendChild(el('span', 'visually-hidden', ' (' + match.competitionLabel + ')'));
    }
    return node;
  }

  function metaNode(match) {
    if (match.finished && match.score) {
      return el('div', 'match-meta match-score', match.score.home + ':' + match.score.away);
    }
    return el('div', 'match-meta', match.isHome ? 'Heim' : 'Auswärts');
  }

  function matchNode(match) {
    var item = el('li', 'match');
    item.appendChild(el('div', 'match-date', dateFormat.format(new Date(match.kickoffUtc)) + ' Uhr'));
    item.appendChild(teamsNode(match));
    item.appendChild(metaNode(match));
    return item;
  }

  function loadMatches() {
    list.setAttribute('aria-busy', 'true');

    fetch('/api/matches', { headers: { accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        list.textContent = '';

        var matches = Array.isArray(data.matches) ? data.matches : [];
        if (!matches.length) {
          status.textContent = 'Derzeit liegen keine Spiele vor.';
          return;
        }

        visibleSlice(matches).forEach(function (match) {
          list.appendChild(matchNode(match));
        });

        var note = 'Spielplan mit ' + matches.length + ' Partien';
        if (data.updatedAt) {
          note += ', zuletzt abgerufen am ' + dateFormat.format(new Date(data.updatedAt)) + ' Uhr';
        }
        status.textContent = note + (data.stale ? ' (Datenquelle gerade nicht erreichbar).' : '.');
      })
      .catch(function () {
        list.textContent = '';
        status.textContent =
          'Die Spiele konnten nicht geladen werden. Das Kalender-Abo funktioniert davon unabhängig weiter.';
      })
      .finally(function () {
        list.setAttribute('aria-busy', 'false');
      });
  }

  render();
  loadMatches();
})();
