# Mit deiner KI die Community verstehen

Du brauchst keine Programmiererfahrung, um die ersten Aufträge zu verwenden. Verbinde deine KI mit diesem Repository oder öffne eine lokale Kopie in deinem KI-Werkzeug. Kopiere anschließend einen der Aufträge unten. Für reine Erklärungen brauchst du weder Installation noch Zugang zur echten Community.

## Zugriff auf die Dateien

- **Codex, Claude Code oder andere lokale Coding-Werkzeuge:** Repository herunterladen/klonen und seinen Wurzelordner öffnen. `AGENTS.md` enthält die gemeinsamen Regeln; `CLAUDE.md` importiert sie.
- **ChatGPT, Claude, Gemini oder andere Chat-Apps:** Das öffentliche Repository über eine verfügbare Integration bereitstellen oder die benötigten Dateien hochladen. Eine URL allein garantiert keinen vollständigen Dateizugriff. Frage zuerst, welche Dateien die KI tatsächlich lesen konnte.
- **Ohne Repository-Integration:** Für den Überblick reichen zunächst `README.md`, `AGENTS.md`, `docs/projektkarte.md`, `docs/arbeitsstand.md` und `docs/architektur.md`. Für konkrete Codefragen die dort verlinkten Quelldateien ergänzen. Niemals eigene `.env`-Dateien, Zugangsdaten oder echte Mitgliedsdaten hochladen.

Für Erklärungen eignet sich das aktuelle Standardmodell deines Werkzeugs. Für Umsetzung und Prüfung wähle ein leistungsfähiges Coding-Modell; konkrete Vorschläge stehen beim Entwicklungsauftrag. Modellnamen ändern sich – die tatsächlich verfügbaren Optionen sind maßgeblich.

## 1. Erst einmal verstehen

```text
Ich nehme an der KI-Manager-Ausbildung teil und möchte dieses Repository verstehen. Lies README.md, AGENTS.md, docs/projektkarte.md, docs/arbeitsstand.md und docs/architektur.md. Erkläre mir ohne vorausgesetzte Programmierkenntnisse:
1. Was können Mitglieder auf dieser Website tun?
2. Welche Teile laufen im Browser, welche auf dem Server und welche in der Datenbank?
3. Welche fünf Dateien sollte ich zuerst ansehen – und warum?
Beginne mit einem anschaulichen Beispiel. Erkläre jeden nötigen Fachbegriff beim ersten Auftreten. Belege Aussagen mit konkreten Dateipfaden; trenne implementierte Funktionen von Ideen und bekannten offenen Punkten. Sage, welche Dateien du wirklich lesen konntest. Verändere keine Dateien.
```

## 2. Den Tech Stack erklären lassen

```text
Erkläre mir den Tech Stack dieses Projekts. Lies AGENTS.md, docs/architektur.md, docs/technik.md, package.json und next.config.ts sowie passende Codebeispiele. Erstelle eine Tabelle: Technologie, Aufgabe in dieser Website, einfaches Beispiel, tatsächlicher Einsatzort. Verwende package.json für Versionsangaben. Unterscheide Bibliotheken, Entwicklungswerkzeuge und mögliche Hostingdienste. Erkläre insbesondere Next.js, React, TypeScript, Tailwind, PostgreSQL, Better Auth und SMTP. Behaupte keine aktive Cloudverbindung dieser Quellkopie. Nenne Alternativen nur als mögliche Optionen, nicht als Projektentscheidungen. Keine Änderungen durchführen.
```

## 3. Einen Beitrag vom Klick bis zur Speicherung verfolgen

```text
Zeige mir anhand des echten Codes, was passiert, wenn ein angemeldetes Mitglied einen Beitrag schreibt. Lies zuerst AGENTS.md und docs/architektur.md, dann src/components/community-app.tsx, src/lib/community-client.ts, src/app/api/posts/route.ts, src/lib/content.ts, src/lib/identity.ts, src/lib/security.ts und src/lib/db.ts. Verfolge die tatsächlich aufgerufenen Funktionen und lies weitere Abhängigkeiten nur bei Bedarf. Erkläre Eingabe, HTTP-Anfrage, Anmeldung/Mitgliedschaft, Validierung, Berechtigungsprüfung, Datenbanktransaktion, Antwort und Aktualisierung der Ansicht. Zeichne ein einfaches Ablaufdiagramm. Zeige auch, wo eine nicht angemeldete Anfrage oder ein ungültiger Text abgelehnt wird. Belege jeden Schritt mit Datei und Funktion, bei sicher bestimmbaren Zeilen auch Zeilennummer. Keine Änderungen und keine Anfragen an die echte Website.
```

## 4. Anmeldung und Datenschutz verstehen

```text
Erkläre mir, warum öffentlicher Quellcode nicht automatisch Zugriff auf private Community-Inhalte gibt. Lies AGENTS.md, docs/technik.md und die relevanten Dateien aus dem Bereich Anmeldung/Zugriff in docs/architektur.md. Unterscheide E-Mail-Anmeldung, Sitzung, Einladung, Mitgliedschaft und Eigentum an Beiträgen. Erkläre am Code, was auf dem Server geprüft wird, welche Daten der Browser erhält und welche Geheimnisse ausschließlich in eine eigene geschützte Umgebung gehören. Trenne beobachtbaren Schutz von verbleibenden Grenzen; versprich keine absolute Sicherheit. Keine echten Zugangsdaten anfordern oder Produktionstests ausführen.
```

## 5. Eine einzelne Datei gemeinsam lesen

```text
Hilf mir, [DATEIPFAD EINSETZEN] zu verstehen. Lies zuerst AGENTS.md und anschließend diese Datei sowie unmittelbar erforderliche Abhängigkeiten. Erkläre zuerst ihren Zweck in zwei Sätzen, dann Eingaben, Ausgaben und die wichtigsten Funktionen. Führe ein kleines synthetisches Beispiel durch den Code. Erkläre neue Fachbegriffe kurz. Stelle mir am Ende drei Verständnisfragen und warte auf meine Antworten. Keine Dateiänderungen. Falls der Pfad fehlt oder du die Datei nicht lesen kannst, benenne genau, was du benötigst.
```

## 6. Eine Weiterentwicklung zunächst planen

```text
Meine Idee für die Community ist: [IDEE EINSETZEN]. Erstelle zunächst einen umsetzbaren Vorschlag, ohne Dateien zu ändern. Lies AGENTS.md, docs/projekt.md, docs/arbeitsstand.md, docs/coding-standards.md und docs/architektur.md; prüfe danach gezielt den betroffenen Code. Beschreibe Nutzen und konkretes Verhalten, den kleinsten sinnvollen Umfang, betroffene Dateien, mögliche Datenbank-/API-/UI-Änderungen, Schutz von Anmeldung und Eigentum sowie passende Tests. Kennzeichne Annahmen und stelle nur Fragen, die die Umsetzung wesentlich verändern. Unterscheide vorhandene Funktionen von neuem Vorschlag. Keine Produktionszugänge, kostenpflichtigen Dienste oder automatische Veröffentlichung einplanen.
```

## 7. Einen bestätigten Vorschlag lokal umsetzen

Für Codex als Beispiel: **Umsetzung GPT-6.1 Sol / high**, bei sicherheitskritischen Änderungen **unabhängige Prüfung GPT-6 Astra / high**. Bei anderen Werkzeugen passende verfügbare Modelle wählen und Abweichungen nennen. Für kleine Änderungen ist keine künstliche Aufteilung nötig.

```text
Setze folgenden von mir bestätigten Vorschlag in meiner lokalen Kopie um: [VORSCHLAG EINSETZEN]. Lies AGENTS.md, docs/arbeitsstand.md und docs/coding-standards.md; vor Next.js-Code auch die passende lokale Frameworkdokumentation. Prüfe zunächst lokale Änderungen und erhalte meine Arbeit. Arbeite ausschließlich mit synthetischen lokalen Daten, ohne Zugang zur bestehenden Produktionsumgebung. Verwende npm und erhalte exakte Paketversionen samt Lockfile. Zeige die relevanten Änderungen, führe die vorgeschriebenen Prüfungen aus und aktualisiere betroffene Doku. Eine laufende Vorschau erhalten; Tests bei Bedarf in einer isolierten Kopie durchführen. Nenne tatsächlich ausgeführte Prüfungen und verbleibende Grenzen. Kein Push, Deployment oder Versand von Nachrichten ohne meinen gesonderten Auftrag. Falls du delegierst, nenne und setze Modell und Denkaufwand je Rolle ausdrücklich.
```

## Ergebnisse einordnen

Eine überzeugende Erklärung ist noch kein Nachweis. Lass dir die relevante Datei und Funktion zeigen; bei einer Umsetzung zusätzlich den Diff und die Testergebnisse. Ist der Code nicht zugänglich oder eine Prüfung nicht ausführbar, soll die KI das offen sagen. Vorschläge bleiben Vorschläge, bis du ihre Umsetzung beauftragst. Den aktuellen Projektzustand findest du immer im [Arbeitsstand](arbeitsstand.md).
