/**
 * Las reglas de alcance que los tres comandos SAG comparten.
 *
 * `architecture-review-sag`, `infra-sag` y `deploy-sag` rechazan el mismo
 * alcance inválido, cada uno nombrándose a sí mismo, y `deploy-sag` intercala
 * sus propias reglas de entorno entre medio. Los tests que ya cubrían esto
 * aseguraban solo el exit code, así que ni el nombre que cada comando publica ni
 * el orden en que decide estaban fijados en ninguna parte.
 */
import { expect, test } from "bun:test";
import { createCli } from "./_helpers/create-cli.ts";
import { captureReporter } from "./_helpers/reporter-capture.ts";

const SAG_COMMANDS = ["architecture-review-sag", "infra-sag", "deploy-sag"] as const;

/** El rechazo que deja un run: su exit code y lo que le dijo al operador. */
async function reject(args: string[]): Promise<{ exit: number; messages: string[] }> {
  const { reporterFn, messages } = captureReporter();
  const exit = await createCli({ createReporterFn: reporterFn }).run(args);
  return { exit, messages };
}

test("cada comando SAG rechaza un alcance ambiguo con su propio nombre", async () => {
  for (const command of SAG_COMMANDS) {
    const { exit, messages } = await reject([command, "--hu", "1", "--issue", "2"]);
    expect(exit).toBe(1);
    expect(messages).toContain(`${command} no permite combinar --hu y --issue`);
  }
});

test("cada comando SAG exige un alcance con su propio nombre", async () => {
  for (const command of SAG_COMMANDS) {
    const { exit, messages } = await reject([command]);
    expect(exit).toBe(1);
    expect(messages).toContain(`${command} requiere --hu <id> o --issue <id>`);
  }
});

/**
 * `infra-sag` queda fuera: su lista de flags admitidas rechaza `--branch` antes,
 * de modo que su propia regla de sesión no es alcanzable por línea de comandos.
 */
test("los comandos SAG que admiten flags de sesión las rechazan con su propio nombre", async () => {
  for (const command of ["architecture-review-sag", "deploy-sag"] as const) {
    const { exit, messages } = await reject([command, "--hu", "1", "--branch", "refs/heads/x"]);
    expect(exit).toBe(1);
    expect(messages).toContain(`${command} no permite --session, --branch ni --base-branch`);
  }
});

test("infra-sag rechaza una flag de sesión por su lista de flags, antes que por su alcance", async () => {
  const { exit, messages } = await reject(["infra-sag", "--hu", "1", "--branch", "refs/heads/x"]);
  expect(exit).toBe(1);
  expect(messages).toContain("infra-sag no permite --branch");
});

test("deploy-sag decide el alcance, después el entorno y al final las flags de sesión", async () => {
  const ambiguo = await reject(["deploy-sag", "--hu", "1", "--issue", "2", "--environment", "prod"]);
  expect(ambiguo.messages).toContain("deploy-sag no permite combinar --hu y --issue");

  const entorno = await reject(["deploy-sag", "--hu", "1", "--environment", "prod", "--session", "ses"]);
  expect(entorno.messages).toContain("deploy-sag solo permite DEV, TEST o QA; PROD y sus aliases estan prohibidos");
});
