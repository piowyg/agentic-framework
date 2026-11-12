[English](../en/security.md) | Polski

# Bezpieczeństwo

Dokument dla osób, które oceniają, czy agentic może działać w organizacji. Opisuje, co chronimy, gdzie są granice
zaufania, co agent może zrobić sam i jakie ryzyka przyjmujemy świadomie.

## Co chronimy

- **Kod i historię repo** użytkownika: agent pracuje na klonie, nigdy na repo użytkownika.
- **Poświadczenia na maszynie użytkownika:** klucze SSH, chmury, tokeny gita i forge'a, keychain.
- **Remote i CI:** nic nie trafia na forge bez człowieka.
- **Maszynę użytkownika:** sesja agenta nie wykonuje komend na hoście poza kontenerem (w trybie domyślnym).

## Kto jest zaufany, a kto nie

| Element | Zaufany? | Dlaczego |
|---|---|---|
| Orkiestrator (`agentic`, CLI w TypeScript) | tak | deterministyczny kod, bez modelu; trzyma stan, buduje komendy, scala wyniki |
| Człowiek przy bramkach i `publish` | tak | zatwierdza ticket, spec, plan i każdy push |
| Sesja agenta (Claude Code, Codex) | **nie** | robi to, co każe model; model czyta treści, których nie kontrolujemy |
| Ticket, spec, kod repo, sklonowane zależności | **nie** | mogą zawierać instrukcje dla modelu (prompt injection) |
| Wynik sesji (commity, raporty, `out/`) | **nie** | orkiestrator go weryfikuje, zanim go użyje |

Zasada: każdą sesję agenta traktujemy jak kod, który może być wrogi. Granicą jest kontener i orkiestrator, nie
posłuszeństwo modelu.

## Co agent może, a czego nie

Agent w sesji bez człowieka **może**: czytać i zmieniać klon swojej grupy, commitować w nim, uruchamiać build i testy,
łączyć się z hostami z allowlisty, pisać do własnego katalogu `out/`.

Agent **nie może**:

- **pushować** — z trzech niezależnych powodów: remote klonu wskazuje na ścieżkę hosta, której nie ma w kontenerze;
  w kontenerze nie ma poświadczeń gita; sieć wychodzi tylko do hostów z allowlisty;
- zmienić repo użytkownika — zmiany wychodzą jako `git bundle`, który orkiestrator weryfikuje i pobiera (`git fetch`);
- czytać domu użytkownika — w kontenerze nie ma `~/.ssh`, `~/.aws`, keychaina, socketu silnika kontenerów hosta;
- zobaczyć tokenów trackera i forge'a — używa ich tylko orkiestrator na hoście;
- zostawić czegoś następnej sesji — każda sesja ma świeży kontener i własny katalog sesji harnessa (bez `settings.json`
  z hookami, `CLAUDE.md`, skilli i pamięci z poprzednich sesji); recenzent nie czyta transkryptu implementera.

Push i PR robi wyłącznie człowiek przez `agentic publish`.

## Kontener sesji

Domyślnie (`sandbox.mode: container`) każda sesja startuje w jednorazowym kontenerze (Podman rootless albo Docker):

- `--cap-drop=ALL`, `no-new-privileges`; Podman z `--userns=keep-id`, Docker z `--user <uid>:<gid>`;
- mounty: klon grupy (zapis), własne `out/<sesja>/` (zapis), artefakty flow i zależności tylko do odczytu; repo
  użytkownika (sesje przed klonami: grille, breakdown) tylko do odczytu;
- credential harnessa przekazany po nazwie zmiennej (`--env NAME`), nigdy w linii komend;
- po sesji kontener, proxy i sieć są usuwane (`rm --force`); pozostałości po crashu sprząta `agentic sandbox clean`,
  `doctor` je wykrywa.

W kontenerze Claude Code działa z `--dangerously-skip-permissions`. To celowe: nikt nie odpowiada na pytania
o zgodę w sesji bez człowieka, a granicą jest kontener, nie uprawnienia harnessa.

Obraz: `agentic/base` (`sandbox/base/Dockerfile`) — Debian slim, git, Node, przypięte wersje Claude Code i Codex.
Warstwa stacku (np. JVM) dokłada JDK. Obraz ma etykietę z hashem plików, `doctor` wykrywa obraz z innej wersji.

## Sieć

Sesja dostaje własną sieć `--internal` (bez DNS i trasy na zewnątrz). Jedyny inny kontener w tej sieci to proxy
(`--read-only`, `--cap-drop=ALL`, user `nobody`), które:

- tuneluje tylko `CONNECT host:443` do hostów z `sandbox.network.allow` (`.domena` = subdomeny),
- odrzuca plain HTTP,
- zapisuje każdą decyzję do `out/<sesja>.egress.log`.

Domyślna allowlista: API dostawców modeli (`api.anthropic.com`, `api.openai.com`) i rejestry pakietów
(`repo.maven.apache.org`, `registry.npmjs.org`). Organizacja dopisuje swoje mirrory i usuwa to, czego nie używa.
Host firmowego gatewaya modeli (`ANTHROPIC_BASE_URL`, `base_url` providera Codexa, niżej) framework dopisuje do allowlisty sesji sam; musi być
dostępny przez HTTPS na porcie 443 (`doctor` ostrzega przy innym).

## Sekrety

- Do kontenera trafia tylko credential harnessa, i tylko gdy jest ustawiony: `ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN` albo `ANTHROPIC_AUTH_TOKEN` (Claude), `CODEX_API_KEY` / `OPENAI_API_KEY` (Codex).
- Firmowy gateway (LiteLLM albo inne proxy) dla Claude Code: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_CUSTOM_HEADERS` i `ANTHROPIC_DEFAULT_*_MODEL`. Brane z powłoki, a gdy ich tam nie ma, z `env`
  w `~/.claude/settings.json` (tylko te nazwy, reszta pliku nie trafia do kontenera). Wartości idą do silnika przez
  jego środowisko (`--env NAZWA`), nigdy w linii poleceń.
- Firmowy gateway dla Codexa: provider z `model_provider` i `[model_providers.<nazwa>]` w `~/.codex/config.toml`
  (albo `$CODEX_HOME`) trafia do kontenera jako `--config`, tylko pola opisujące połączenie (`base_url`, `env_key`,
  `wire_api`, `env_http_headers`, `query_params`, limity ponowień). `experimental_bearer_token` i `http_headers`
  zostają poza kontenerem, bo ich wartości trafiłyby do linii poleceń — token idzie przez zmienną z `env_key`
  (np. `LITELLM_API_KEY`), przekazywaną po nazwie. Reszta `config.toml` (serwery MCP, profile) nie trafia do kontenera.
- Globalne ustawienia harnessów (`~/.claude/settings.json` poza powyższymi zmiennymi, hooki, uprawnienia, polityki
  zarządzane organizacji, `~/.codex/config.toml` poza providerem) **nie działają w kontenerze**: kontener widzi tylko
  pusty katalog sesji. Granicą jest kontener, nie ustawienia harnessa.
- Tokeny trackera i forge'a (`JIRA_TOKEN`, `GITLAB_TOKEN`, `GITHUB_TOKEN`…) zostają na hoście.
- `agentic publish` uruchamia gitleaks na wszystkich commitach flow (`--redact`, `--ignore-gitleaks-allow`, bo te
  commity pisał agent). Brak gitleaks albo znalezisko zatrzymuje publish przed pushem.

## Publish

`agentic publish` działa tylko na hoście, uruchamia go człowiek. Kolejno: rebase na aktualny cel w świeżym klonie
i `review.checks` → gitleaks → plan do potwierdzenia → push → PR/MR. Opis PR zawiera „Merge danger”: zmiany
w ścieżkach jednokierunkowych (`publish.one_way_paths`: migracje, `.proto`, schematy) są wyróżnione do pełnego review.
PR/MR dostaje label `agentic`, więc zmiany agentowe da się odfiltrować i audytować.

Po publish zostają artefakty do audytu: ticket, spec, tasks, raporty review, `usage.jsonl` (tokeny, koszt),
`events.jsonl` (przebieg flow).

## Tryby o słabszej izolacji

**`sandbox.mode: none`** — sesje na hoście, bez kontenera. Granicą jest wtedy sandbox samego Claude Code:
`blockReadsOutsideWorkingDirectories`, sandbox systemowy z `failIfUnavailable`, zamknięty dom użytkownika poza listą
`sandbox.host.read` (domyślnie m.in. `~/.gitconfig`, `~/.m2`, `~/.gradle`, `~/.npm`), stale zablokowane ścieżki
wrażliwe (`~/.ssh`, `~/.aws`, `~/.netrc`, `~/.config/gh`, `~/.npmrc`, `~/.docker`, `~/.kube`…) i zmienne z tokenami.
`review.checks` na hoście wymagają zgody człowieka per repo (`~/.agentic/trusted-checks.yaml`).
Workspace spoza listy `workspaces` w configu globalnym nie może ustawić `sandbox` (repo nie wyłączy sobie kontenera).

**`sandbox.containers: true`** — dla testów z Testcontainers / `docker compose`. W trybie `container` build i testy
(`review.checks`, `run-checks`) działają w kontenerze sesji, więc bez tej opcji testy potrzebujące silnika
kontenerów nie przejdą. Z nią w sesji działa osobny, rootless Podman, a kontener sesji dostaje:

- dodatkowe capabilities z `CONTAINERS_CAPS` (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `KILL`, `SETFCAP`,
  `SETGID`, `SETUID`, `SYS_CHROOT`) oraz `/dev/fuse` i `/dev/net/tun`;
- `--security-opt=label=disable` i `unmask=ALL` (Podman) albo `systempaths=unconfined` (Docker);
- na Dockerze **bez `no-new-privileges`** — `newuidmap` wewnętrznego Podmana dostaje uprawnienia z file capabilities,
  które ta flaga blokuje (na Podmanie flaga zostaje);
- Docker Hub dopisany do allowlisty (`registry-1.docker.io`, `auth.docker.io` i dwa hosty CDN), żeby pobrać obrazy
  typu `postgres:16`; organizacja z własnym rejestrem powinna to zastąpić mirrorem.

Nadal bez `SYS_ADMIN`, `NET_ADMIN` i trybu privileged; socket silnika hosta nie jest widoczny. Opcję ustawia config
globalny albo workspace z listy `workspaces` (repo samo jej nie włączy). `doctor` ostrzega, gdy repo ma Testcontainers
albo `docker compose`, a opcja jest wyłączona, i podpowiada wyłączenie, gdy jest włączona bez takich testów.

W trybie `none` testy idą przez `run-checks` na hoście, z Dockerem hosta i Twoimi uprawnieniami (stąd zgoda
per repo); `sandbox.containers` nie ma tam znaczenia.

## Ryzyka przyjęte świadomie

| Ryzyko | Co je ogranicza |
|---|---|
| Agent może odczytać credential harnessa ze środowiska kontenera i zapisać go w commicie | gitleaks przy publish; człowiek widzi diff przed pushem |
| Prompt injection z ticketu, kodu albo zależności steruje agentem | kontener, allowlista sieci, brak pushu, review w osiach, bramka człowieka przy publish |
| Agent może wysłać dane do hosta z allowlisty (np. przez API dostawcy modelu) | allowlista minimalna, log egress per sesja |
| Kod repo trafia do dostawcy modelu | decyzja organizacji: konto, umowa, retencja (poniżej) |
| `mode: none` daje słabszą izolację niż kontener | zalecenie: w organizacji tylko `container` |
| `sandbox.containers` poszerza uprawnienia kontenera (na Dockerze bez `no-new-privileges`) i otwiera Docker Hub | domyślnie wyłączone; włączać tylko dla repo, które tego potrzebują (config globalny albo workspace z listy `workspaces`) |

## Dane wysyłane do dostawców modeli

Model nie działa na komputerze użytkownika. Harness (Claude Code, Codex) przy każdym kroku wysyła do API dostawcy
treść sesji: pliki, które agent przeczytał, ticket, spec, wyniki komend i testów. Wszystko, co agent zobaczy,
trafia do dostawcy. Kontener i allowlista tego nie zmieniają — endpoint modelu musi być na allowliście, żeby
sesja w ogóle działała. Orkiestrator sam nie wysyła niczego do modeli.

„Dostawca” to endpoint, z którym łączy się harness: publiczne API (`api.anthropic.com`, `api.openai.com`) albo
firmowy gateway (`ANTHROPIC_BASE_URL`, provider Codexa), który przekazuje ruch dalej. Przy gatewayu retencję i warunki ustala ten, kto
go prowadzi, i jego umowa z dostawcą modeli; framework niczego tu nie dodaje. Organizacja decyduje:

- z jakiego konta albo gatewaya korzysta zespół (firmowe API / plan zespołowy / własny gateway, a nie prywatne
  subskrypcje),
- jaka retencja i jakie warunki przetwarzania danych obowiązują u dostawcy,
- które repo wolno przetwarzać.

## Zalecany config dla organizacji

```yaml
# ~/.agentic/config.yaml (config globalny)
sandbox:
  mode: container            # bez `none`
  network:
    allow: [api.anthropic.com, <mirror artefaktów organizacji>]   # z gatewayem: bez api.anthropic.com (jego host dochodzi sam)
  containers: false          # włączać tylko dla repo, które tego potrzebują
```

Plus: gitleaks zainstalowany u każdego, kto robi `publish`; credential harnessa z konta organizacji.
