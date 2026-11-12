[English](README.md) | Polski

# agentic-framework

CLI, które prowadzi agentów AI od pomysłu do pull requesta, z człowiekiem na każdej ważnej decyzji.

## Co dostajesz

- **Bramki dla człowieka.** Ticket, spec, podział na taski i finalny review czekają na Twoją decyzję; push i PR
  robisz tylko Ty.
- **TDD w sandboxie.** Każdy task implementuje świeża sesja agenta w jednorazowym kontenerze, bez remote,
  credentiali gita i otwartej sieci.
- **Review z pętlą poprawek.** Dwie osie (zgodność ze specem, standardy zespołu), mechaniczna weryfikacja uwag
  i fixer w pętli z zabezpieczeniami.
- **Harness, model i effort per etap.** Claude Code albo Codex CLI, dobierane do etapu i trudności taska.
  Orkiestrator jest deterministyczny i sam nie zużywa tokenów.

## Jak to działa

```
pomysł / ticket / epik
  → grill biznesowy → ticket.md        [bramka]
  → grill techniczny → spec.md         [bramka]
  → breakdown → tasks.yaml             [bramka]
  → implementacja TDD w sandboxie, per grupa (świeża sesja per task)
  → review w dwóch osiach (spec, standards) → fixer, w pętli z zabezpieczeniami
  → finalny review                     [bramka]
  → agentic publish (tylko człowiek: skan sekretów → push → PR)
```

```bash
agentic new "Limit koszyka"        # nowy flow od pomysłu
agentic pick ticket.md             # flow od gotowego ticketu
agentic status limit-koszyka       # gdzie stoi flow i dlaczego
agentic publish limit-koszyka      # skan sekretów, push, PR
```

## Wymagania

- Node.js 22.12+ i git
- Claude Code albo Codex CLI
- Podman albo Docker (sesje w kontenerze; `agentic setup` zainstaluje Podmana)
- gitleaks (skan sekretów przed `publish`)

## Instalacja

```bash
git clone https://github.com/piowyg/agentic-framework.git && cd agentic-framework
npm install && npm run build && npm link
agentic doctor
```

Dalej: [pierwsze kroki](docs/pl/getting-started.md), z próbą całego flow bez tokenów.

## Dokumentacja

- [Pierwsze kroki](docs/pl/getting-started.md)
- [Przewodnik SWE](docs/pl/guides/swe.md): od instalacji do PR-a na prawdziwym repo
- [Pojęcia](docs/pl/concepts.md)
- [Bezpieczeństwo](docs/pl/security.md)
- [Cała dokumentacja](docs/pl/README.md)
- [Współtworzenie](CONTRIBUTING.md) (po angielsku)

## Licencja

Apache License 2.0, zobacz [LICENSE](LICENSE) i [NOTICE](NOTICE).
Część skilli powstała na bazie [mattpocock/skills](https://github.com/mattpocock/skills) (MIT), zobacz
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
