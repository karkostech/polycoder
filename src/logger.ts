/**
 * Minimal ANSI logger for the CLI — zero dependencies.
 */

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

let useColor = process.stdout.isTTY && !process.env.NO_COLOR;

export function setColor(enabled: boolean): void {
  useColor = enabled;
}

function paint(code: keyof typeof C, text: string): string {
  return useColor ? `${C[code]}${text}${C.reset}` : text;
}

/** Visible length without ANSI escape sequences. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export const fmt = {
  bold: (t: string) => paint("bold", t),
  dim: (t: string) => paint("dim", t),
  red: (t: string) => paint("red", t),
  green: (t: string) => paint("green", t),
  yellow: (t: string) => paint("yellow", t),
  blue: (t: string) => paint("blue", t),
  magenta: (t: string) => paint("magenta", t),
  cyan: (t: string) => paint("cyan", t),
  gray: (t: string) => paint("gray", t),
};

export const log = {
  info: (msg: string) => console.log(`${fmt.blue("ℹ")} ${msg}`),
  ok: (msg: string) => console.log(`${fmt.green("✔")} ${msg}`),
  warn: (msg: string) => console.warn(`${fmt.yellow("⚠")} ${msg}`),
  error: (msg: string) => console.error(`${fmt.red("✖")} ${msg}`),
  step: (msg: string) => console.log(`${fmt.cyan("▸")} ${msg}`),
  dim: (msg: string) => console.log(fmt.gray(msg)),
  section: (title: string) => {
    const line = "─".repeat(Math.max(4, 60 - title.length));
    console.log(`\n${fmt.bold(fmt.magenta(title))} ${fmt.gray(line)}`);
  },
  banner: (text: string) => {
    const bar = "═".repeat(text.length + 4);
    console.log(fmt.bold(fmt.cyan(`╔${bar}╗\n║  ${text}  ║\n╚${bar}╝`)));
  },
  /**
   * A rounded info panel: title in the top border, `key  value` rows
   * (keys aligned), footer text in the bottom border.
   */
  panel: (title: string, rows: Array<[string, string]>, footer?: string) => {
    const keyW = Math.max(...rows.map(([k]) => stripAnsi(k).length));
    const lines = rows.map(([k, v]) => `${fmt.dim(k)}${" ".repeat(keyW - stripAnsi(k).length)}  ${v}`);
    const inner = Math.max(
      stripAnsi(title).length + 2,
      footer !== undefined ? stripAnsi(footer).length + 2 : 0,
      ...lines.map((l) => stripAnsi(l).length),
    );
    const top = `╭─ ${fmt.bold(fmt.cyan(title))} ${"─".repeat(Math.max(1, inner - stripAnsi(title).length - 2))}╮`;
    const bottom = footer !== undefined
      ? `╰─ ${fmt.green(footer)} ${"─".repeat(Math.max(1, inner - stripAnsi(footer).length - 2))}╯`
      : `╰${"─".repeat(inner + 2)}╯`;
    const body = lines.map((l) => `│ ${l}${" ".repeat(Math.max(0, inner - stripAnsi(l).length))} │`);
    console.log([top, ...body, bottom].join("\n"));
  },
};
