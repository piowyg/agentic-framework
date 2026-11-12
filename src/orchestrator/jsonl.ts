import fs from 'node:fs';
import { appendFileSafe } from '../fsutil.js';

/** Appends one JSON line; a line truncated by a killed process must not swallow this record. */
export function appendJsonLine(file: string, record: object): void {
  appendFileSafe(file, (endsMidLine(file) ? '\n' : '') + JSON.stringify(record) + '\n');
}

/** Parsed lines accepted by `isRecord`; truncated or foreign lines are skipped. */
export function readJsonLines<Record>(file: string, isRecord: (value: unknown) => value is Record): Record[] {
  if (!fs.existsSync(file)) return [];
  const records: Record[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) records.push(value);
    } catch {
      // truncated line
    }
  }
  return records;
}

function endsMidLine(file: string): boolean {
  let fileDescriptor: number;
  try {
    fileDescriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const size = fs.fstatSync(fileDescriptor).size;
    if (!size) return false;
    const lastByte = Buffer.alloc(1);
    fs.readSync(fileDescriptor, lastByte, 0, 1, size - 1);
    return lastByte[0] !== 0x0a;
  } finally {
    fs.closeSync(fileDescriptor);
  }
}
