# KIMA-Community – Lerngruppe 7

## Einstieg und Pflege
- Direkte Nutzeraufträge haben Vorrang vor diesen Projektregeln.
- Ziel ist die Weiterarbeit mit Codex und Claude Code ohne ausführlichen Übergabeprompt: Benötigtes Wissen muss im Projekt auffindbar sein, nicht nur im Chat.
- Zu Arbeitsbeginn [docs/arbeitsstand.md](docs/arbeitsstand.md) lesen; vor Implementierungen zusätzlich die [Coding Standards](docs/coding-standards.md). Ziele stehen in [docs/projekt.md](docs/projekt.md).
- Vom Arbeitsstand aus gezielt die betroffenen Dateien prüfen; kein routinemäßiges vollständiges Einlesen des Codes. Bei Abweichungen gilt der tatsächliche Projektzustand.
- Nach umgesetzten Änderungen den Arbeitsstand aktualisieren: Datum in Europe/Berlin, Umsetzung, relevante Dateien, Entscheidungen, Prüfungen und offene Schritte. Planungen klar von Erledigtem trennen; keine Gesprächschronik führen.
- Aktuelle Fakten jeweils an einer Stelle pflegen: Produktumfang in docs/projekt.md, Einrichtung und API in docs/technik.md, aktueller Stand/Prüfungen/offene Aufgaben in docs/arbeitsstand.md. Ergebnisse/ enthält datierte Nachweise, keine konkurrierenden Arbeitsaufträge.
- Bei jeder Änderung betroffene Doku und Verweise mitpflegen. Eindeutig ersetzte Pläne und redundante Artefakte nach Übernahme noch relevanter Entscheidungen entfernen; einzigartige Prüfnachweise und Nutzerdateien erhalten. Unklare Relevanz ist kein Löschgrund.
- Regeln ausschließlich in AGENTS.md pflegen; CLAUDE.md bleibt ein Import.

## Lernen und Erklären mit KI

- Diese öffentliche Quellkopie dient auch Teilnehmenden ohne Programmiererfahrung. Bei Verständnisfragen zuerst README.md, docs/projektkarte.md, docs/arbeitsstand.md und docs/architektur.md lesen; kopierbare Aufträge stehen in docs/ki-lernguide.md.
- Die Frage bestimmt den Umfang: Funktionsweise erklären, eine Änderung planen oder eine ausdrücklich beauftragte Änderung umsetzen. Erklärungs- und Planungsaufträge führen nicht ungefragt zu Dateiänderungen, Pushes oder Deployments.
- Einfache Sprache verwenden, Fachbegriffe beim ersten Auftreten erklären und bei Bedarf mit einem konkreten synthetischen Beispiel beginnen. Die Erklärung anschließend mit tatsächlichen Dateien und Funktionsnamen belegen; Zeilennummern nur nach Prüfung nennen.
- Nur auftragsrelevante Abhängigkeiten nachlesen. Implementiertes Verhalten, Annahmen, Vorschläge und bekannte offene Punkte klar auseinanderhalten. Fehlenden Dateizugriff oder nicht ausgeführte Prüfungen benennen; keine Repositorykenntnis aus einer URL allein behaupten.
- Versionen aus package.json/Lockfile beziehen. Keine aktive Produktionsanbindung, Nutzungslizenz oder Zugriffserlaubnis aus der öffentlichen Lesbarkeit ableiten. Für Lernproben lokale synthetische Daten verwenden; keine echten Mitgliedsdaten oder Secrets anfordern.

## Anbieter und Startordner
- Projekt möglichst in diesem Wurzelordner öffnen. Bei Einstieg in einem Unterordner zuerst die Projektwurzel mit README.md, package.json und dieser AGENTS.md finden und ihre Regeln sowie docs/arbeitsstand.md lesen; das gilt auch ohne Git.
- **Codex:** AGENTS.md ist der Einstieg. Ohne erkannte Projektwurzel ist automatisches Laden von Elternregeln nicht vorauszusetzen; beim Unterordnereinstieg die Wurzelregeln ausdrücklich lesen.
- **Claude Code:** CLAUDE.md ist der Einstieg; Elternanweisungen können zusätzlich gelten. Nach Änderungen in einer frischen Sitzung den tatsächlich geladenen Kontext prüfen. CLAUDE.md importiert die gemeinsame AGENTS.md.
- **ChatGPT-/Claude-Apps ohne lokalen Dateizugriff:** Projektdateien werden nicht automatisch geladen oder synchronisiert. Die benötigte aktuelle Doku muss über Upload/Integration bereitgestellt werden; ein Anbieterwechsel allein garantiert keinen Kontext.


## Entwicklung
- npm verwenden; exakte Paketversionen und Lockfile gemeinsam pflegen.
- Bei Code- oder Konfigurationsänderungen vor Übergabe `npm run typecheck`, `npm run lint`, `npm test` und `npm run build` ausführen; Grenzen der lokalen Tests benennen. Bei reinen Dokumentationsänderungen Konsistenz, lokale Links und Importziele prüfen.
- Laufende Nutzervorschauen erhalten; keine zweite Next-dev-Instanz im selben Ordner starten. Tests starten ebenfalls Next dev: Prüfungen und Vorschau koordinieren, laufende Daten oder Prozesse nicht ungefragt zurücksetzen.
- Bei Änderungen an Anmeldung, Datenbank oder Agentenzugang docs/technik.md lesen. Mitgliedschaft, Eigentumsprüfung und Agentenkennzeichnung serverseitig erzwingen.
- Angewandte Migrationen nicht verändern; neue Änderungen als zusätzliche Migration ablegen.

## Grenzen und Abschluss
- Zweck: langfristiger Austausch aktueller Teilnehmender, neuer Mitglieder und Alumni. Der bestätigte MVP steht in docs/projekt.md; Stack und Einrichtung stehen in docs/technik.md.
- Keine Zugangsdaten, echten Teilnehmerdaten oder privaten Referenzpfade in Projektdateien aufnehmen. Unter public/ nur öffentlich geeignete Inhalte ablegen.
- Generierte Berichte und Ergebnisartefakte unter Ergebnisse/ speichern.
- Nur tatsächlich ausgeführte Prüfungen als durchgeführt melden; offene Prüfungen und Einschränkungen benennen. Befehle erst dokumentieren, wenn sie im Projekt existieren.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Orchestrator und Sub-Agents

- Standardmäßig führt ein starkes, aktuell verfügbares Modell als Orchestrator: Auftrag verstehen, planen, Arbeit aufteilen, Ergebnisse integrieren und Abschluss verantworten. Tatsächlich gewähltes Modell prüfen; eine nicht mögliche Modellumschaltung offenlegen.
- Je nach Aufgabe mehrere Sub-Agents für klar getrennte Arbeit oder unabhängige Prüfung einsetzen. Kleine, eng gekoppelte Aufgaben nicht künstlich aufteilen; vorhandene strengere Review-Regeln gelten weiter.
- Pro Delegation Modell und Denkaufwand ausdrücklich wählen: leicht für mechanische Aufgaben, leistungsfähig für Umsetzung, stark für Architektur, schwierige Fehler und kritische Prüfung. Verfügbarkeit beim Anbieter prüfen; Auswahl und Abweichungen anhand der Laufmetadaten offenlegen. Bei Codex den verfügbaren Skill `codex-modellwahl` beachten.
- Teilaufträge nennen Ziel, nötigen Kontext, zuständige Dateien, Grenzen und Prüfkriterien. Unabhängige Aufgaben parallel bearbeiten, konkurrierende Dateiänderungen vermeiden. Orchestrator prüft die Ergebnisse; bei größerer Arbeit Übergaben im Projekt dokumentieren. Fehlende Sub-Agent-Funktionen offenlegen.

## Gemeinsame KI-Arbeitsweise

- Nur AGENTS.md pflegen; CLAUDE.md importiert sie. Antigravity liest AGENTS.md nativ.
- Zum Einstieg [Projektkarte](docs/projektkarte.md), die dort benannte Statusquelle und nur auftragsrelevante Unterordnerregeln lesen; Wurzel auch ohne Git ausdrücklich feststellen.
- Vor Änderungen vorhandene lokale Arbeit erhalten und Zuständigkeiten bei paralleler Arbeit klären. Die Projektkarte zeigt Quellen und Orte.
- Zum Abschluss nur den entwicklungs- bzw. arbeitsrelevanten aktuellen Stand, nächste Schritte, Prüfungen und betroffene Doku/Links nachführen.
- Dokumentation schlank halten: nur Informationen für Weiterentwicklung, Fehlersuche, Prüfung oder sicheren Betrieb festhalten; bei Fachprojekten nur für die weitere Arbeit nötiges Wissen. Je Information eine maßgebliche Quelle. Bestehende Einträge aktualisieren statt Sitzungsberichte anzuhängen; keine Chatprotokolle, redundanten Zusammenfassungen, Code-Nacherzählungen oder vorsorglichen Dokumente. Kurze Einstiege, Details nur bei Bedarf thematisch verlinken. Bei Änderungen Überholtes und Dopplungen bereinigen, Links prüfen; Originale und notwendige Nachweise erhalten.
- Import-/Linkprüfung und tatsächliches Laden in frischen KI-Sitzungen getrennt ausweisen.
