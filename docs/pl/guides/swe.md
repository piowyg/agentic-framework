[English](../../en/guides/swe.md) | Polski

# Przewodnik SWE

Od instalacji do PR-a na prawdziwym repo. Pojęcia (flow, grupa, bramka, oś review) wyjaśnia
[concepts.md](../concepts.md), a co robić, gdy coś stanie: [troubleshooting.md](../troubleshooting.md).

## 1. Raz na maszynę

```bash
npm install && npm run build && npm link   # w katalogu frameworka: komenda `agentic` w PATH
agentic setup                              # Podman (brew + maszyna na macOS) i aplikacja do dyktowania, za Twoją zgodą
agentic sandbox build                      # obraz sesji: agentic/base + warstwa stacku repo, w którym to uruchomisz
```

`npm link` wskazuje na `dist/` tego katalogu: po `git pull` albo zmianie gałęzi zrób `npm run build`, inaczej flow
pójdzie na starszym kodzie (`agentic doctor` i start flow o tym ostrzegą). Pracujesz nad frameworkiem w tym samym
katalogu? Zmiany rób w osobnym `git worktree`, żeby gałąź w toku nie zmieniła komendy, na której idzie flow.

Poświadczenia dla sesji w kontenerze (keychain hosta jest poza jego zasięgiem). Ustaw je w profilu powłoki:

- Claude z subskrypcją: `claude setup-token`, potem `export CLAUDE_CODE_OAUTH_TOKEN=…`; z rozliczeniem za tokeny:
  `ANTHROPIC_API_KEY`,
- Codex: `CODEX_API_KEY` (logowanie ChatGPT z `~/.codex` nie trafia do kontenera).

Config globalny `~/.agentic/config.yaml`: profile według remote albo ścieżki repo, budżet i forge dla `publish`:

```yaml
profiles:
  private:
    match: { path: "~/Projects/**" }
    billing: subscription
    budget: { tokens: 2000000, minutes: 45 }
    forge: { type: github, auth: { from: gh } }   # token z `gh auth token`; GitLab: auth: { env: GITLAB_TOKEN }
default_profile: private
```

`agentic doctor` sprawdza wszystko naraz: config, profil, CLI harnessów, silnik i obraz, poświadczenia w kontenerze,
git, gitleaks, token forge'a, `review.checks` repo. Niczego nie zmienia, a przy każdym problemie podaje poprawkę.

## 2. Raz na repo

```bash
cd ~/Projects/moj-serwis
agentic init        # wykrywa build (Gradle, Maven, npm), proponuje review.checks, compile i test_reports; zapisuje po „tak”
agentic doctor      # checks repo, obraz stacku (repo JVM: agentic sandbox build dobuduje agentic/jvm)
```

Przejrzyj `.agentic/config.yaml`. **`review.checks` to jedyne, czemu flow wierzy**: agent nie decyduje, czy kod
działa. Dobre checks są szybkie i deterministyczne: build, testy jednostkowe, lint. Wolne e2e lepiej zostawić CI.

```yaml
review:
  checks: ["./gradlew build"]
  compile: "./gradlew testClasses"                        # bramka „czerwone” bez uruchamiania całego builda
  test_reports: "**/build/test-results/test/*.xml"        # wynik per test zamiast samego kodu wyjścia
```

Na koniec `init` (także uruchomiony ponownie, wtedy niczego nie zapisuje) i `doctor` pokazują, co repo ma dla agentów:
config, szablon ticketu, mapę kontekstu (`.agentic/context-map.md`, skill `/agentic-context-map`), `AGENTS.md` /
`CLAUDE.md` i standardy. Brak czegoś to tylko podpowiedź: flow działa, agenci wiedzą mniej. Do istniejącego `AGENTS.md` (albo `CLAUDE.md`)
`init` dopisuje raz sekcję `## Agentic` ze ścieżkami `.agentic/`, żeby zwykła sesja Claude Code czy Codexa też je znalazła.

Standardy zespołu w `.agentic/standards/*.md` (reguły z własnymi ID, np. `ARCH-01`) trafiają do implementera
i recenzenta osi `standards`. `init` proponuje trzy: `architecture.md`, `testing.md`, `code.md`; własne nazwy plików
też działają. Commituj config i standardy do repo: ustawienia flow są zespołowe.

Przed pierwszym prawdziwym flow zrób próbę bez tokenów:

```bash
agentic new "Próba" --fake     # wszystkie etapy, bramki i checks na Twoim repo, agenci ze skryptu
agentic clean proba            # sprzątnięcie po próbie (slug bez polskich znaków)
```

## 3. Flow

### Start

```bash
agentic new "Darmowa dostawa od 200 zł"                   # własny pomysł: od grilla biznesowego
agentic new                                               # dłuższy opis: wklejasz, koniec linią z samą kropką `.`
agentic pick ticket.md                                    # gotowy ticket z AC: od grilla technicznego; inny tekst: propozycja grilla biznesowego
agentic pick                                              # wklejony ticket (np. z Jiry), koniec linią `.`
```

Uruchamiaj w repo, którego dotyczy zmiana: flow przypisuje się do repo, w którym go zacząłeś. Flow zaczyna od stanu
gałęzi docelowej na origin (domyślna gałąź origin albo `--base develop`), nie od Twojego lokalnego HEAD. Lokalne
niewypchnięte commity nie wejdą do PR, a CLI o nich ostrzeże.

### Grille

Grill to rozmowa z agentem w terminalu. Biznesowy ustala zachowanie i kryteria `AC-n`, techniczny ustala, jak to
zrobić: agent najpierw czyta kod, potem pyta tylko o decyzje. Najważniejsze z nich to **Test seams**, czyli publiczne
interfejsy, na których powstaną testy. Złe seams dadzą testy przyklejone do implementacji.

- Odpowiadaj głosem: [dyktowanie](dictation.md) jest kilka razy szybsze niż pisanie.
- Sesję kończysz, gdy agent zapisze artefakt jako gotowy, a Ty z niej wyjdziesz. Wyjście wcześniej wstrzymuje flow,
  a `agentic resume` wraca do rozmowy.
- Język rozmowy to `language.conversation` (osobisty), język artefaktów `language.artifacts` (zespołowy).

### Bramki

Na bramce widzisz podsumowanie artefaktu albo planu i wybierasz akcję. Warto zatrzymać się na:

- **spec:** czy seams i kontrakty są tymi, których chcesz. Poprawka tutaj jest najtańsza.
- **breakdown:** czy grupy są pionowymi kawałkami (jedna grupa = jeden PR do przejrzenia) i czy klasy trudności
  nie są zawyżone. Klasa wybiera model, a model koszt. Każda grupa pokazuje szacunek (`~120 prod / 200 w testach`);
  grupa ponad progiem `publish.size` ma ⚠ z uzasadnieniem od breakdownu.
- **final:** pełny diff po finalnym review, przed publish.

„Popraw z notatką” daje agentowi Twoją uwagę i powtarza etap. „Zapisz i wstrzymaj” zostawia wszystko na później.

### Implementacja i review

Od breakdownu flow idzie bez Ciebie aż do następnej aktywnej bramki. Możesz zamknąć terminal: flow się zatrzyma,
a `agentic resume` podejmie go od ostatniego zapisanego kroku.

```bash
agentic status                  # flow tego repo i innych
agentic status <slug>           # etapy, grupy (rozmiar, ⚠ ponad szacunek), rundy review, pauza z powodem, zużycie
agentic usage <slug>            # koszt: etap → grupa → task / runda review / fix
```

Na bramce pętli review (`final`, przy `strict` też `group`) widzisz uwagi potwierdzone, odrzucone i zakwestionowane
przez fixera. Masz do wyboru:

- **kontynuuj:** akceptujesz stan,
- **popraw z notatką:** kolejna runda fixa z Twoją wskazówką,
- **cofnij do rundy review:** gdy fixer poszedł w złą stronę.

### Pauzy

Flow staje sam, gdy potrzebuje decyzji: czerwona baza, `spec_issue`, `test_issue`, przekroczony budżet, rate limit,
timeout sesji. `agentic status <slug>` mówi dlaczego, a [troubleshooting.md](../troubleshooting.md) podpowiada, co
zrobić. Potem `agentic resume <slug>`.

## 4. Publish

```bash
git log --oneline agentic/<slug>/_final   # albo diff na bramce final: to idzie do PR
agentic publish <slug>                    # gitleaks → push → PR/MR → sprzątanie
agentic publish <slug> --base develop     # inna gałąź docelowa niż wybrana przy starcie
agentic publish <slug> --single           # jeden PR z całego flow, jak przy publish.stack: false
```

Jeśli gałąź docelowa przesunęła się od startu flow, `publish` najpierw przenosi pracę na jej nowy stan (rebase
w czystym klonie) i puszcza `review.checks`. Konflikt albo czerwone checks zatrzymują go przed pushem,
a co wtedy zrobić, opisuje [troubleshooting.md](../troubleshooting.md).

PR dostaje label `agentic`, opis w `language.pr` (podsumowanie, ryzyka, otwarte nity, przyjęte i odłożone uwagi) oraz
sekcję **Merge danger**. Zmiana w ścieżkach z `publish.one_way_paths` (migracje, kontrakty) jest oznaczona jako
jednokierunkowa. Plan i opis pokazują rozmiar zmiany: linie produkcyjne / testy / pominięte (dodane + usunięte;
lockfile'i, pliki generowane i oznaczone `linguist-generated` w `.gitattributes` są pominięte, dokumentacja liczy się
jako produkcyjna). Ponad miękkimi progami `publish.size` (domyślnie 400 linii produkcyjnych, 800 razem z testami)
dostajesz ostrzeżenie, nic się nie zatrzymuje. Ticket z issue tego repo (`tracker_key: "#5"` albo tytuł kończący
się na `(#5)`) dostaje w opisie `Closes #5`, więc merge zamyka issue. Bez `forge` w profilu `publish` tylko pushuje
i podaje link do założenia PR-a. Ponowny `publish` aktualizuje ten sam PR.

Przy `publish.stack` (domyślnie włączone) i planie, którego grupy tworzą łańcuch, `publish` otwiera **stack**: PR per
grupa, każdy na gałęzi poprzedniego, wszystkie naraz. Najniższy jest gotowy do review, reszta to drafty. Każdy opis
ma listę PR-ów stacku w kolejności merge'a (`PR 2/3`, linki) oraz cel grupy, jej własny rozmiar, Merge danger i nity (grupa bez własnych commitów nie dostaje PR-a; jej nity idą do PR-a
wyżej), a gdy grupa przerosła szacunek z planu, także ten szacunek.
Podsumowanie i ryzyka ze specu są tylko w pierwszym PR, a issue zamyka dopiero ostatni. Poprawki finalnego review
trafiają do PR-a, którego linie dotyczą: przed publishem, na końcu finalnego review, `git blame` przypisuje każdy hunk
jego grupie, która dostaje go jako commit oznaczony `(final review)`, a stack jest przebudowany (konflikt idzie do
sesji `merge` i bramki `merge`, jak w `restack`). Linie kilku grup albo sprzed feature'a, nowe pliki i poprawki grupy,
przez które `review.checks` robią się czerwone (na jej PR-ze albo wyżej), zostają w ostatnim PR; opis PR-a mówi, gdzie trafiły. Przesunięty cel przenosi cały stack, a `review.checks` biegną na szczycie każdego PR-a, od najniższego. Ponowny
`publish` aktualizuje każdą gałąź (`--force-with-lease`) i te same PR-y; draft, który właśnie został najniższy, przechodzi w gotowy do review, a najniższy, z którego sam zrobiłeś draft, nim zostaje. Gałąź, która już jest na `origin`, a nie wypchnął jej ten flow, zatrzymuje `publish` przed
planem. `--single` daje jeden PR zamiast stacku. Po udanym pushu framework sprząta gałęzie
robocze i katalogi robocze, a artefakty do audytu zostają w katalogu flow.

Po merge'u PR-a ze stacku (także squash) albo po Twoich commitach w niższym PR uruchom `agentic restack <slug>`.
Czyta stan PR-ów z forge'a i przebudowuje otwarte od najniższego przez `rebase --onto`: na cel, gdy PR pod nim się
zmergował, a w przeciwnym razie na niższą gałąź z Twoimi commitami. Twoje commity na gałęzi PR-a jadą dalej. Na każdej
przebudowanej gałęzi biegną `review.checks` (bez ponownego review). Konflikt trafia do sesji `merge`; bramka `merge`
pokazuje, jak zmienił się każdy commit (`git range-diff`), a „rozwiążę sam” zostawia zatrzymany rebase w klonie dla
Ciebie. Po potwierdzeniu: jeden `push --force-with-lease` (na to, co miał `origin`), nowy najniższy PR na cel i
z draftu, a listy w opisach oznaczają zmergowane PR-y. Przerwanie (bramka, własne rozwiązanie) zachowuje postęp:
ponowny `restack` kontynuuje. PR zamknięty bez merge'a albo gałąź z przepisaną historią zatrzymują go, zanim cokolwiek
zostanie wypchnięte. Od pierwszego restacku stack aktualizuje `restack`, nie `publish`.

Review PR-a robi człowiek, tak jak każdego innego. Agent nigdy nie pushuje sam.

## 5. Sprzątanie

Flow przerwany albo `failed` pyta na koniec, czy posprzątać. Resztę załatwia `agentic clean`:

```bash
agentic clean --dry-run    # co zostało po zakończonych flow tego repo i ile zajmuje
agentic clean              # pyta przy każdym flow
agentic clean <slug>       # jeden flow, także wstrzymany (wtedy się kończy i nie da się go wznowić)
```

Gałąź z commitami, których nie ma nigdzie indziej, znika tylko po wybraniu „razem z nimi”. `--yes` nigdy jej nie usuwa.

## 6. Skille: flow kontra Twoje sesje

**Flow używa skilli z configu zespołu i repo (`stages.<etap>.skills`), nie z Twojego osobistego wyboru.**
`agentic skills install` linkuje skille praktyk frameworka do `~/.claude/skills` i `~/.agents/skills`, ale tylko na
potrzeby Twoich własnych sesji Claude Code i Codex. Odinstalowanie skilla u siebie nie wyłącza go we flow,
a zainstalowanie nie dodaje go do flow.

Powód: to samo zadanie ma dawać ten sam proces u każdego w zespole, a review ocenia kod według tych samych
standardów, których używał implementer. Chcesz zmienić skille albo reguły flow: zmień `.agentic/config.yaml` repo
(albo config workspace zespołu) przez MR. Wyłączanie skilli i pojedynczych reguł opisuje
[config.md](config.md#reguły-frameworka-i-jak-je-wyłączyć).

## 7. Koszt i tempo

- **Klasy trudności:** `tiers` mapuje `mechanical | standard | domain | design` na executora. Tani model do
  `mechanical` i `standard` robi największą różnicę, bo tasków jest najwięcej.
- **Budżet** w profilu (`budget: { usd | tokens | minutes }`) zatrzymuje flow z pytaniem, zanim przepali więcej, niż
  zakładasz. `review.max_rounds` ogranicza rundy review.
- **Równoległość:** `parallel_groups: 2` puszcza niezależne grupy naraz: grupy różnych repo albo jednego repo
  przy `publish.stack: false`. Na maszynie z 8 GB RAM i buildem JVM w kontenerze zostań przy 1.
- `agentic usage <slug> --by model` pokazuje, który model kosztował najwięcej.
