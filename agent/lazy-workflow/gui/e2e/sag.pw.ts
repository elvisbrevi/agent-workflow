import { test, expect } from "./fixture.ts";

const states = [
  { source: "credentials", present: true, error: null, text: "Repositorio de normas SAG configurado (credenciales)." },
  { source: "settings", present: true, error: null, text: "Repositorio de normas SAG configurado (perfil)." },
  { source: "settings", present: true, error: "synthetic-private-error", text: "Repositorio de normas SAG configurado (perfil)." },
  { source: "environment", present: true, error: null, text: "Repositorio de normas SAG configurado (entorno)." },
  { source: "missing", present: false, error: null, text: "Falta configurar LAZY_WORKFLOW_SAG_NORMS_REPOSITORY en el equipo que ejecuta lz." },
  { source: "missing", present: false, error: "synthetic-private-error", text: "No se pudo comprobar el repositorio de normas SAG." },
];

test("SAG diagnosis shows each source and missing configuration without exposing values", async ({ page }, testInfo) => {
  // All states share one login so the fixture's production rate limit stays intact.
  await page.request.post("https://127.0.0.1:18443/__test/restart", { headers: { "x-synthetic-test": "synthetic-loopback-fixture" } });
  let state = states[0]!;
  await page.route("**/api/rpc/diagnose", (route) => route.fulfill({ json: {
    settingsPath: "synthetic", runLogPath: "synthetic", lzLauncher: "synthetic", lzError: null,
    credentialsError: state.error, shellEnvironment: false, binaries: [],
    variables: [{ name: "LAZY_WORKFLOW_SAG_NORMS_REPOSITORY", present: state.present,
      value: "synthetic-value-must-stay-hidden", source: state.source }],
  } }));
  await page.goto("/");
  await page.getByLabel("Usuario", { exact: true }).fill("owner");
  await page.getByLabel("Contraseña", { exact: true }).fill("synthetic-passphrase");
  await page.getByRole("button", { name: "Iniciar sesion", exact: true }).click();
  for (const next of states) {
    state = next;
    if (next !== states[0]) await page.reload();
    await page.locator(".work-list").getByText("Mejorar el portal de clientes", { exact: true }).click();
    const panel = page.locator(".work-panel");
    await panel.getByRole("button", { name: "Implementar", exact: true }).click();
    await panel.getByText("Más opciones", { exact: true }).click();
    const status = panel.getByRole("status", { name: "Configuración de normas SAG" });
    await expect(status).toHaveCount(0);
    await panel.getByLabel("Cargar las normas SAG del componente").check();
    await expect(status).toHaveText(state.text);
    await expect(panel).toContainText(".sag/config.json");
    await expect(panel).not.toContainText("synthetic-value-must-stay-hidden");
    await expect(panel).not.toContainText("synthetic-private-error");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (state.source === "credentials" || (!state.present && !state.error)) {
      const path = testInfo.outputPath(`${testInfo.project.name}-sag-${state.source}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`sag-${state.source}`, { path, contentType: "image/png" });
    }
    await panel.getByLabel("Cargar las normas SAG del componente").uncheck();
    await expect(status).toHaveCount(0);
  }
});
