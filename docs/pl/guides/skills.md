[English](../../en/guides/skills.md) | Polski

# Skille

**Flow używa skilli z configu zespołu i repo (`stages.<etap>.skills`), nie z Twojego osobistego wyboru.**
`agentic skills` (zaznaczanie skilli i paczek) dotyczy tylko Twoich własnych sesji Claude Code / Codex —
odznaczenie skilla u siebie nie wyłącza go we flow. Chcesz zmienić skille flow: MR do configu zespołu.

Źródła: framework (bez prefiksu), `org:` (organizacja, katalogi wg technologii), `ext:` (zewnętrzne, przypięte),
`team:` (workspace), `repo:`, `me:` (prywatne).

**Praktyki we własnych sesjach**: `agentic skills install` linkuje skille praktyk frameworka do `~/.claude/skills`
(Claude Code) i `~/.agents/skills` (Codex) — symlinki, więc aktualizacja frameworka do nich dociera. Idempotentne;
pliku ani katalogu o tej samej nazwie nie rusza. `agentic skills` pokazuje, co gdzie jest; `agentic skills uninstall`
usuwa tylko te linki. Skille etapów (`agentic-implement`, `agentic-review-*`…) to kontrakty sesji flow — nie są instalowane.

**Skille do uruchamiania samemu** (poza flow, po `agentic skills install`: `/nazwa-skilla`):

- `agentic-context-map` — mapa kontekstów repo w dwóch przejściach: szkic z kodu (konteksty, relacje DDD, kontrakty,
  własność danych, hotspoty z historii gita) z listą niepewności i kandydatami do słownika, potem grill — pytanie po
  pytaniu z człowiekiem — który je rozstrzyga. Wynik w `.agentic/context-map.md` (+ plik na kontekst w monolicie).
- `agentic-coverage-filler` — gdy repo ma próg pokrycia (KPI, np. JaCoCo), generuje *fillery*: testy, które tylko
  wykonują kod do progu (+2 pkt zapasu). Osobna nazwa i tag, nagłówek „nie wzoruj się”, sekcja `Coverage fillers`
  w `testing.md`, dzięki której review ich nie ocenia. Po refaktorze cały zestaw generujesz od nowa zamiast go
  naprawiać; raport podaje klasy pokryte tylko fillerami (dług testów zachowania).

Reguły skilli praktyk i ich wyłączanie: [config.md](config.md#reguły-frameworka-i-jak-je-wyłączyć).
