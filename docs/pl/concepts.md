[English](../en/concepts.md) | Polski

# Pojęcia

Słownik i model działania frameworka w jednym miejscu.
Praktyka krok po kroku: [guides/swe.md](guides/swe.md).

## Flow

**Flow** to droga jednego ticketu od pomysłu do PR-a. Ma **slug** (z tytułu, np. `limit-koszyka`) i własny
katalog z artefaktami: `~/.agentic/work/<repo>-<hash>/<slug>/`, poza drzewem repo (`$AGENTIC_HOME` przenosi całość).

```
agentic new / pick
  → grill biznesowy  → ticket.md   [bramka ticket]
  → grill techniczny → spec.md     [bramka spec]
  → breakdown        → tasks.yaml  [bramka breakdown]
  → per grupa: write-tests → taski → checks → review ⇄ fix   [bramka group]
  → scalenie grup (_final)                                    [bramka merge]
  → finalny review ⇄ fix                                      [bramka final]
  → status done, outcome ready_to_publish
agentic publish (tylko człowiek)
```

- `new` zaczyna od grilla biznesowego. `pick` z gotowym ticketem (`status: ready`, kryteria `AC-n`) zaczyna od
  grilla technicznego; inny tekst trafia do `idea.md` i też przechodzi przez grill biznesowy.
- **Stan** flow jest w `state.json`: etap, grupy, rundy, pauza. Orkiestrator to deterministyczny CLI. Sam nie zużywa
  tokenów i po każdym kroku zapisuje stan, więc flow da się wznowić po przerwaniu, zamknięciu terminala albo crashu.
- **Statusy:** `running`, `paused` (czeka na `agentic resume`), `done`, `aborted` (przerwany przez człowieka),
  `failed` (pętla review zakończona z `on_stop: fail` albo rate limit przy `on_rate_limit: fail`).
- **Zdarzenia** dopisują się do `events.jsonl`: starty i końce etapów i sesji, decyzje na bramkach, rundy review.
  To dziennik. O tym, gdzie jest flow, rozstrzyga `state.json`.

## Etapy i artefakty

| Etap | Sesja | Wynik |
|---|---|---|
| grill biznesowy | interaktywna, w terminalu | `ticket.md`: „co” (zachowanie), kryteria `AC-n` |
| grill techniczny | interaktywna | `spec.md`: „jak”, w tym **Test seams** (publiczne interfejsy, na których powstają testy) i **Contracts** |
| breakdown | bez człowieka | `tasks.yaml`: grupy z szacunkiem rozmiaru, taski z klasą trudności |
| write-tests | bez człowieka, sandbox | testy z AC grupy, które muszą być czerwone na kodzie bazowym |
| implementacja | świeża sesja per task | commity w klonie grupy, aż testy z write-tests przejdą |
| review / fix | osobne sesje per oś | raporty `review-<grupa>-r<N>.json`, poprawki fixera |
| finalny review | na pełnym diffie | `review-final-r<N>.json` |

Interaktywny etap kończy się, gdy agent zapisze artefakt ze `status: ready` we frontmatterze i wyjdziesz z sesji.
Orkiestrator sprawdza artefakt (format, ID AC) i dopiero wtedy pokazuje bramkę.

## Grupa i task

- **Task** to najmniejszy krok. Wskazuje `acceptance: [AC-n]` i ma **klasę trudności** (tier: `mechanical`,
  `standard`, `domain`, `design`). Config mapuje klasę na executora, więc ID modeli nie trafiają do `tasks.yaml`.
- **Grupa** to 3–5 tasków w jednym repo: spójny pionowy kawałek zmiany. Jest jednostką review, commitu i klonu
  i staje się jednym PR-em. Grupy mogą zależeć od siebie (`depends_on`).
- Każda grupa ma **szacunek** linii, które zmieni jej diff (`estimate: { prod, tests }`). Grupa ponad progiem
  `publish.size` (domyślnie 400 linii produkcyjnych, 800 razem z testami) potrzebuje w planie `oversize_reason`,
  inaczej plan wraca do sesji breakdown. Diff skończonej grupy też jest mierzony: jeśli przekroczy próg, pod którym
  został szacunek (albo dwa razy szacunek już ponad progiem), mówią o tym log, `group_done` i `agentic status` (ostrzeżenie, nic się nie zatrzymuje).
  Grill techniczny może zapisać kolejność pracy w sekcji `## Slices` specu:
  najpierw prefactor, potem cienkie pionowe kawałki.
- Przy `publish.stack` (domyślnie włączone) grupy jednego repo tworzą **łańcuch**: jedna pierwsza, każda następna
  zależy od poprzedniej, więc każdy PR może leżeć na poprzednim. Grupy z różnych repo idą równolegle, gdy
  `parallel_groups` > 1. Przy `publish.stack: false` równolegle idą też niezależne grupy jednego repo.
- Każda grupa pracuje we własnym **klonie** repo w katalogu flow, nigdy w Twoim drzewie roboczym. Wynik trafia do
  gałęzi `agentic/<slug>/<grupa>` w Twoim repo. Grupa zależna startuje ze scalonych gałęzi poprzedników.
  Na końcu gałąź `agentic/<slug>/_final` ma całość i to ją publikuje `publish`.

## Executor: harness, model, effort

Każda sesja ma **executora**: `harness` (CLI agenta: `claude` albo `codex`), `model` (alias z rejestru,
`agentic models`) i `effort`. Grille i breakdown biorą executora z `stages.<etap>`, taski z `tiers` według klasy,
a review z `review.<oś>`. Fixer domyślnie dostaje model grupy.

## Bramki i autonomia

**Bramka** to miejsce, w którym flow czeka na człowieka: `ticket`, `spec`, `breakdown`, `group`, `merge`, `final`.
Preset `autonomy` wybiera, które są aktywne:

| Preset | Bramki |
|---|---|
| `strict` | wszystkie |
| `standard` (domyślny) | ticket, spec, breakdown, merge, final |
| `autopilot` | breakdown, final (merge przechodzi sama przy zielonych checks) |
| `custom` | lista z `gates` |

Wyjątek: gdy diff feature'a dotyka ścieżek z `publish.one_way_paths` (migracje, kontrakty), bramka `final` pyta
w każdym presecie i wymienia te pliki. Revert przywróci kod, ale nie cofnie tego, co taka zmiana już zrobi.

Na bramce dokumentu wybierasz: **kontynuuj**, **popraw z notatką** (agent poprawia artefakt), **zapisz i wstrzymaj**
albo **przerwij flow**. Na bramkach pętli review (`group`, `final`) dochodzi **cofnij do rundy review**: kod wraca do
stanu z rundy N, a fixer jeszcze raz poprawia uwagi tej rundy. Na bramce `merge` przy konflikcie możesz go rozwiązać
sam w czystym klonie i wznowić flow.

Pętla review może zatrzymać flow także przy wyłączonej bramce (`review.on_stop: human`).

## Weryfikacja: checks, baseline, bramka „czerwone”

Agent nie decyduje, czy kod działa. Rozstrzygają to komendy z configu repo:

- **`review.checks`** to build, testy i lint uruchamiane przez `sh -c` w klonie grupy, w kontenerze albo na hoście.
  Są wymagane do startu flow. `none` oznacza świadomie brak weryfikacji: grupy są wtedy oznaczone na bramkach jako
  „niezweryfikowane”.
- **Baseline:** przed startem grupy checks idą na czystej bazie. Jeśli coś jest czerwone już tam, decydujesz: przyjąć
  to jako **znane czerwone** (nie liczy się do weryfikacji nigdzie w flow — w grupach ani w finalnym review i jego merge’ach — więc kolejne grupy już o nie nie
  pytają) albo naprawić bazę i wznowić flow.
- **Bramka „czerwone”:** testy z write-tests muszą się kompilować (`review.compile`) i nie przechodzić na kodzie
  bazowym. Test zielony bez implementacji wraca do autora testów.
- **Testy z write-tests są zamrożone:** implementer ich nie zmienia (orkiestrator sprawdza diff). Uważa test za
  błędny → zgłasza `test_issue`. Własne testy może dopisywać.
- `review.test_reports` (JUnit XML) pozwala sprawdzać pojedyncze testy zamiast tylko kodów wyjścia komend.

## Review i pętla z zabezpieczeniami

Review działa w **osiach**, każda w osobnej sesji, zwykle na innym modelu niż implementacja:
`spec` (czy kod realizuje ticket i spec), `standards` (konwencje, jakość, testy dopisane przez implementera)
i opcjonalnie `security`. Każda oś raportuje też, co sprawdziła, nawet gdy nic nie znalazła.

Uwaga **blocking** musi mieć podstawę, inaczej spada do **nit**:

- `basis: spec`: ID kryterium albo punktu specu,
- `basis: standard`: ID reguły (np. `ARCH-01`, `AG-TQ-04`),
- `basis: defect`: konkretny scenariusz „wejście → zły wynik” i `plik:linia`.

Orkiestrator sprawdza uwagi mechanicznie, bez tokenów: czy podstawa istnieje (ID AC albo reguły) i czy cytowany
kod stoi pod wskazanym `plik:linia`. Uwaga bez istniejącej podstawy spada do nit, z cytatem nie na miejscu odpada
przed fixerem. Od rundy 2 zakres jest zamrożony do tego, co naprawiono, czego nie naprawiono
i regresji w nowym diffie. Fixer może uwagę **zakwestionować** (`disputed`). Taka uwaga trafia do człowieka i nie
wraca w pętli.

Pętla kończy się, gdy wszystkie osie są pokryte i nie ma potwierdzonych blocking. Zatrzymują ją wyzwalacze
`review.stop_on` (np. `max_rounds`, `repeated_finding`, `no_progress`), a reakcję wybiera `review.on_stop`:
`escalate` (fixer na mocniejszym modelu z `review.escalation`), `human` albo `fail`.

## Sandbox

Sesje agentów bez człowieka działają w **sandboxie**. Domyślnie (`sandbox.mode: container`) każda sesja startuje
w jednorazowym kontenerze (Podman albo Docker), w którym ma:

- klon grupy i własny katalog `out/` na wyniki,
- artefakty flow tylko do odczytu,
- sieć wyłącznie przez proxy do hostów z `sandbox.network.allow`.

Agent nigdy nie pushuje: w sandboxie nie ma remote, poświadczeń gita ani otwartej sieci. Przy `sandbox.mode: none`
granicą jest tylko sandbox samego harnessu, a `review.checks` na hoście wymagają Twojej zgody per repo
(`~/.agentic/trusted-checks.yaml`).

## Config: warstwy i profile

Config ma cztery warstwy. Niższa nadpisuje wyższą:

```
globalna ~/.agentic/config.yaml (+ aktywny profil) → workspace zespołu → repo .agentic/config.yaml → flow
```

Obiekty łączą się rekurencyjnie, tablice są zastępowane w całości. **Profil** (np. `work`, `private`) wybierany jest
po remote albo ścieżce repo. Ustawia rozliczenie (`billing: api | subscription`), budżet, forge dla `publish`
i reakcję na rate limit. Wynik scalenia: `agentic config show`. Wszystkie pola: [reference/config.md](../reference/config.md).

## Skille i reguły

- **Skill etapu** (`agentic-implement`, `agentic-review-standards`…) to kontrakt sesji: wejścia, wyjścia i format,
  który parsuje orkiestrator. Zostaje zawsze, podmienia go tylko `stages.<etap>.stage_skill`.
- **Skille praktyk** niosą reguły z ID, które agenci stosują, a review cytuje. Reguły frameworka mają prefiks
  `AG-` (np. `AG-CODE-nn`, `AG-TQ-nn`), standardy zespołu (`.agentic/standards/*.md`) własne prefiksy.
- **Flow bierze skille wyłącznie z configu zespołu i repo** (`stages.<etap>.skills`). Twój osobisty wybór
  (`agentic skills install`) dotyczy tylko Twoich własnych sesji Claude Code i Codex. To samo zadanie ma dawać ten sam
  proces u każdego, a review ocenia kod według tych samych standardów, których używał implementer.
- Wyłączanie: `skills.disabled` (skill znika ze wszystkich etapów), `rules.disabled` (jedna reguła),
  `_Checked by:_` przy regule (sprawdza ją narzędzie z `review.checks`, a nie recenzent).

## Budżet i zużycie

Każda sesja zapisuje tokeny (i koszt, gdy profil ma `pricing`) do `usage.jsonl`. **Budżet flow** (`budget`: minuty,
tokeny, USD) jest sprawdzany przed każdą sesją. Minuty to suma czasu sesji bez człowieka. Grill i czekanie na bramce
się nie liczą. Po przekroczeniu decydujesz: kontynuować (każdy limit +50%) albo wstrzymać. `session_timeout`
(domyślnie 45 min) przerywa pojedynczą zawieszoną sesję. Rozkład kosztu: `agentic usage <slug>`.

## Publish i sprzątanie

**Gałąź docelowa** PR-a (`--base` przy `new`/`pick`, domyślnie domyślna gałąź origin) jest wybierana przy starcie
flow: grupy zaczynają od jej stanu na origin, a nie od Twojego lokalnego HEAD. Testy, baseline i review od początku
dotyczą kodu, do którego PR trafi.

`agentic publish` uruchamia wyłącznie człowiek:

0. gdy cel przesunął się od startu flow: rebase pracy na jego nowy stan i `review.checks` (konflikt albo czerwone
   checks zatrzymują publish przed pushem),
1. skan sekretów (gitleaks) w commitach flow,
2. push gałęzi nazwanych według `git.branch_pattern` (`{type}`, `{ticket}`, `{title}`, `{slug}`, `{group}`). Przy
   `publish.stack` łańcuch grup wychodzi jako **stack PR-ów**: PR per grupa, każdy na gałęzi poprzedniego, najniższy
   gotowy do review, reszta jako draft. `{group}` to tytuł grupy; wzorzec bez niego dostaje `-1`, `-2`, ….
   `--single`, `publish.stack: false`, jedna grupa, brak zatwierdzonego planu, plan, który nie jest łańcuchem, albo
   tylko jedna grupa z własnymi commitami dają jeden PR z całego flow
   (`{group}` = tytuł ticketu), a plan mówi dlaczego,
3. PR/MR przez **forge** z profilu (`github`, `gitlab`; `none` wypisuje tylko link). Opis PR zawiera podsumowanie,
   ryzyka, otwarte nity, sekcję **Merge danger** (zmiana jednokierunkowa według `publish.one_way_paths`) i rozmiar
   (linie produkcyjne / testy / pominięte, ostrzeżenie ponad `publish.size`),
4. sprzątanie: gałęzie robocze `agentic/<slug>/*`, ukryte refy rollbacku i katalogi robocze.

**Artefakty do audytu zostają** (ticket, spec, tasks, raporty review, `usage.jsonl`, `events.jsonl`). Gałęzi
z commitami, których nie ma nigdzie indziej (inna gałąź, tag, remote), framework nie usuwa bez Twojego potwierdzenia.
Ta sama zasada obowiązuje w `agentic clean` dla flow przerwanych i porzuconych.

## Fake harness

`--fake` przy `new`, `pick` i `resume` zastępuje agentów skryptem: flow przechodzi wszystkie etapy bez tokenów.
Służy do prób configu, bramek i checks na prawdziwym repo, zanim zapłacisz za prawdziwe sesje.
