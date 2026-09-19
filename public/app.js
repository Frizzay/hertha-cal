/* Hertha Kalender — Frontend. Keine Abhängigkeiten, keine externen Requests. */
(function () {
  'use strict';

  var FEED_PATH = '/hertha.ics';
  var MAX_VISIBLE = 12;

  var card = document.getElementById('abonnieren');
  var subscribeBtn = document.getElementById('subscribe-btn');
  var picker = document.getElementById('picker');
  var pickerClose = document.getElementById('picker-close');
  var appleBtn = document.getElementById('apple-btn');
  var googleBtn = document.getElementById('google-btn');
  var outlookBtn = document.getElementById('outlook-btn');
  var copyBtn = document.getElementById('copy-btn');
  var copyNote = document.getElementById('copy-note');
  var copyStatus = document.getElementById('copy-status');
  var list = document.getElementById('match-list');
  var status = document.getElementById('match-status');

  // ---------- Abo-Adressen ----------

  /**
   * Die Abo-Adresse. Der Server trägt PUBLIC_BASE_URL in data-feed ein; das ist
   * die maßgebliche öffentliche Adresse. Fehlt sie – weil die Variable nicht
   * gesetzt ist oder public/ statisch ausgeliefert wird – zählt die Herkunft
   * der Seite.
   */
  function feedUrl() {
    var injected = (card.getAttribute('data-feed') || '').trim();
    if (/^https?:\/\//i.test(injected)) return injected;
    return window.location.origin + FEED_PATH;
  }

  /*
   * Jede App bekommt den Link, den sie versteht:
   *   webcal:      Apple Kalender, Outlook am Rechner, Thunderbird
   *   cid=         Google Kalender im Browser
   *   addfromweb   Outlook.com und Microsoft 365
   * Die Outlook-Adresse ist von Microsoft nicht dokumentiert und kann sich
   * ändern – deshalb bleibt „Andere App“ als verlässlicher Weg bestehen.
   */
  function render() {
    var httpsUrl = feedUrl();
    var webcalUrl = httpsUrl.replace(/^https?:/, 'webcal:');

    appleBtn.href = webcalUrl;

    googleBtn.href =
      'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(webcalUrl);
    googleBtn.hidden = false;

    outlookBtn.href =
      'https://outlook.live.com/calendar/0/addfromweb?url=' +
      encodeURIComponent(webcalUrl) +
      '&name=' + encodeURIComponent('Hertha BSC');

    // Ohne Zwischenablage verspricht der Button nichts, was er nicht halten kann.
    if (!navigator.clipboard || !window.isSecureContext) {
      copyNote.textContent = 'Adresse anzeigen';
    }

    subscribeBtn.hidden = false;
  }

  // ---------- Auswahl-Dialog ----------

  var canUseModal = typeof picker.showModal === 'function';

  function openPicker() {
    copyStatus.textContent = '';
    if (canUseModal) {
      // showModal() bringt Fokusfalle, Escape und inerten Hintergrund mit -
      // nichts davon muss hier nachgebaut werden.
      picker.showModal();
    } else {
      // Älterer Browser ohne <dialog>: die Auswahl erscheint einfach in der
      // Karte statt über ihr. Weniger elegant, aber vollständig bedienbar.
      picker.setAttribute('open', '');
      picker.scrollIntoView({ block: 'nearest' });
    }
  }

  function closePicker() {
    if (canUseModal) picker.close();
    else picker.removeAttribute('open');
    subscribeBtn.focus();
  }

  subscribeBtn.addEventListener('click', openPicker);
  pickerClose.addEventListener('click', closePicker);

  // Klick auf den Hintergrund schließt: Bei einem modalen Dialog trifft der
  // Klick das dialog-Element selbst, nie ein Kind davon.
  picker.addEventListener('click', function (event) {
    if (event.target === picker) closePicker();
  });

  // ---------- Adresse kopieren ----------

  var clearTimer = null;

  function say(message, persist) {
    if (clearTimer) { window.clearTimeout(clearTimer); clearTimer = null; }
    copyStatus.textContent = message;
    if (!persist) {
      clearTimer = window.setTimeout(function () {
        copyStatus.textContent = '';
        clearTimer = null;
      }, 6000);
    }
  }

  /**
   * Letzter Ausweg: Adresse als markierten Text einblenden. Sie bleibt stehen –
   * eine Adresse, die mitten beim Einfügen verschwindet, ist schlimmer als gar
   * keine. Der Fokus bleibt auf dem Button, weil Strg+C auf der Auswahl im
   * Dokument arbeitet und ein Fokuswechsel sie wieder aufheben könnte.
   */
  function revealAddress(message) {
    say(message, true);

    var code = document.createElement('code');
    code.className = 'feed-url';
    code.textContent = feedUrl();
    copyStatus.appendChild(document.createTextNode(' '));
    copyStatus.appendChild(code);

    try {
      var range = document.createRange();
      range.selectNodeContents(code);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (e) {
      // Markieren ist Komfort, nicht Voraussetzung – die Adresse steht ja da.
    }
  }

  copyBtn.addEventListener('click', function () {
    if (!navigator.clipboard || !window.isSecureContext) {
      revealAddress('Adresse markieren und kopieren:');
      return;
    }

    var onFail = function () {
      revealAddress('Kopieren hat nicht geklappt. Adresse markieren und von Hand kopieren:');
    };

    // writeText kann in manchen WebViews synchron werfen, nicht nur ablehnen.
    try {
      navigator.clipboard.writeText(feedUrl()).then(function () {
        say('Adresse kopiert. In deiner Kalender-App unter „Kalender abonnieren“ einfügen.');
      }, onFail);
    } catch (e) {
      onFail();
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
