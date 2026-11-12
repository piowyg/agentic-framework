[English](../../en/guides/containers.md) | Polski

# Sesje w kontenerze

Domyślnie (`sandbox.mode: container`) każda sesja agenta startuje w jednorazowym kontenerze. Ma w nim klon grupy i własne `out/`,
artefakty flow tylko do odczytu, repo źródłowe (grille) tylko do odczytu i sieć wyłącznie przez proxy
do hostów z `sandbox.network.allow` (HTTPS). Odmowy proxy lądują w `out/<sesja>.egress.log`.
W kontenerze działa też `review.checks`, również przez proxy.

Obraz zależy od repo (`sandbox.image.stack: auto`). Repo z Gradle albo Mavenem, także w katalogu pierwszego poziomu
(np. `backend/`), dostaje warstwę `agentic/jvm` z JDK 17, 21 i 25. Pozostałe repo dostają `agentic/base` (Node z corepackiem).
Hosty potrzebne warstwie (Maven Central, Gradle, npm, yarn) proxy dokłada samo, nawet gdy repo ma własne `network.allow`.
Pobrane zależności zostają we wspólnych wolumenach `agentic-cache-*`, więc drugi build nie wychodzi do sieci.

Testy z Testcontainers albo `docker compose` potrzebują silnika w sesji: `sandbox.containers: true` (config globalny
albo workspace) uruchamia w kontenerze sesji rootless Podmana z `DOCKER_HOST` na jego socket. Działa na Podmanie
i Docker Desktop. Izolacja jest wtedy słabsza ([security.md](../security.md)), więc włączaj tylko tam, gdzie testy tego wymagają.
Na macOS maszyna wirtualna silnika potrzebuje ok. 4 GB RAM na build JVM z bazą w compose; dwie maszyny naraz
(Podman i Docker Desktop) na 8 GB to za dużo.

Testy e2e z Playwrightem: obraz ma biblioteki Chromium, przeglądarkę pobiera Playwright repo — dodaj
`npx playwright install chromium` przed e2e w `review.checks` (w kontenerze trafia do wspólnego wolumenu). Hosty, których
potrzebuje sama aplikacja (np. `next/font` pobiera fonty z `fonts.googleapis.com` i `fonts.gstatic.com`), dopisz do
`sandbox.network.allow`.

```bash
agentic setup                      # Podman (brew + maszyna na macOS), za Twoją zgodą; Docker: sandbox.engine: docker
agentic sandbox build              # agentic/base (git, Claude Code, Codex, Node) + warstwa stacku tego repo
claude setup-token                 # subskrypcja: token dla kontenera (keychain hosta jest poza jego zasięgiem)
export CLAUDE_CODE_OAUTH_TOKEN=…   # w profilu powłoki; albo ANTHROPIC_API_KEY. Codex: CODEX_API_KEY
agentic doctor                     # silnik, obraz (aktualny?), credentiale harnessów, pozostałości po crashu
agentic sandbox clean              # kontenery i sieci po przerwanych procesach agentic (--caches: też cache zależności)
```

Bez kontenera: `sandbox: { mode: none }` w `~/.agentic/config.yaml`. Granicą jest wtedy sandbox samego harnessa ([security.md](../security.md)).
