# Technik und Einrichtung

## Architektur

Next.js App Router, React, TypeScript und Tailwind; PostgreSQL über `pg`, Better Auth für E-Mail-Codes und Nodemailer für SMTP. Die exakten Paketversionen stehen in [package.json](../package.json) und [package-lock.json](../package-lock.json). Node.js 24 und npm verwenden.

Die [Oberfläche](../src/components/) ruft die [API-Routen](../src/app/api/) derselben Origin auf. Serverseitige [Zugriffsprüfung und Geschäftslogik](../src/lib/) erzwingen Mitgliedschaft, Eigentum und Limits; die Oberfläche allein vergibt keine Berechtigungen. Die Quellen enthalten keine Verbindung zu einer bestehenden Produktionsumgebung.

## Lokaler Einstieg

Die flüchtige Vorschau aus dem [README](../README.md) benötigt keine eigenen Cloudzugänge. Für eine eigene dauerhafte Umgebung:

1. `npm ci` ausführen und `.env.example` nach `.env.local` kopieren. Die Beispielwerte ersetzen; Geheimnisse niemals unter `NEXT_PUBLIC_*` oder in der Versionsverwaltung ablegen.
2. Eine eigene PostgreSQL-Datenbank wählen. Produktion verlangt `sslmode=verify-full`. Laufzeitkonto und Betreiber-/Migrationskonto mit getrennten Rechten einrichten.
3. `BETTER_AUTH_SECRET` kryptografisch zufällig mit mindestens 32 Zeichen erzeugen. `BETTER_AUTH_URL` auf eine feste Origin ohne Pfad, Query oder Fragment setzen; Produktion verlangt HTTPS. Je Umgebung eigene Secrets verwenden.
4. Eigenen SMTP-Zugang und verifizierten Absender konfigurieren. `SMTP_SECURE=true` verwendet implizites TLS, sonst ist STARTTLS Pflicht. Unsicheres SMTP ist ausschließlich für lokale Testdienste vorgesehen. Echte Zustellung und Anbietergrenzen selbst prüfen.
5. `npm run db:migrate` ausschließlich gegen die ausdrücklich gewählte eigene Datenbank ausführen. Die fünf versionierten Migrationen ergänzen Grundschema, Rate-Limit-Index, Betreiberabläufe, Gruppenchat und Wiederherstellungsjournal. Migrationen werden mit Prüfsummen und gemeinsamem Transaktionsschutz angewandt; bereits angewandte SQL-Dateien nicht ändern.
6. `npm run db:invite -- --bootstrap` erzeugt die erste einmalige Einladung, solange weder Mitglieder noch gültige Einladungen bestehen. Die Ausgabe ist ein Zugangsgeheimnis und gehört nicht in öffentliche Logs. Danach können Mitglieder einladen.
7. `npm run dev` startet die lokale Entwicklung; `npm run build` und `npm start` bauen und starten die Anwendung. Eine eigene öffentliche Installation benötigt zusätzlich die Prüfung ihrer Hosting-, Datenschutz- und Betriebsanforderungen.

Fehlende Auth-/SMTP-Konfiguration sperrt die Community-Endpunkte. Eine konfigurierte, aber unerreichbare SMTP-Verbindung verhindert nicht automatisch die Nutzung vorhandener Sitzungen.

## Prüfungen und Vorschau

| Befehl | Zweck |
| --- | --- |
| `npm run preview:local` | Flüchtige lokale Beispielvorschau |
| `npm run typecheck` | Next-Routentypen und TypeScript |
| `npm run lint` | ESLint und React-Regeln |
| `npm test` | Integration und Regression mit synthetischen Daten |
| `npm run build` | Produktionsbuild |
| `npm run test:postgresql` | Opt-in-Konkurrenzprüfung mit leerer lokaler PG18-Datenbank über `KIMA_ACCEPTANCE_DATABASE_URL` |
| `node --import tsx --test tests/postgresql-resume.acceptance.ts` | Opt-in-Pool-/Sitzungsprüfung; `KIMA_TEST_POSTGRES_BIN` verweist auf lokale PostgreSQL-18-Werkzeuge |

Tests starten ebenfalls Next dev. Eine laufende Vorschau erhalten und Prüfungen in einer separaten temporären Kopie ohne eigene `.env*` ausführen; dabei `.env.example` erhalten. Build und Typgenerierung dort ausführen, um das Buildverzeichnis der Vorschau nicht zu verändern. Tests und lokale Datenbankproben ersetzen keine Prüfung des eigenen Hostings, Verbindungspoolers oder Mailversands.

Der gezielte `minimatch`-Override für `@typescript-eslint/typescript-estree@8.72.2` ist Teil des unveränderten Paketstands. Bei einem Update neu bewerten und nach einem geeigneten regulären Fix entfernen; Manifest und Lockfile gemeinsam pflegen.

## Anmeldung und Schutzgrenzen

Community-Inhalte benötigen eine persönliche Sitzung und Mitgliedschaft. Mutation per Cookie verlangt die konfigurierte Origin; Authorization-Header werden für diese Endpunkte zurückgewiesen. E-Mail-Codes sind sechs Stellen lang, fünf Minuten gültig, gehasht gespeichert und einmalig verwendbar; Einladungen sind zufällige, gehashte Einmaltokens mit sieben Tagen Gültigkeit. Neue Einladungslinks transportieren den Token im URL-Fragment; der Client übernimmt ihn in den Arbeitsspeicher und bereinigt die sichtbare URL.

Sitzungen gelten sieben Tage und werden bei Nutzung nach einem Tag verlängert; Abmeldung widerruft die aktuelle Sitzung. Eigentum an Inhalten und Mitgliedschaft werden serverseitig geprüft. Texte werden als React-Text ausgegeben; SQL-Werte sind parametrisiert. CSP, Sicherheitsheader und `private, no-store` schützen Dokumente und API-Antworten. Rate-Limits begrenzen Missbrauch, ersetzen aber weder Verfügbarkeitskontrolle noch Infrastrukturgrenzen.

Nur mit `VERCEL=1` vertraut die App `x-vercel-forwarded-for`; außerhalb dieser Umgebung verwenden Anfragen einen gemeinsamen Ersatzbucket. Andere Proxy-Topologien müssen vor öffentlichem Einsatz gezielt angepasst und geprüft werden.

## API-Überblick

Die genaue Implementierung unter [src/app/api](../src/app/api/) ist maßgeblich. JSON-Anfragen verlangen `application/json`; Text ist auf 5.000 Zeichen begrenzt. Fehler enthalten generische Rückmeldungen ohne SQL- oder Secret-Details.

| Methode und Pfad | Funktion |
| --- | --- |
| `GET /api/community` | Pinnwand mit Beiträgen, Kommentarvorschau und `nextCursor` |
| `GET /api/posts/{id}/comments` | Weitere Kommentare mit `nextCursor` |
| `POST /api/posts` | `{body}` → neuer Beitrag |
| `POST /api/posts/{id}/comments` | `{body}` → neuer Kommentar |
| `PATCH /api/posts/{id}`, `PATCH /api/comments/{id}` | Eigenen Text ändern |
| `DELETE /api/posts/{id}`, `DELETE /api/comments/{id}` | Eigenen Inhalt löschen |
| `GET /api/chat` | Neueste Nachrichten; `before`/`after` für weitere Seiten |
| `POST /api/chat` | `{body}` → neue Nachricht |
| `DELETE /api/chat/{id}` | Eigene Nachricht löschen |
| `POST /api/invitations` | Einmaligen Einladungslink erzeugen |
| `POST /api/join` | `{token, firstName, lastName}` → Mitgliedsbeitritt |

Auth erlaubt `GET /api/auth/get-session` und POST auf `/api/auth/email-otp/send-verification-otp`, `/api/auth/sign-in/email-otp` und `/api/auth/sign-out`. Andere Authfunktionen sind nicht freigeschaltet. Cursor unverändert URL-kodiert weiterreichen; Chatcursor sind Positionswerte und keine Zeitstempel.

Die sichtbare Pinnwand aktualisiert sich ungefähr alle zehn Sekunden, der sichtbare Chat ungefähr alle 2,5 Sekunden. Versteckte/offline Ansichten pausieren Abrufe. Anfragen haben eine 15-Sekunden-Deadline einschließlich Antwortkörper; Schreibanfragen werden nach unklarem Netzwerkfehler nicht automatisch wiederholt. Ein bereits gespeicherter Text könnte sonst doppelt entstehen. Der bekannte Bedienungsfehler bleibt im [Arbeitsstand](arbeitsstand.md) ausgewiesen.

## Verwaltung und Sicherung

`npm run ops -- status`, `members` und `member <ID>` lesen den gewählten eigenen Datenbankzustand. Mutationen `block`, `unblock`, `revoke` und `delete` benötigen `<ID> --confirm <ID>`; `emergency --confirm emergency` pausiert den Dienst und widerruft Zugänge, `resume --confirm resume` hebt nur die Pause auf. Datenbankzugang verleiht diese Rechte; es gibt keine Web-Adminrolle. Vor Eingriffen Identität, Zielumgebung und Folgen prüfen.

Kontolöschung entfernt Profil, Authdaten, eigene Kommentare und Chattexte. Eigene Beiträge bleiben geleert und autorlos als Gesprächshüllen bestehen; fremde Antworten bleiben erhalten. Bereits gelieferte Daten, externe Kopien und Sicherungen werden dadurch nicht zurückgerufen.

Die [Sicherungsskripte](../scripts/backup.ts) sind allgemeiner Code ohne aktive Zeitplanung, Schlüssel, Konfiguration oder Produktionsanbindung. `npm run backup -- backup|source|verify|health --config DATEI` benötigt eine private Konfigurationsdatei außerhalb des Projekts; `restore` verlangt zusätzlich identische Werte für `--id` und `--confirm`. Das Schema steht in [backup-config.ts](../scripts/backup-config.ts): getrennte Pfade für Quelle, Schlüssel, Archive und PostgreSQL-Werkzeuge; Archive 0700, Secretdateien 0600 und ein 32-Byte-Schlüssel. Wiederherstellung verwendet ein isoliertes lokales Ziel und gibt es nicht automatisch zur Nutzung frei. Vor Verwendung eine eigene Wiederherstellungsprobe durchführen.

`/api/ops/backup-health` ist ein geschützter, optionaler Monitor über `CRON_SECRET` und `OPS_ALERT_EMAIL`. Diese Kopie plant keine Aufrufe. Wer einen eigenen Betrieb einrichtet, muss Überwachung, Aufbewahrung, Schlüsselwiederherstellung, Informationspflichten und Verantwortlichkeit selbst festlegen und prüfen.

Der Alarmtext in `src/app/api/ops/backup-health/route.ts` stammt aus einem Beispielbetrieb und nennt einen Projektnamen sowie tägliche Prüfung und sieben Tage Aufbewahrung. Vor eigener Nutzung Text und Betriebsannahmen an die eigene tatsächliche Einrichtung anpassen; diese Kopie richtet die genannten Abläufe nicht ein.
