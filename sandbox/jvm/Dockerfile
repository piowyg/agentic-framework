# agentic/jvm — agentic/base plus JDKs for Gradle and Maven repos. Gradle finds every JDK under
# /usr/lib/jvm for toolchains; JAVA_HOME is the default one. Gradle and Maven come with the repo's wrapper.
ARG BASE=agentic/base
FROM eclipse-temurin:17-jdk AS jdk17
FROM eclipse-temurin:21-jdk AS jdk21
FROM eclipse-temurin:25-jdk AS jdk25
FROM ${BASE}

COPY --from=jdk17 /opt/java/openjdk /usr/lib/jvm/temurin-17
COPY --from=jdk21 /opt/java/openjdk /usr/lib/jvm/temurin-21
COPY --from=jdk25 /opt/java/openjdk /usr/lib/jvm/temurin-25

ENV JAVA_HOME=/usr/lib/jvm/temurin-21 \
    PATH=/usr/lib/jvm/temurin-21/bin:$PATH \
    GRADLE_USER_HOME=/home/agent/.gradle

# no toolchain downloads: the proxy refuses foojay's hosts, the JDKs above are the ones on offer
COPY gradle.properties /home/agent/.gradle/gradle.properties
