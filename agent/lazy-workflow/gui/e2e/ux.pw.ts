import { test, expect } from "./fixture.ts";

test("assigned work, HU task tracking and a Code run with a listed model", async ({ page }, testInfo) => {
  const failures: string[] = [];
  const starts: unknown[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("request", (request) => { if (request.url().endsWith("/api/rpc/start_run")) starts.push(request.postDataJSON()); });
  page.on("dialog", (dialog) => { void dialog.accept(); });
  await page.goto("/");
  await page.getByLabel("Usuario", { exact: true }).fill("owner");
  await page.getByLabel("Contraseña", { exact: true }).fill("synthetic-passphrase");
  await page.getByRole("button", { name: "Iniciar sesion", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Trabajo", exact: true })).toBeVisible();
  const list = page.locator(".work-list");
  await expect(list.getByText("Mejorar el portal de clientes", { exact: true })).toBeVisible();
  await expect(list.getByText("Simplificar el formulario de ingreso", { exact: true })).toBeVisible();
  await expect(list.getByText("Mejorar la navegación principal", { exact: true })).toBeVisible();
  await expect(list.getByText("Épica", { exact: true })).toBeVisible();
  // Internal tools and credential forms are not part of the interface.
  await expect(page.getByText("Herramientas avanzadas")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "git-branch-list" })).toHaveCount(0);
  // A repository whose work cannot be read raises the configuration notice.
  await expect(page.getByRole("status", { name: "Configuración pendiente" })).toContainText("broken-project");
  // Upright, the navigation sits at the bottom; on its side it joins the top bar.
  if (testInfo.project.use.isMobile && page.viewportSize()!.height > page.viewportSize()!.width) {
    const work = await page.getByRole("button", { name: "Trabajo", exact: true }).boundingBox();
    expect(work!.height).toBeGreaterThanOrEqual(44);
    expect(work!.y).toBeGreaterThan(page.viewportSize()!.height - 80);
    expect((await page.locator(".sidebar").boundingBox())!.height).toBeLessThan(140);
  }
  await page.getByLabel("Filtrar por plataforma").selectOption("github");
  await expect(list.getByText("Mejorar el portal de clientes", { exact: true })).toBeHidden();
  await page.getByLabel("Filtrar por plataforma").selectOption("all");
  await page.getByLabel("Buscar trabajo").fill("formulario");
  await expect(list.getByText("Mejorar la navegación principal", { exact: true })).toBeHidden();
  await page.getByLabel("Buscar trabajo").fill("");
  const home = testInfo.outputPath(`${testInfo.project.name}-work.png`);
  await page.screenshot({ path: home, fullPage: true });
  await testInfo.attach("work", { path: home, contentType: "image/png" });

  await list.getByText("Mejorar el portal de clientes", { exact: true }).click();
  const panel = page.locator(".work-panel");
  await expect(panel.getByRole("heading", { name: "Mejorar el portal de clientes" })).toBeVisible();
  await expect(panel.getByText("1 de 2 tareas terminadas")).toBeVisible();
  await expect(panel.locator(".task-list")).toContainText("Publicar el portal");
  const detail = testInfo.outputPath(`${testInfo.project.name}-hu.png`);
  await page.screenshot({ path: detail, fullPage: true });
  await testInfo.attach("hu-detail", { path: detail, contentType: "image/png" });

  await panel.getByRole("button", { name: "Implementar", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Implementar HU #50" })).toBeVisible();
  await expect(panel.getByText("Todas las tareas pendientes (1)")).toBeVisible();
  await panel.getByRole("radio", { name: /#51/ }).check();
  await expect(panel.getByRole("radio", { name: /#52/ })).toBeDisabled();
  await panel.getByRole("radio", { name: "Codex" }).click();
  await expect(panel.locator("#run-model")).toHaveValue("");
  await expect(panel.locator("#run-model option")).toContainText(["Predeterminado · gpt-synthetic", "GPT Synthetic Sol"]);
  await panel.locator("#run-model").selectOption("gpt-synthetic-sol");
  await expect(panel.locator("#run-variant option")).toHaveText(["Predeterminado · high", "low", "medium", "high"]);
  await panel.locator("#run-variant").selectOption("high");
  expect(starts).toHaveLength(0);
  const form = testInfo.outputPath(`${testInfo.project.name}-code-form.png`);
  await page.screenshot({ path: form, fullPage: true });
  await testInfo.attach("code-form", { path: form, contentType: "image/png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByRole("button", { name: "Ejecutar Code", exact: true }).click();
  // The run opens where runs are followed, with its progress.
  await expect(page.locator(".run-detail h2")).toHaveText("Code · HU #50 · Task #51");
  const progress = testInfo.outputPath(`${testInfo.project.name}-run.png`);
  await page.screenshot({ path: progress, fullPage: true });
  await testInfo.attach("run-progress", { path: progress, contentType: "image/png" });
  expect(starts).toHaveLength(1);
  const args = (starts[0] as { request: { args: string[] } }).request.args;
  expect(args.slice(0, 1)).toEqual(["code"]);
  for (const [flag, value] of [["--hu", "50"], ["--ticket", "51"], ["--cli", "codex"], ["--model", "gpt-synthetic-sol"]]) expect(args[args.indexOf(flag!) + 1]).toBe(value);
  // `high` is the CLI's default effort, so the shortest command line leaves it out.
  expect(args).not.toContain("--variant");

  await page.getByRole("button", { name: "Ejecuciones", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Historial" })).toBeVisible();
  await expect(page.locator(".history-list")).toContainText("Code · HU #45 · Task #46");
  expect(failures).toEqual([]);
});
