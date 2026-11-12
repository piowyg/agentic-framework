import type { ModelCatalog } from '../config/models.js';
import { ClaudeHarness } from './claude.js';
import { CodexHarness } from './codex.js';
import type { HarnessRegistry } from './types.js';

export function cliRegistry(catalog: ModelCatalog): HarnessRegistry {
  return { claude: new ClaudeHarness(catalog), codex: new CodexHarness(catalog) };
}
