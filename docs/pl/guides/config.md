[English](../../en/guides/config.md) | Polski

# Config

## Minimalny config

`~/.agentic/config.yaml` (prywatny, globalny):

```yaml
profiles:
  work:
    match: { remote: "*gitlab.example.com*" }
    billing: api
    budget: { usd: 5, minutes: 30 }
  private:
    match: { path: "~/Projects/**" }
    billing: subscription
    budget: { tokens: 2000000, minutes: 45 }
default_profile: private
```

Repo serwisu, `.agentic/config.yaml`:

```yaml
review:
  checks: ["./gradlew build", "./gradlew test"]
```

`agentic init` wykrywa build (Gradle, Maven, npm), proponuje `review.checks`, `compile` i `test_reports`, pokazuje
plik i zapisuje go dopiero po Twoim „tak” (bez terminala: `--yes`). Istniejących plików nie nadpisuje.

## Klasy trudności

Taski z `tasks.yaml` mają **klasę trudności** (`mechanical | standard | domain | design`), a config mapuje ją
na executora — ID modeli nie trafiają do `tasks.yaml`:

```yaml
tiers:
  mechanical: { harness: codex,  model: luna,  effort: low }
  standard:   { harness: codex,  model: luna,  effort: medium }
  domain:     { harness: codex,  model: sol,   effort: high }
  design:     { harness: claude, model: opus,  effort: high }
```

## Warstwy

Warstwy (niższa nadpisuje wyższą): globalna (+ profil) → workspace zespołu → repo → flow.
Pełna lista pól: [reference/config.md](../../reference/config.md).

## Reguły frameworka i jak je wyłączyć

Skille praktyk frameworka niosą reguły z ID, które agenci stosują, a review cytuje: `AG-CODE-nn`
(`agentic-clean-code`), `AG-TQ-nn` (`agentic-test-quality`). Prefiks `AG-` jest zarezerwowany dla frameworka —
standardy zespołu (`.agentic/standards/*.md`) i skille repo używają własnych, np. `ARCH-01`, `TEST-03`, `CODE-01`;
reguła z `AG-` w standardach repo zatrzymuje start flow.

Nie każdy zespół chce każdą regułę. Trzy sposoby, od najszerszego:

```yaml
# .agentic/config.yaml (repo) albo config workspace zespołu
skills:
  disabled: [agentic-clean-code]   # skill znika ze wszystkich etapów (implement, fix, review-standards…)
rules:
  disabled: [AG-TQ-04]             # skill zostaje, ta jedna reguła nie: agenci jej nie stosują, review jej nie zgłasza
stages:
  implement:
    skills: [agentic-test-quality] # lista skilli jednego etapu (zastępuje domyślną)
```

Jak to działa:

- **Tablice zastępują, nie sumują.** `skills.disabled` z configu repo zastępuje listę z workspace — chcesz dołożyć
  wyłączenie do listy zespołu, przepisz całą listę.
- **Skill etapu** (`agentic-implement`, `agentic-review-standards`…) zostaje zawsze — jego wynik to kontrakt
  orkiestratora; podmienia go `stages.<etap>.stage_skill`.
- **Wyłączona reguła** trafia do promptu sesji jako „nie stosuj, nie cytuj”, a uwaga review, która ją cytuje,
  spada do nit z powodem.
- **`Checked by:`** przy regule standardu (np. `_Checked by:_ ArchUnit`) oddaje ją narzędziu z `review.checks`:
  recenzent jej nie zgłasza. Przy `review.checks: none` reguła zostaje u recenzenta (nic innego jej nie sprawdza).
  Skill `agentic-arch-tests` przenosi tak reguły architektury: z `ARCH-nn` w standardach pisze testy ArchUnit
  (albo narzędzia repo spoza JVM), każdy sprawdza na podłożonym naruszeniu i dopisuje `_Checked by:_`. Uruchamiasz
  go sam w swojej sesji Claude Code (`/agentic-arch-tests`, po `agentic skills install`).
- `agentic doctor` pokazuje, ile reguł frameworka jest aktywnych, co jest wyłączone i która warstwa configu
  (global / workspace / repo) to ustawiła, oraz ostrzega o literówkach w ID.

## Gdzie co leży

| Co | Gdzie |
|---|---|
| Artefakty flow (`ticket.md`, `spec.md`, `tasks.yaml`, `state.json`, `usage.jsonl`, raporty review) | `~/.agentic/work/<repo>-<hash>/<slug>/` (poza repo; flow sprzed 2026-10 zostają w `<repo>/.agentic/work/`) |
| Config globalny | `~/.agentic/config.yaml` (lub `$AGENTIC_HOME`) |
| Config repo | `<repo>/.agentic/config.yaml` |
| Workspace zespołu | katalog z `repos.yaml` i `.agentic/config.yaml` (lub `$AGENTIC_WORKSPACE`) |
