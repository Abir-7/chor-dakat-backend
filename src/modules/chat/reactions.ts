/**
 * Emojis players (and bots) are allowed to react with. Shared between the
 * chat gateway's validation and the server-side bot reaction generator so
 * both always agree.
 */
export const ALLOWED_REACTIONS: ReadonlySet<string> = new Set([
  '😂',
  '😭',
  '😕',
  '🤝',
  '🕵️',
  '🤫',
  '😱',
  '👑',
  '🔥',
  '👀',
  '👍',
]);
