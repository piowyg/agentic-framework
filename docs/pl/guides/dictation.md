[English](../../en/guides/dictation.md) | Polski

# Dyktowanie

Grille (biznesowy, techniczny) to dużo pytań otwartych — odpowiedź głosem jest kilka razy szybsza niż pisanie,
a agent dobrze radzi sobie z luźną mową. Polecamy [Handy](https://handy.computer): darmowy, open source, działa
lokalnie (offline), wkleja tekst w aktywne okno — także w terminal z sesją agenta.

```bash
brew install --cask handy          # macOS; Windows/Linux: instalator z handy.computer
```

Po pierwszym uruchomieniu: zezwól na mikrofon i dostępność (Accessibility — do wklejania tekstu), wybierz model
(Parakeet V3: szybki, wiele języków, w tym polski; Whisper Turbo przy mieszaniu języków i żargonu) i ustaw skrót
push-to-talk. `agentic doctor` podpowiada dyktowanie, gdy nie znajdzie Handy ani innej znanej aplikacji
(superwhisper, MacWhisper, VoiceInk, Wispr Flow) — to tylko wskazówka, nic nie wymusza.
`agentic setup` proponuje instalację raz (macOS z Homebrew, za zgodą); odmowę zapamiętuje w `~/.agentic/setup.json`
i więcej nie pyta.

