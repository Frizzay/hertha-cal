/* Hertha Kalender — Frontend. Keine Abhängigkeiten, keine externen Requests. */
(function () {
  'use strict';

  var form = document.getElementById('options');
  var urlField = document.getElementById('feed-url');
  var copyBtn = document.getElementById('copy-btn');
  var copyStatus = document.getElementById('copy-status');
  var subscribeBtn = document.getElementById('subscribe-btn');
  var googleBtn = document.getElementById('google-btn');
  var downloadBtn = document.getElementById('download-btn');
  var list = document.getElementById('match-list');
  var status = document.getElementById('match-status');

  var MAX_VISIBLE = 12;

  function currentOptions() {
    var data = new FormData(form);
    return {
      competition: data.get('competition') || 'all',
      alarm: data.get('alarm') || '0',
      past: data.get('past') || '1',
    };
  }

  /** Only non-default options end up in the URL, so the common case stays short. */
  function feedPath(options) {
    var params = new URLSearchParams();
    if (options.competition !== 'all') params.set('competition', options.competition);
    if (options.alarm !== '0') params.set('alarm', options.alarm);
    if (options.past !== '1') params.set('past', options.past);
    var query = params.toString();
    return '/hertha.ics' + (query ? '?' + query : '');
  }

  function render() {
    var options = currentOptions();
    var path = feedPath(options);
    var httpsUrl = window.location.origin + path;

    urlField.value = httpsUrl;
    subscribeBtn.href = httpsUrl.replace(/^https?:/, 'webcal:');
    googleBtn.href =
      'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(httpsUrl);
    downloadBtn.href = path;

    return options;
  }

  // ---------- Kopieren ----------

  function flash(message) {
    copyStatus.textContent = message;
    window.setTimeout(function () {
      copyStatus.textContent = '';
    }, 4000);
  }

  copyBtn.addEventListener('click', function () {
    var value = urlField.value;
    var done = function () {
      flash('Adresse kopiert. Jetzt in deiner Kalender-App als Abo einfügen.');
    };
    var failed = function () {
      urlField.select();
      flash('Kopieren nicht möglich – bitte die markierte Adresse manuell kopieren.');
    };

    // navigator.clipboard braucht einen sicheren Kontext (https oder localhost).
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(done, failed);
    } else {
      failed();
    }
  });

  form.addEventListener('change', function () {
    render();
    loadMatches();
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
    var home = el('span', match.isHome ? 'me' : null, match.homeTeam);
    var away = el('span', match.isHome ? null : 'me', match.awayTeam);
    node.appendChild(home);
    node.appendChild(document.createTextNode(' – '));
    node.appendChild(away);
    if (match.competition === 'pokal') node.appendChild(el('span', 'badge', 'Pokal'));
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
    var when = new Date(match.kickoffUtc);
    var date = el('div', 'match-date', dateFormat.format(when) + ' Uhr');
    date.appendChild(document.createElement('br'));
    item.appendChild(date);
    item.appendChild(teamsNode(match));
    item.appendChild(metaNode(match));
    return item;
  }

  var pending = 0;

  function loadMatches() {
    var options = currentOptions();
    var params = new URLSearchParams({ competition: options.competition, past: options.past });
    var token = ++pending;

    list.setAttribute('aria-busy', 'true');

    fetch('/api/matches?' + params.toString(), { headers: { accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        if (token !== pending) return; // eine neuere Anfrage ist bereits unterwegs
        list.textContent = '';

        var matches = Array.isArray(data.matches) ? data.matches : [];
        if (!matches.length) {
          status.textContent = 'Für diese Auswahl liegen derzeit keine Spiele vor.';
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
        if (token !== pending) return;
        list.textContent = '';
        status.textContent =
          'Die Spiele konnten nicht geladen werden. Das Kalender-Abo funktioniert davon unabhängig weiter.';
      })
      .finally(function () {
        if (token === pending) list.setAttribute('aria-busy', 'false');
      });
  }

  render();
  loadMatches();
})();
