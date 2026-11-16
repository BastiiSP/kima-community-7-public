# Aktueller Arbeitsstand

**Stand: 16.11.2026 (Europe/Berlin).** Öffentliche Lern-Quellkopie des implementierten Community-MVP. Enthalten sind Anwendung, Tests, Migrationen und allgemeine Hilfsskripte; private Betriebsdokumentation, Daten, Zugangsdaten und aktive Sicherungsworkflows gehören nicht zu dieser Kopie. Der Funktionsumfang steht in [projekt.md](projekt.md), Einrichtung und Schnittstellen in [technik.md](technik.md).

## Bekannter Fehler

Ein kurzer Bedienungshänger nach Beitragserstellung und Wechsel zwischen normalem und Inkognitofenster in Chrome auf dem Mac bleibt ungelöst. Bisherige isolierte Proben haben keine belastbare Ursache bestätigt. Die weitere Untersuchung ist ausdrücklich zurückgestellt; diese Kopie enthält keinen neuen Fix dafür.

## Prüfstand

Die Quellkopie ist zusammengestellt. Der lokale Projektcheck meldete null Fehler und null Warnungen; alle lokalen Markdown-Verweise und der Claude-Import sind gültig. Ein tatsächlicher Ladetest in frischen KI-Sitzungen wurde nicht ausgeführt. Typprüfung, Lint, Tests und Produktionsbuild dieser Kopie stehen noch aus. Frühere private Betriebs- oder Browsertests sind keine aktuelle Abnahme der öffentlichen Kopie.

Die Veröffentlichung des Codes ist keine Freigabe für unbeaufsichtigten Gruppenbetrieb. Reale E-Mail-Zustellung, Hosting, Datenbankrollen, Sicherung/Wiederherstellung, Datenschutz und die eigenen Betriebsabläufe müssen für jede neue Umgebung eingerichtet und geprüft werden.

## Nächste Schritte

Für den Einstieg stehen der [KI-Lernguide](ki-lernguide.md) und die [Architekturkarte](architektur.md) bereit. Eigene Weiterentwicklungen zunächst anhand des Codes planen und lokal mit synthetischen Daten prüfen. Für zusätzliche Funktionen oder erneute Fehleranalyse ist kein Folgeauftrag festgelegt.
