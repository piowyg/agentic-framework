# ArchUnit

ArchUnit checks the compiled classes of a JVM project (Java, Kotlin, Groovy) with plain unit tests. Docs: https://www.archunit.org/userguide/html/000_Index.html.

## Setup

Test dependency `com.tngtech.archunit:archunit-junit5` (`archunit-junit4` on JUnit 4), latest release, in the repo's build file, next to the other test dependencies and in their style (version catalog, BOM, property). One class in the test sources, in the root package of the production code:

```java
@AnalyzeClasses(packages = "com.example.orders", importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    @ArchTest
    static final ArchRule archNN_domain_is_framework_free = noClasses()
            .that().resideInAPackage("..domain..")
            .should().dependOnClassesThat().resideInAnyPackage("org.springframework..", "jakarta.persistence..", "com.fasterxml.jackson..")
            .because("ARCH-nn Domain is framework-free");
}
```

- The field name carries the rule id (`archNN_…`); `because(...)` puts the id and title in the failure message.
- `DoNotIncludeTests` keeps test classes out: a rule about production code would otherwise fail on its own tests.
- A rule whose `that()` matches no class fails (`archRule.failOnEmptyShould`, on by default since 1.0). Keep it on: an empty match is a wrong package pattern, and a vacuous green test would drop the rule.
- Kotlin: the same API; a `@JvmField val` in an `object` or a companion object for `@ArchTest` fields.
- Run with the repo's normal test task; ArchUnit needs no separate task.

## Patterns by rule kind

| Rule says | ArchUnit |
|---|---|
| A must not depend on B | `noClasses().that().resideInAPackage("..a..").should().dependOnClassesThat().resideInAPackage("..b..")` |
| Only A may use B | `classes().that().resideInAPackage("..b..").should().onlyBeAccessed().byAnyPackage("..a..", "..b..")` |
| No cycles between modules | `slices().matching("com.example.(*)..").should().beFreeOfCycles()` |
| Modules of a kind stay apart | `slices().matching("..adapter.(*)..").should().notDependOnEachOther()` |
| Naming (`*Controller` lives in `web`) | `classes().that().haveSimpleNameEndingWith("Controller").should().resideInAPackage("..web..")` |
| Annotation placement | `classes().that().areAnnotatedWith(Entity.class).should().resideInAPackage("..persistence..")` |
| Forbidden API | `noClasses().should().callMethod(System.class, "currentTimeMillis")` or `.dependOnClassesThat().haveFullyQualifiedName("java.util.Date")` |
| Layers | `layeredArchitecture().consideringOnlyDependenciesInLayers().layer("Api").definedBy("..api..")…whereLayer("Api").mayNotBeAccessedByAnyLayer()` |

## Hexagonal (ports and adapters) rule set

The usual core constraints, to propose as `ARCH-nn` rules when the standards name the style without numbering them. Adjust the package names to the repo's layout from step 3.

1. The domain depends on nothing outside itself and the JDK: no adapters, no application layer, no framework.
2. The application (use cases) depends on the domain and on its own ports, never on adapters.
3. Ports are interfaces, owned by the application or domain: `classes().that().resideInAPackage("..port..").should().beInterfaces()`.
4. Adapters depend inward only, and adapters stay apart: `slices().matching("..adapter.(*)..").should().notDependOnEachOther()`.
5. Framework annotations (`@RestController`, `@Entity`, `@KafkaListener`) live only in adapters and configuration.
6. No cycles between top-level modules.

Rules 1, 2 and 4 together fit `onionArchitecture()`:

```java
@ArchTest
static final ArchRule archNN_hexagonal_dependencies = onionArchitecture()
        .domainModels("..domain.model..")
        .domainServices("..domain.service..")
        .applicationServices("..application..")
        .adapter("rest", "..adapter.rest..")
        .adapter("persistence", "..adapter.persistence..")
        .because("ARCH-nn Dependencies point inward");
```

One `onionArchitecture()` test enforcing several rules marks each of those rules with the same test.

## Freezing existing violations

When the human chooses to freeze (step 7), wrap the rule; the current violations are stored and only new ones fail:

```java
@ArchTest
static final ArchRule archNN_domain_is_framework_free = FreezingArchRule.freeze(noClasses() /* … */);
```

Configure the store in `src/test/resources/archunit.properties`:

```properties
freeze.store.default.path=src/test/resources/archunit_store
freeze.store.default.allowStoreCreation=true
```

Commit the store with the tests. Run the tests once to create it, then set `allowStoreCreation=false` so a CI run without the store fails instead of freezing everything again. A violation fixed later leaves the store on the next run; the frozen count in the report is the debt left.
