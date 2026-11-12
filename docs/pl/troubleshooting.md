[English](../en/troubleshooting.md) | Polski

# Rozwiązywanie problemów

Zacznij od dwóch poleceń:

```bash
agentic doctor            # środowisko: config, harnessy, silnik, obraz, poświadczenia, checks; przy problemie podaje poprawkę
agentic status <slug>     # gdzie stoi flow i dlaczego (powód pauzy, grupa, komunikat)
```

Logi flow są w jego katalogu (`~/.agentic/work/<repo>-<hash>/<slug>/`): `events.jsonl` (co się działo),
`checks/` (pełny output komend `review.checks`), `out/<sesja>.egress.log` (odmowy proxy w kontenerze).

## Flow wstrzymany

`agentic status <slug>` pokazuje powód pauzy. Po poprawce: `agentic resume <slug>`.

| Powód | Co się stało | Co zrobić |
|---|---|---|
| `baseline` | `review.checks` czerwone już na kodzie bazowym, zanim agent cokolwiek zmienił | Napraw bazę (albo poczekaj na poprawkę na main) i wznów: grupa zacznie od nowej bazy. Na pytaniu możesz też wybrać „kontynuuj”: czerwone komendy staną się znanymi czerwonymi i nie będą weryfikować żadnej grupy flow (kolejne grupy już o nie nie pytają). |
| `red_gate` | Testy z write-tests się nie kompilują albo przechodzą bez implementacji, mimo wznowień autora testów | Sprawdź log z komunikatu. Test zielony na bazie zwykle znaczy, że zachowanie już istnieje albo test nic nie sprawdza: popraw AC lub seams w specu. Brak kompilacji: sprawdź `review.compile`. |
| `checks_failing` | Po sesji (task, fix) checks dalej czerwone, mimo wznowień z outputem | Przeczytaj log w `checks/`. Częste przyczyny: test zależny od środowiska (sieć, port, strefa czasowa), brak hosta w `sandbox.network.allow`, zbyt krótki `review.checks_timeout`. Limit wznowień ustawia `review.stop_on: [{checks_failing: N}]`. |
| `test_issue` | Implementer uważa test z write-tests za błędny, a autor testów go podtrzymał albo poprawiał już kilka razy | Rozstrzygnij sam: popraw test na gałęzi albo zostaw go. Przy „kontynuuj” na pytaniu implementer musi spełnić test w obecnej postaci. |
| `spec_issue` | Agent uznał spec za błędny lub niewykonalny i nie improwizował | Popraw `spec.md` w katalogu flow i wznów. Przy uwadze z review cała runda przejdzie jeszcze raz. |
| `human` | Ktoś wybrał „zapisz i wstrzymaj”, wyszedł z grilla albo flow czeka na rozwiązanie konfliktu merge | Wznów. Przy konflikcie: zacommituj merge w klonie wskazanym w komunikacie, potem wznów. |
| `budget` | Przekroczony `budget` (minuty, tokeny albo USD) i wybrałeś „wstrzymaj” | `resume` zapyta znowu: kontynuacja podnosi każdy limit o 50%. Gdzie poszły pieniądze: `agentic usage <slug>`. |
| `timeout` | Sesja przekroczyła `session_timeout` (domyślnie 45 min) i została ubita | Wznów: sesja wróci ze swoimi niezacommitowanymi zmianami. Gdy powtarza się na tym samym tasku, task jest za duży (podziel go na bramce breakdown) albo agent się zapętla: sprawdź transkrypt w `transcripts/`. |
| `rate_limit` | Limit subskrypcji harnessu | Wznów po resecie limitu. Czekanie bez pauzy: `on_rate_limit: wait` w profilu (najwyżej 5 h). |
| `error` | Chwilowy błąd API lub sieci (3 ponowienia nie pomogły), harness zakończył się błędem albo checks czekają na zgodę na hoście | Przeczytaj komunikat. Chwilowe błędy zwykle mijają po wznowieniu. Brak zgody na checks: `resume` o nią zapyta. |

Flow `failed` (`review_failed`) skończył pętlę review z `on_stop: fail` i nie da się go wznowić. Po przejrzeniu
raportów `review-*.json` zacznij nowy flow albo dokończ pracę ręcznie na gałęzi `agentic/<slug>/<grupa>`.
Gałęzie i klony zostają, dopóki nie wybierzesz sprzątania.

## Start flow

**`The flow is already running (pid N).`** (flow już działa): inny proces `agentic` trzyma blokadę tego flow. Jeśli żaden nie działa
(np. po twardym restarcie maszyny), usuń plik blokady podany w komunikacie.

**Brak `review.checks`**: flow nie startuje bez weryfikacji. `agentic init` zaproponuje komendy wykrytego builda.
Świadomie bez weryfikacji: `review.checks: none` (grupy będą oznaczone jako niezweryfikowane).

**Reguła z prefiksem `AG-` w standardach repo** zatrzymuje start: prefiks jest zarezerwowany dla reguł frameworka.
Nadaj regule własne ID (np. `CODE-01`).

**`pick` uruchomił grill biznesowy, a ticket był gotowy**: od grilla technicznego zaczyna tylko ticket
ze `status: ready` we frontmatterze i kryteriami `AC-n`. Szablon: `.agentic/templates/` po `agentic init`.

## Sandbox (kontener)

| Objaw | Co zrobić |
|---|---|
| `doctor`: silnik niedostępny | Podman: `agentic setup` albo `podman machine start`. Docker: uruchom Docker Desktop. Bez kontenera: `sandbox: { mode: none }` w configu globalnym. |
| `doctor`: brak obrazu albo obraz z innej wersji frameworka | `agentic sandbox build` (także po każdej aktualizacji frameworka). |
| `doctor`: harness w kontenerze się nie zaloguje | Claude: `claude setup-token` i `CLAUDE_CODE_OAUTH_TOKEN`, albo `ANTHROPIC_API_KEY`. Codex: `CODEX_API_KEY`. Zmienne ustaw w profilu powłoki, z której uruchamiasz `agentic`. |
| Claude albo Codex w kontenerze nie łączy się z firmowym gatewayem | `doctor` pokazuje gateway i źródło (`~/.claude/settings.json` albo powłoka; dla Codexa provider z `~/.codex/config.toml`, a jego `env_key` musi być wyeksportowany w powłoce). Gateway musi być pod `https://` na porcie 443 (proxy sesji nie przepuszcza innych). Odmowy proxy są w `out/<sesja>.egress.log`. Do allowlisty nie trzeba go dopisywać ręcznie. |
| Build w kontenerze nie pobiera zależności, sesja „nie ma sieci” | Sprawdź `out/<sesja>.egress.log`: każda odmowa proxy ma tam host. Dopisz go do `sandbox.network.allow`. Repozytoria Maven, Gradle i npm warstwa stacku dokłada sama. |
| Testcontainers albo `docker compose` w testach nie działają | W trybie `container`: `sandbox.containers: true` (config globalny albo workspace z listy `workspaces`). Izolacja jest wtedy słabsza. W trybie `none` testy idą na hoście: uruchom Docker albo Podmana. `doctor` i `init` wykrywają Testcontainers i `docker compose` w plikach builda (zależność pod inną nazwą, np. firmowej biblioteki, umknie). |
| Playwright nie ma przeglądarki | Dodaj `npx playwright install chromium` przed e2e w `review.checks`. |
| Build JVM pada z braku pamięci, maszyna wirtualna zwalnia | Maszyna silnika potrzebuje ok. 4 GB RAM na build JVM z bazą w compose. Na 8 GB nie uruchamiaj naraz Podmana i Docker Desktop. `doctor` podpowie zmianę rozmiaru maszyny. |
| `doctor`: pozostałości po crashu | `agentic sandbox clean` usuwa kontenery i sieci po procesach, które już nie działają. |
| Kończy się miejsce na dysku | `agentic clean` (katalogi robocze starych flow), `agentic sandbox clean --caches` (cache zależności; następny build pobierze je od nowa), stare obrazy silnika (`podman image prune` / `docker image prune`). |

Bez kontenera (`sandbox.mode: none`) pierwszy flow w repo pyta o zgodę na uruchamianie `review.checks` na hoście:
to kod, który agent mógł zmienić. Zgoda jest zapisana per repo w `~/.agentic/trusted-checks.yaml` i wygasa, gdy
zmieni się lista komend.

## Publish

| Objaw | Co zrobić |
|---|---|
| gitleaks znalazł sekrety | Usuń je z historii gałęzi `agentic/<slug>/_final` albo dopisz fałszywe alarmy do `.gitleaksignore` w repo, potem uruchom `publish` ponownie. |
| `doctor`: brak gitleaks | `brew install gitleaks`. Bez niego `publish` nie wypchnie gałęzi. |
| `doctor`: forge bez tokena albo nieznany host | `profiles.<nazwa>.forge` w configu globalnym: `{ type: github, auth: { from: gh } }` (token z `gh auth token`) albo `{ type: gitlab, auth: { env: GITLAB_TOKEN } }`. Własna instancja bez `origin`: `forge.url`. |
| „origin/… przesunął się, a praca flow ma z nim konflikt” | Ktoś zmienił te same linie w gałęzi docelowej. Przenieś pracę sam komendą z komunikatu (rebase gałęzi `agentic/<slug>/_final` na `origin/<cel>`), puść checks, potem `publish` ponownie: gałąź zawiera już cel, więc pójdzie bez rebase. |
| „checks czerwone po rebase na origin/…” | Praca flow jest zielona, ale nie razem z nowymi commitami celu. Logi są w komunikacie. Popraw na gałęzi `agentic/<slug>/_final` po rebase (jak przy konflikcie) albo opublikuj na inny cel (`--base`). |
| „checks czerwone na <gałąź> po przeniesieniu na …” (`restack`) | Kod PR-a jest zielony na starej bazie, a na nowej nie. Logi są w komunikacie. Wypchnij poprawkę na gałąź PR-a i uruchom `agentic restack <slug>` ponownie: Twój commit pojedzie dalej. |
| „… zamknięty bez merge'a” / „… ktoś przepisał jej historię” (`restack`) | `restack` przebudowuje tylko otwarte PR-y na gałęziach, które wciąż mają to, co wypchnął. Otwórz PR ponownie albo przywróć gałąź (`git push --force-with-lease` opublikowanego heada) i uruchom go jeszcze raz. |
| `publish` po `restack`: „stack przebudował `agentic restack`” | Od pierwszego restacku stack aktualizuje `restack`. |
| „HEAD ma N commitów, których nie ma na origin/…” przy starcie | Flow startuje od celu na origin, nie od lokalnego HEAD. Te commity nie wejdą do PR. Chcesz na nich budować: wypchnij je i podaj ich gałąź jako `--base`. |
| „Brak flow gotowych do publikacji” | Publikuje się tylko flow ze statusem `done`. `agentic status` pokazuje, gdzie stoją pozostałe. |
| `publish` zostawił gałąź z ostrzeżeniem | Jej commitów nie ma nigdzie poza nią (np. grupa z innego repo, której `publish` jeszcze nie wypycha). Zdecyduj sam, potem `agentic clean <slug>`. |

## Sprzątanie

**`No terminal to ask in; use --dry-run or --yes.`** (brak terminala do pytań): `agentic clean` bez terminala (np. w skrypcie) musi
dostać jedną z tych flag. `--yes` nie usuwa gałęzi z jedyną kopią pracy.

**Wstrzymanego flow nie ma na liście `agentic clean`**: bez sluga `clean` tylko go wymienia, bo sprzątnięcie kończy
flow na stałe. Świadomie: `agentic clean <slug>`.

**Gałęzie `agentic/<x>/*` bez flow** (katalog flow usunięty ręcznie): `agentic clean` bez sluga pokazuje je jako
osierocone i usuwa razem z ukrytymi refami.
