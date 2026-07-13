/**
 * The remote-browser data-transfer route is the smallest supported upload
 * route, so every generated context bundle must fit within this ceiling.
 */
export const MAX_CONTEXT_BYTES = 20 * 1024 * 1024;

export function formatContextLimit(bytes = MAX_CONTEXT_BYTES): string {
  return `${bytes} bytes (20 MiB)`;
}
