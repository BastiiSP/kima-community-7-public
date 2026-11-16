# Coding Standards

## Code und Sprache
- Module klein halten und jeweils eine klare Verantwortung geben. Wiederverwendung nach tatsächlichem Bedarf einführen.
- Verständliche englische Bezeichner für Code verwenden; Dokumentation und Oberflächentexte auf Deutsch schreiben.
- Fehler nachvollziehbar behandeln: hilfreiche Rückmeldungen geben, Fehler nicht still verschlucken und keine Geheimnisse protokollieren.
- Bestehende Konventionen beachten; neue Abhängigkeiten nur mit konkretem Nutzen aufnehmen.

## Oberfläche und Daten
- Semantische Elemente, beschriftete Eingaben, sichtbaren Tastaturfokus und vollständige Tastaturbedienbarkeit vorsehen.
- Keine echten Teilnehmerdaten oder Zugangsdaten in Code, Beispielen, Tests oder Dokumentation speichern. Synthetische Testdaten verwenden.
- public/ ist ausschließlich für öffentlich geeignete Inhalte bestimmt.
- Lokale Geheimnisse außerhalb der Versionsverwaltung halten; .env.example enthält nur Platzhalter. Die .gitignore ersetzt keine Prüfung auf versehentlich abgelegte Geheimnisse.

## Format und Qualität
- UTF-8, LF, abschließenden Zeilenumbruch und zwei Leerzeichen verwenden; abweichende zwingende Dateiformatregeln beachten. Markdown-Zeilenumbrüche erhalten.
- Bestehende Prüfkommandos aus [technik.md](technik.md) verwenden; neue Werkzeuge nur bei konkretem Bedarf ergänzen.
- Verhaltensänderungen mit passenden Tests prüfen; Fehlerkorrekturen nach Möglichkeit mit Regressionstests absichern. Tests sollen Verhalten und relevante Fehlerfälle prüfen.
- Prüfungen dem Änderungsrisiko anpassen. Reine Dokumentationsänderungen auf Konsistenz und gültige Links prüfen.

## Abschluss einer Änderung
- Relevante Prüfungen ausführen und tatsächliche Ergebnisse sowie ungeprüfte Bereiche benennen.
- [Arbeitsstand](arbeitsstand.md) auf den tatsächlichen Projektzustand bringen, einschließlich relevanter Dateien und nächster Schritte.
- Bei Änderungen der Agentenanweisungen ausschließlich AGENTS.md pflegen; CLAUDE.md bleibt ein Import. Importziel und tatsächliches Laden getrennt prüfen.
- Generierte Ergebnisartefakte in Ergebnisse/ ablegen.
