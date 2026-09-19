# hertha-cal

Ein Kalender-Abo (iCalendar/ICS) mit allen Pflichtspielen von Hertha BSC –
2. Bundesliga und DFB-Pokal – plus einer schlanken Landingpage zum Abonnieren.

Privates Fan-Projekt, nicht mit Hertha BSC, der DFL oder dem DFB verbunden.

## Überblick

| | |
|---|---|
| Landingpage | `GET /` |
| Kalender-Feed | `GET /hertha.ics` (Aliase: `/calendar.ics`, `/hertha-bsc.ics`) |
| Spiele als JSON | `GET /api/matches` |
| Rechtstexte | `GET /impressum`, `GET /datenschutz` |
| Healthcheck | `GET /healthz` |

Datenquelle ist [OpenLigaDB](https://www.openligadb.de/) – frei, ohne API-Key.
Hertha BSC hat dort die `teamId` 54; gelesen werden die Ligen `bl2` und `dfb`.

### Was im Feed steckt

Es gibt genau einen Feed ohne Parameter und ohne Einstellungen:

- alle Pflichtspiele der Saison, gespielte Partien inklusive
- Titel mit vorangestelltem Emoji: ⚽ für die 2. Bundesliga, 🏆 für den DFB-Pokal
- zwei Erinnerungen je Termin – 30 und 5 Minuten vor Anpfiff
- Endstand im Titel, sobald abgepfiffen ist (`n.V.` bzw. `n.E.` bei Verlängerung
  oder Elfmeterschießen)

Die Erinnerungen stecken als `VALARM` im Termin. Wer sie nicht möchte, schaltet
die Benachrichtigungen für diesen Kalender in seiner App ab – das lässt sich in
den meisten Kalender-Apps pro Kalender einstellen.

## Lokal starten

Voraussetzung: Node.js ≥ 22 (gebaut und getestet wird mit Node 24).

```bash
npm install
cp .env.example .env     # PUBLIC_BASE_URL anpassen
npm start                # http://localhost:3000
npm test                 # Unit-Tests (ohne Netzwerkzugriff)
```

## Mit Docker betreiben

```bash
PUBLIC_BASE_URL=https://hertha-kalender.example.de docker compose up -d --build
```

Das Image läuft unpriviligiert als `node`, mit `read_only`-Dateisystem und
`no-new-privileges`. Es gibt keinen Zustand auf der Platte – ein Neustart kostet
nur den ersten Abruf bei OpenLigaDB.

## Fertiges Image aus der GitHub Container Registry

Der Workflow `.github/workflows/docker.yml` läuft bei jedem Push auf `main` und
bei jedem `v*`-Tag: er führt erst die Tests aus und baut und veröffentlicht
danach das Image für `linux/amd64` und `linux/arm64` nach
`ghcr.io/<owner>/hertha-cal`.

| Auslöser | Tags |
|---|---|
| Push auf `main` | `latest`, `main`, `sha-abc1234` |
| Tag `v1.2.3` | `1.2.3`, `1.2`, `sha-abc1234` |
| Pull Request | wird nur gebaut, nicht gepusht |

Der Workflow braucht keine Secrets – das automatisch bereitgestellte
`GITHUB_TOKEN` genügt.

### Sicherheitsprüfung

Zwischen Bauen und Pushen scannt [Trivy](https://trivy.dev/) das fertige Image.
**Findet er eine Schwachstelle der Stufe `HIGH` oder `CRITICAL`, schlägt der Job
fehl und es wird nichts veröffentlicht.** Geprüft werden Betriebssystempakete
des Base-Image und die npm-Abhängigkeiten.

Der vollständige Bericht steht anschließend in der Zusammenfassung des Runs.

Zwei Stellschrauben in `.github/workflows/docker.yml`:

| Eingabe | Standard | Wirkung |
|---|---|---|
| `severity` | `HIGH,CRITICAL` | ab welcher Stufe der Build scheitert |
| `ignore-unfixed` | `'false'` | auch Lücken ohne verfügbaren Fix blockieren |

`ignore-unfixed: 'false'` heißt: Der Build kann auch an etwas scheitern, für das
es noch gar keinen Patch gibt – dann hilft nur warten oder das Base-Image
wechseln. Wer nur auf behebbare Funde reagieren möchte, setzt den Wert auf
`'true'`.

Gescannt wird nur `linux/amd64`. Die OS-Pakete und npm-Abhängigkeiten sind auf
beiden Architekturen dieselben, und ein Multi-Arch-Image lässt sich nicht in den
lokalen Docker-Daemon laden.

### Auf dem Server deployen

```bash
export IMAGE_OWNER=dein-github-name          # kleingeschrieben
export PUBLIC_BASE_URL=https://hertha-kalender.example.de

docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Für ein Update dieselben zwei Befehle erneut ausführen.

> **GHCR-Pakete sind anfangs privat.** Entweder das Paket einmalig auf öffentlich
> stellen (GitHub → Packages → hertha-cal → Package settings → Change visibility),
> oder sich auf dem Server anmelden:
>
> ```bash
> echo "$GHCR_TOKEN" | docker login ghcr.io -u dein-github-name --password-stdin
> ```
>
> `GHCR_TOKEN` ist ein Personal Access Token (classic) mit `read:packages`.

Der Image-Pfad muss komplett kleingeschrieben sein – GHCR lehnt Großbuchstaben
ab. Der Workflow erledigt das selbst, beim manuellen `docker pull` ist es zu
beachten.

### Hinter einem Reverse Proxy

TLS gehört vor den Container. Wichtig sind zwei Dinge:

1. `PUBLIC_BASE_URL` auf die öffentliche `https://`-Adresse setzen. Daraus baut
   die Seite die `webcal://`-Links und der Feed seine UIDs.
2. `TRUST_PROXY=1` setzen, damit `X-Forwarded-Proto` ausgewertet wird.

Beispiel für nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Konfiguration

Alle Werte sind optional; die Standards stehen in `.env.example`.

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | `3000` | Listen-Port |
| `PUBLIC_BASE_URL` | – | öffentliche Basis-URL ohne Slash am Ende |
| `CACHE_TTL_MINUTES` | `30` | Cache-Dauer der Spieldaten |
| `TRUST_PROXY` | `0` | `X-Forwarded-*` auswerten |

Emojis und Erinnerungszeiten stehen als `COMPETITIONS` bzw. `ALARM_MINUTES` in
`src/config.js`.

Ohne `PUBLIC_BASE_URL` werden die Links aus dem Request abgeleitet. Das genügt
zum Entwickeln, hinter einem Proxy aber nicht.

## Aufbau

```
.github/workflows/
  docker.yml     Tests, Multi-Arch-Build, Push nach GHCR
src/
  server.js      Express-App, Routen, ETag/304-Handling
  openligadb.js  API-Client, filtert auf Hertha und normalisiert die Spiele
  ics.js         iCalendar-Generator (RFC 5545), ohne Abhängigkeiten
  cache.js       Single-Flight-Cache mit Stale-on-Error
  config.js      Env-Konfiguration und Saisonlogik
public/          Landingpage, Impressum, Datenschutz, CSS, JS
test/            Unit-Tests (node:test)
```

Ein paar Entscheidungen, die beim Lesen des Codes sonst willkürlich wirken:

- **Saison automatisch.** Ab Juli gilt die neue Saison, im Mai und Juni wird
  zusätzlich die kommende abgefragt, sobald deren Spielplan veröffentlicht ist.
  Der Feed muss also zum Saisonwechsel nicht angefasst werden.
- **Stale-on-Error.** Fällt OpenLigaDB aus, wird der letzte gute Stand
  weitergeliefert. Ein veralteter Kalender ist besser als ein kaputter.
- **Deterministische Ausgabe.** Zeitstempel im Feed stammen aus den Daten, nicht
  aus der Uhr. Gleiche Daten ergeben Byte für Byte dieselbe Datei, damit `ETag`
  und `304` etwas wert sind – Kalender-Clients fragen sehr häufig nach.
- **`TRANSP:TRANSPARENT`.** Ein abonnierter Spielplan soll den Frei/Belegt-Status
  nicht blockieren.
- **Keine Drittanbieter.** Keine Cookies, keine Fonts von fremden Servern, keine
  Vereinswappen aus fremden Quellen. Eine CSP erzwingt das, statt es nur in der
  Datenschutzerklärung zu behaupten.

## Vor dem Livegang

- [ ] `public/impressum.html`: Name, ladungsfähige Anschrift, E-Mail eintragen
- [ ] `public/datenschutz.html`: Verantwortlichen, Hosting-Anbieter, Speicherdauer
      der Logfiles, zuständige Aufsichtsbehörde und Stand eintragen
- [ ] Logfile-Aufbewahrung am Server tatsächlich so einstellen, wie sie in der
      Datenschutzerklärung steht
- [ ] `PUBLIC_BASE_URL` auf die echte Domain setzen
- [ ] `npm install` einmal ausführen und `package-lock.json` committen –
      der Dockerfile nutzt dann `npm ci` statt `npm install`

Die Platzhalter sind in beiden Rechtstexten farbig hinterlegt und lassen sich so
nicht übersehen. Die Texte sind eine solide Grundlage, ersetzen aber keine
Rechtsberatung.

## Lizenz

MIT für den Code. Die Spieldaten gehören OpenLigaDB und dessen Mitwirkenden.
Vereinsnamen und Wappen sind Marken der jeweiligen Rechteinhaber.
