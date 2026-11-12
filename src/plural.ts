/** `1 group`, `0 groups`, `2 groups`. */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
