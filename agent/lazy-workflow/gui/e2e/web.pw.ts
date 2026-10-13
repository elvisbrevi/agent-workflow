import { test, expect } from "./fixture.ts";

test("owner plans from the browser, answers a private interview, repairs setup and keeps data through restart", async ({ page, context }, testInfo) => {
  const failures: string[] = [];
  const starts: Array<{ request: { args: string[] } }> = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("request", (request) => { if (request.url().endsWith("/api/rpc/start_run")) starts.push(request.postDataJSON()); });
  page.on("dialog", (dialog) => { void dialog.accept(); });
  await page.goto("/");
  await page.getByLabel("Usuario", { exact: true }).fill("owner");
  await page.getByLabel("Contraseña", { exact: true }).fill("synthetic-passphrase");
  await page.getByRole("button", { name: "Iniciar sesion", exact: true }).click();
  await expect(page.getByRole("button", { name: "Trabajo", exact: true })).toBeVisible();
  await page.getByLabel("Repositorio activo").selectOption({ label: "github-project" });
  const cookie = (await context.cookies()).find((cookie) => cookie.name === "__Host-lz-session");
  expect(cookie?.secure).toBe(true); expect(cookie?.httpOnly).toBe(true); expect(cookie?.sameSite).toBe("Strict");

  // A GitHub repository offers its queue and a new plan from its section.
  await page.locator(".section-header").filter({ hasText: "synthetic/github" }).click();
  const panel = page.locator(".work-panel");
  await expect(panel.locator(".task-list")).toContainText("Agregar el menú lateral");
  await expect(panel.locator(".task-list")).toContainText("asignada");
  await panel.getByRole("button", { name: "Nuevo plan", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Ejecutar Plan", exact: true })).toBeDisabled();
  await panel.getByLabel("Qué quieres planificar").fill("Un menú lateral con accesos rápidos");
  await expect(panel.getByLabel("Responder las preguntas del agente antes de planificar")).toBeChecked();
  await panel.getByText("Más opciones", { exact: true }).click();
  await expect(panel.getByLabel("Cargar las normas SAG del componente")).not.toBeChecked();
  await panel.getByLabel("Cargar las normas SAG del componente").check();
  const sagStatus = panel.getByRole("status", { name: "Configuración de normas SAG" });
  await expect(sagStatus).toHaveText("Repositorio de normas SAG configurado (credenciales).");
  await expect(panel).toContainText(".sag/config.json");
  await expect(panel).not.toContainText("https://dev.azure.com/synthetic/Team/_git/norms");
  await panel.getByLabel("Cargar las normas SAG del componente").uncheck();
  await expect(sagStatus).toHaveCount(0);
  await panel.getByLabel("Cargar las normas SAG del componente").check();
  await panel.getByRole("button", { name: "Ejecutar Plan", exact: true }).click();
  await expect(page.getByText("Synthetic: one service or two?", { exact: true })).toBeVisible();
  const planArgs = starts.at(-1)!.request.args;
  expect(planArgs[0]).toBe("plan");
  expect(planArgs).toContain("--normas-sag");
  expect(planArgs[planArgs.indexOf("--prompt") + 1]).toBe("Un menú lateral con accesos rápidos");
  expect(planArgs[planArgs.indexOf("--interview") + 1]).toBe("http");
  await page.locator(".web-interview textarea").fill("two");
  if (testInfo.project.use.isMobile && page.viewportSize()!.height > page.viewportSize()!.width) {
    await page.getByRole("button", { name: "Enviar respuestas", exact: true }).scrollIntoViewIfNeeded();
    const submit = await page.getByRole("button", { name: "Enviar respuestas", exact: true }).boundingBox();
    const navigation = await page.getByRole("button", { name: "Trabajo", exact: true }).boundingBox();
    expect(submit!.y + submit!.height).toBeLessThan(navigation!.y);
  }
  await page.getByRole("button", { name: "Enviar respuestas", exact: true }).click();
  await expect(page.locator(".run-detail")).toContainText("syntheticAnswers");
  await expect(page.locator(".run-detail")).not.toContainText("http://127.0.0.1");

  // An epic is sliced by the coordinator: `plan --issue` publishes its sub-issues.
  // A started run opens in Ejecuciones; the work is one tap away.
  await page.getByRole("button", { name: "Trabajo", exact: true }).click();
  // Narrow screens show the list or the panel; wide ones show both.
  const back = page.getByRole("button", { name: "Volver a la lista" });
  if (await back.isVisible()) await back.click();
  await page.locator(".work-list").getByText("[Epic] Portal de autoservicio", { exact: true }).click();
  await panel.getByRole("button", { name: "Planificar esta épica", exact: true }).click();
  await panel.getByLabel("Responder las preguntas del agente antes de planificar").uncheck();
  await panel.getByRole("button", { name: "Ejecutar Plan", exact: true }).click();
  const epicArgs = starts.at(-1)!.request.args;
  expect(epicArgs[epicArgs.indexOf("--issue") + 1]).toBe("9");
  expect(epicArgs).not.toContain("--prompt");
  expect(epicArgs).not.toContain("--interview");
  await expect(page.locator(".run-detail")).toContainText("syntheticPlan");

  // Settings hold no credential fields; a missing piece is repaired by an agent session.
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Estado del equipo" })).toBeVisible();
  await expect(page.locator(".preferences-page input[type=password]")).toHaveCount(0);
  await expect(page.locator(".preferences-page")).not.toContainText("AZURE_DEVOPS_EXT_PAT");
  await expect(page.locator(".preferences-page")).not.toContainText("synthetic-pat");
  await expect(page.locator(".status-list")).toContainText("https://dev.azure.com/synthetic");
  const banner = page.getByRole("status", { name: "Configuración pendiente" }).first();
  await banner.getByRole("button", { name: "Reparar con agente", exact: true }).click();
  await expect(page.locator(".run-detail")).toContainText("synthetic setup report");
  const setupArgs = starts.at(-1)!.request.args;
  expect(setupArgs[0]).toBe("setup");
  expect(setupArgs[setupArgs.indexOf("--prompt") + 1]).toContain("broken-project");
  const screenshot = testInfo.outputPath(`${testInfo.project.name}-settings.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("settings", { path: screenshot, contentType: "image/png" });

  // The repair opened its progress in Ejecuciones; preferences are back in Ajustes.
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  const theme = page.getByLabel("Tema");
  const nextTheme = (await theme.inputValue()) === "dark" ? "light" : "dark";
  await theme.selectOption(nextTheme);
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Ajustes guardados." })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await expect(page.getByLabel("Tema")).toHaveValue(nextTheme);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The event feed reloads the page when the server instance changes. A second
  // manual reload races that navigation and aborts intercepted requests.
  const restarted = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
  await page.request.post("https://127.0.0.1:18443/__test/restart", { headers: { "x-synthetic-test": "synthetic-loopback-fixture" } });
  await restarted;
  await page.waitForLoadState();
  await expect(page.getByRole("button", { name: "Trabajo", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await expect(page.getByLabel("Tema")).toHaveValue(nextTheme);
  await page.request.post("https://127.0.0.1:18443/__test/expire", { headers: { "x-synthetic-test": "synthetic-loopback-fixture" } });
  // The next authenticated poll detects the expired session and opens login.
  await expect(page.getByRole("button", { name: "Iniciar sesion", exact: true })).toBeVisible();
  await page.getByLabel("Usuario", { exact: true }).fill("owner");
  await page.getByLabel("Contraseña", { exact: true }).fill("synthetic-passphrase");
  await page.getByRole("button", { name: "Iniciar sesion", exact: true }).click();
  // The account control sits in the sidebar on wide screens and in Ajustes on phones.
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await expect(page.getByRole("button", { name: "Iniciar sesion", exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});
