#!/usr/bin/env node
import { ConfigError } from '../config/validate.js';
import { errorMessage } from '../errors.js';
import { buildProgram } from './program.js';
import { sanitize } from './sanitize.js';

try {
  await buildProgram().parseAsync(process.argv);
} catch (error) {
  console.error(sanitize(error instanceof ConfigError ? error.message : `Error: ${errorMessage(error)}`));
  process.exitCode = 1;
}
