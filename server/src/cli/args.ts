export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}
export const flag = (name: string) => process.argv.includes(`--${name}`);

const ENTER = [String.fromCharCode(13), String.fromCharCode(10)];
const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(127);

/** Reads a secret without echoing it. Non-interactive: reads the first stdin line. */
export async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  }
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  return new Promise((resolve) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ENTER.includes(ch)) {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === CTRL_C) process.exit(130);
        if (ch === BACKSPACE) value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
