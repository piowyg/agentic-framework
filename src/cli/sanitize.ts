/**
 * Strips control characters and ANSI/OSC sequences so text from agents or foreign configs
 * can't hide or rewrite what the terminal shows.
 */
export function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
