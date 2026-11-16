# KIMA Community

Quellcode einer privaten Lerncommunity für die KI-Manager-Ausbildung. Das Projekt zeigt eine gemeinsame Pinnwand, Kommentare, einen Gruppenchat und eine Anmeldung per E-Mail-Code. Der öffentliche Quellcode gewährt keinen Zugriff auf eine bestehende Community oder deren Daten.

Die Kopie dient zum Lernen und zur Weiterentwicklung. Sie enthält keine Betriebszugänge, Mitgliedsdaten, Cloudanbindung oder automatischen Sicherungsworkflows. Den aktuellen Entwicklungsstand und bekannte Einschränkungen beschreibt der [Arbeitsstand](docs/arbeitsstand.md).

## Mit deiner KI starten

Du möchtest verstehen, wie die Seite funktioniert oder wie du sie weiterentwickeln kannst? Öffne den **[KI-Lernguide mit kopierbaren Aufträgen](docs/ki-lernguide.md)**. Für den ersten Überblick musst du nichts installieren.

1. Stelle deiner KI dieses Repository über eine Integration oder eine lokale Kopie bereit.
2. Kopiere einen Auftrag aus dem Lernguide, etwa „Erst einmal verstehen“ oder „Den Tech Stack erklären lassen“.
3. Lass dir die Erklärung anhand der tatsächlichen Dateien zeigen. Die [Architekturkarte](docs/architektur.md) hilft bei der Orientierung.

Chat-Apps erhalten nicht automatisch Zugriff auf sämtliche Dateien hinter einem Link. Der Lernguide erklärt auch den Einstieg per Datei-Upload. Aktueller Stand und bekannte Fehler bleiben im [Arbeitsstand](docs/arbeitsstand.md) gebündelt.

## Lokale Beispielvorschau

Voraussetzung: Node.js 24 und npm.

```sh
npm ci
npm run preview:local
```

Die ausgegebene lokale URL öffnen und mit `vorschau@example.test` anmelden. Der Testcode erscheint im Terminal. Die Vorschau nutzt synthetische Daten und flüchtige lokale Datenbank-/SMTP-Dienste; beim Beenden gehen ihre Inhalte verloren. Nicht öffentlich bereitstellen.

Für eine eigene dauerhafte Umgebung gelten die [Einrichtung und API](docs/technik.md). Eine Veröffentlichung dieser Quellen richtet keine laufende Anwendung ein.

## Weiterarbeiten

- [Projektkarte](docs/projektkarte.md): Code- und Dokumentwege
- [Produktumfang](docs/projekt.md): Funktionen und Grenzen
- [Projektregeln](AGENTS.md) und [Coding Standards](docs/coding-standards.md)

Dieses Repository enthält keine eingeräumte Open-Source-Lizenz. Die öffentliche Lesbarkeit allein erteilt keine weitergehenden Nutzungsrechte.
