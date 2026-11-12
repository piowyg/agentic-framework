English | [Polski](../../pl/guides/dictation.md)

# Dictation

Grills (business, technical) are a lot of open questions — answering by voice is several times faster than typing,
and the agent handles loose speech well. We recommend [Handy](https://handy.computer): free, open source, runs
locally (offline), and pastes text into the active window — including a terminal with an agent session.

```bash
brew install --cask handy          # macOS; Windows/Linux: installer from handy.computer
```

After the first launch: allow the microphone and Accessibility (to paste text), pick a model (Parakeet V3: fast,
many languages; Whisper Turbo when mixing languages and jargon) and set a push-to-talk shortcut. `agentic doctor`
suggests dictation when it finds neither Handy nor another known app (superwhisper, MacWhisper, VoiceInk,
Wispr Flow) — it's just a hint, nothing is enforced. `agentic setup` offers the installation once (macOS with
Homebrew, with your consent); it remembers a refusal in `~/.agentic/setup.json` and doesn't ask again.
