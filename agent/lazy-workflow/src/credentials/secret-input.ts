/**
 * The value of a credential the operator is storing.
 *
 * It is either typed at a hidden terminal prompt or, when `--stdin` declares it,
 * read as the first line of the standard input — the only two forms that keep
 * the secret out of the command line, `ps` and the shell history. The value
 * never leaves this process except into the env file.
 */

/** The value to store: hidden at a terminal, or the first stdin line with `--stdin`. */
export async function readCredentialSecret(name: string, fromStdin: boolean): Promise<string> {
  const value = fromStdin ? await readPipedLine() : await readHiddenValue(name);
  if (value.length === 0) throw new Error(`El valor de ${name} no puede estar vacio`);
  return value;
}

async function readPipedLine(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const end = text.search(/[\r\n]/);
    if (end !== -1) return text.slice(0, end);
  }
  return text;
}

/**
 * A no-echo prompt. Raw mode delivers every keystroke, so the value is
 * accumulated in memory and nothing is written back to the terminal; escape
 * sequences — a bracketed paste, above all — are dropped instead of landing in
 * the secret.
 */
function readHiddenValue(name: string): Promise<string> {
  const input = process.stdin;
  if (input.isTTY !== true) {
    throw new Error("credentials-set requiere una terminal para el prompt oculto o --stdin para leer el valor");
  }
  process.stderr.write(`Value for ${name}: `);
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.resume();
    let value = "";
    let settled = false;
    const finish = (failure: Error | null): void => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write("\n");
      if (failure) reject(failure);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const text = chunk
        .toString()
        .replace(/\u001b\[[0-9;]*[A-Za-z~]/g, "")
        .replace(/\u001b[^[]/g, "");
      for (const char of text) {
        if (char === "\r" || char === "\n") return finish(null);
        if (char === "\u0003") return finish(new Error("interrumpido por el operador"));
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    input.on("data", onData);
  });
}
