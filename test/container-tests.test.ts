import { describe, expect, it } from 'vitest';
import { containerTestSignals } from '../src/sandbox/container-tests.js';
import { tmpDir, write } from './helpers.js';

describe('container tests: what in a repo starts containers in its tests', () => {
  it('Testcontainers in Gradle (also a submodule and the version catalog), Maven and npm', () => {
    const root = tmpDir();
    write(root, 'build.gradle.kts', 'plugins { java }\n');
    write(root, 'orders/build.gradle', "testImplementation 'org.testcontainers:postgresql:1.20.4'\n");
    write(root, 'gradle/libs.versions.toml', 'testcontainers-bom = { module = "org.testcontainers:testcontainers-bom", version = "1.20.4" }\n');
    write(root, 'billing/pom.xml', '<artifactId>testcontainers</artifactId>');
    write(root, 'web/package.json', JSON.stringify({ devDependencies: { '@testcontainers/postgresql': '^10.0.0' } }));
    expect(containerTestSignals(root, [])).toEqual([
      'billing/pom.xml (Testcontainers)',
      'gradle/libs.versions.toml (Testcontainers)',
      'orders/build.gradle (Testcontainers)',
      'web/package.json (Testcontainers)',
    ]);
  });

  it('docker compose in the build or in review.checks', () => {
    const root = tmpDir();
    write(root, 'build.gradle', "plugins { id 'com.avast.gradle.docker-compose' version '0.17.12' }\n");
    expect(containerTestSignals(root, ['docker compose up -d && ./gradlew test', 'npm test'])).toEqual([
      'build.gradle (docker compose)',
      '`docker compose up -d && ./gradlew test` (review.checks)',
    ]);
  });

  it('ignores build output and dependencies, and a repo without containers in tests', () => {
    const root = tmpDir();
    write(root, 'build.gradle', 'plugins { java }\n');
    write(root, 'node_modules/testcontainers/package.json', JSON.stringify({ name: 'testcontainers' }));
    write(root, 'build/tmp/pom.xml', '<artifactId>testcontainers</artifactId>');
    expect(containerTestSignals(root, ['./gradlew build'])).toEqual([]);
  });
});
