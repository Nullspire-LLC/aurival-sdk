/**
 * User-facing one-line status banners, printed to stderr so piping stdout
 * stays clean. Purely additive: never touches wire behaviour, reconnect
 * timing, or existing logger output.
 *
 * Wording here MUST match `sdk/python/aurival`'s equivalent module
 * character-for-character (SDK-19) — only the language differs.
 *
 * Off by default with `Bot({ quiet: true })` or `AURIVAL_QUIET=1` (either
 * silences every line in this module).
 */

const ANSI = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
} as const;

type Color = keyof typeof ANSI;

/** Env var wins alongside the constructor flag — either silences everything. */
export function isQuiet(optionQuiet: boolean | undefined): boolean {
  if (optionQuiet) return true;
  return process.env['AURIVAL_QUIET'] === '1';
}

function colorize(line: string, color: Color | null): string {
  if (color === null) return line;
  if (!process.stderr.isTTY) return line;
  return `${ANSI[color]}${line}${ANSI.reset}`;
}

function emit(line: string, color: Color | null, quiet: boolean): void {
  if (quiet) return;
  console.error(colorize(line, color));
}

/**
 * Human-friendly elapsed time, no external deps: `"2.3s"`, `"1m 5s"`,
 * `"1h 5m"`. Used for both `reconnected after <duration>` and
 * `disconnected after <uptime>`.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  if (totalSeconds < 60) {
    const rounded = Math.round(totalSeconds * 10) / 10;
    return `${rounded}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - totalMinutes * 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

/** Same rounding as `formatDuration`'s sub-minute branch, without the unit. */
function formatSeconds(seconds: number): string {
  return `${Math.round(Math.max(0, seconds) * 10) / 10}`;
}

// -- one function per moment (SDK status banner spec) -----------------------

/** Once, at startup, before the first ws connect. */
export function connecting(handleOrId: string, quiet: boolean): void {
  emit(`aurival: connecting to bots.aurival.com as ${handleOrId}…`, 'yellow', quiet);
}

/** On receiving the very first `hello` frame for this run. */
export function connected(
  botName: string,
  sessionId: string,
  commandCount: number,
  quiet: boolean,
): void {
  const shortId = sessionId.slice(0, 8);
  emit(
    `aurival: connected — ${botName}, session ${shortId}, ${commandCount} commands registered. ` +
      `Waiting for commands. (Ctrl+C to stop)`,
    'green',
    quiet,
  );
}

/** On any close leading to a backoff/short-wait sleep before retry. */
export function reconnecting(reasonOrCode: string, delaySeconds: number, quiet: boolean): void {
  emit(
    `aurival: connection closed (${reasonOrCode}), reconnecting in ${formatSeconds(delaySeconds)}s…`,
    'yellow',
    quiet,
  );
}

/** On a `hello` that is NOT the very first one for this bot's run. */
export function reconnected(durationMs: number, quiet: boolean): void {
  emit(`aurival: reconnected after ${formatDuration(durationMs)}`, 'green', quiet);
}

/** When the bye-action table resolves to `raise`, right before it propagates. */
export function stopped(code: string, message: string, quiet: boolean): void {
  emit(`aurival: stopped — ${code}: ${message}`, 'red', quiet);
}

/** SIGINT/SIGTERM leading to a clean shutdown. */
export function disconnected(uptimeMs: number, quiet: boolean): void {
  emit(`aurival: disconnected after ${formatDuration(uptimeMs)}`, null, quiet);
}
