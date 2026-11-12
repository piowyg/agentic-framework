[English](../en/getting-started.md) | Polski

# Pierwsze kroki

Instalacja, próba bez tokenów i pierwszy prawdziwy flow.

## Instalacja

```bash
git clone https://github.com/piowyg/agentic-framework.git && cd agentic-framework
npm install
npm run build && npm link          # komenda `agentic` w PATH

agentic doctor                     # sprawdza config, CLI harnessów, silnik kontenerów — niczego nie zmienia
agentic models                     # katalog modeli: alias → harness, ID, efforty
agentic config show                # scalony config + skąd pochodzi każda warstwa
agentic init                       # w repo serwisu: .agentic/config.yaml z review.checks wykrytego builda + szablon ticketu
```

Sesje agentów domyślnie działają w kontenerze: obraz i poświadczenia przygotowuje
[guides/containers.md](guides/containers.md). Config globalny i repo: [guides/config.md](guides/config.md).

## Próba bez tokenów

Przed pierwszym prawdziwym flow przejdź całość z `--fake`: fake harness gra agenta, więc nic nie kosztuje.
Działa w dowolnym repo z `review.checks` (etap write-tests pomija).

```bash
agentic new "Limit koszyka" --fake
agentic new --fake                 # bez opisu: wklejasz dłuższy opis pomysłu, koniec linią z samą kropką `.`
agentic pick --fake                # bez ścieżki: wklejasz ticket (np. z Jiry), koniec linią `.`
agentic status                     # lista flow
agentic status limit-koszyka       # etapy, grupy, rundy review, zużycie
agentic resume limit-koszyka --fake
agentic clean --dry-run            # co zostało po starych flow (klony, bundle, gałęzie agentic/*) i ile zajmuje
```

Na bramkach wybierasz akcję: kontynuuj / popraw z notatką / zapisz i wstrzymaj / przerwij
(na bramce ticketu dodatkowo: wrzuć do trackera i zakończ). Wstrzymany flow wznawiasz `agentic resume <slug>`.
Flow przerwany albo `failed` pyta na koniec, czy posprzątać. Później zrobi to `agentic clean [slug]`: gałąź z
commitami, których nie ma nigdzie indziej, usuwa tylko po potwierdzeniu, a artefakty do audytu zostawia.

Ticket z `status: ready` i kryteriami `AC-n`, wklejony albo z pliku, idzie od razu do grilla technicznego. Każdy inny
tekst (np. ticket skopiowany z trackera) `pick` proponuje zacząć od grilla biznesowego: tekst trafia do `idea.md`
flow, a grill robi z niego ticket w formacie frameworka.

## Pierwszy prawdziwy flow

Te same polecenia bez `--fake`. Cała droga od instalacji do PR-a na prawdziwym repo, z publish i sprzątaniem:
[guides/swe.md](guides/swe.md).
