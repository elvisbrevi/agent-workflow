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

test("Planificar lists HUs, Bugs and epics from the tracker, downloads where to work and plans there", async ({ page }, testInfo) => {
  const failures: string[] = [];
  const starts: Array<{ request: { args: string[] } }> = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("request", (request) => { if (request.url().endsWith("/api/rpc/start_run")) starts.push(request.postDataJSON()); });
  page.on("dialog", (dialog) => { void dialog.accept(); });
  await page.goto("/");
  await page.getByLabel("Usuario", { exact: true }).fill("owner");
  await page.getByLabel("Contraseña", { exact: true }).fill("synthetic-passphrase");
  await page.getByRole("button", { name: "Iniciar sesion", exact: true }).click();
  await page.getByRole("button", { name: "Planificar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Planificar", exact: true })).toBeVisible();
  const list = page.locator(".work-list");
  await page.getByRole("radio", { name: "Azure DevOps" }).click();
  await expect(list.getByText("Mejorar el portal de clientes", { exact: true })).toBeVisible();
  await expect(list.getByText("Bug #70", { exact: true })).toBeVisible();
  const listing = testInfo.outputPath(`${testInfo.project.name}-plan-list.png`);
  await page.screenshot({ path: listing, fullPage: true });
  await testInfo.attach("plan-list", { path: listing, contentType: "image/png" });

  // The Bug opens its plan; it is downloaded from its project into a new folder beside the saved ones.
  await list.getByText("Falla el cierre de sesión", { exact: true }).click();
  const panel = page.locator(".work-panel");
  await expect(panel.getByRole("heading", { name: "Planificar Bug #70" })).toBeVisible();
  await panel.getByRole("radio", { name: "Descargar repo" }).click();
  await expect(panel.getByLabel("Proyecto de Azure DevOps")).toHaveValue("Synthetic Azure");
  await panel.getByLabel("Repositorio", { exact: true }).selectOption("portal-api");
  const folder = `portal-api-${testInfo.project.name}`;
  await panel.getByLabel("Nombre de la carpeta").fill(folder);
  await expect(panel.getByText(new RegExp(`${folder}, que no debe existir`))).toBeVisible();
  const cloneForm = testInfo.outputPath(`${testInfo.project.name}-plan-clone.png`);
  await page.screenshot({ path: cloneForm, fullPage: true });
  await testInfo.attach("plan-clone", { path: cloneForm, contentType: "image/png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByRole("button", { name: "Descargar", exact: true }).click();
  // The download runs without leaving the form, then its folder is registered and chosen.
  await expect(panel.getByRole("checkbox", { name: folder })).toBeChecked();
  const clone = starts[0]!.request.args;
  expect(clone.slice(0, 7)).toEqual(["repo-clone", "--tracker", "azure", "--repository", "portal-api", "--project", "Synthetic Azure"]);
  expect(clone[8]).toMatch(new RegExp(`/${folder}$`));
  await panel.getByText("Responder las preguntas del agente antes de planificar").click();
  await panel.getByRole("button", { name: "Ejecutar Plan", exact: true }).click();
  await expect(page.locator(".run-detail h2")).toHaveText("Plan · HU #70");
  const plan = starts[1]!.request.args;
  expect(plan[plan.indexOf("--hu") + 1]).toBe("70");
  expect(plan[plan.indexOf("--working-directory") + 1]).toBe(clone[8]);

  // An epic offers its own repository to download, and an account to create a new one in.
  await page.getByRole("button", { name: "Planificar", exact: true }).click();
  await page.getByRole("radio", { name: "GitHub" }).click();
  await list.getByText("[Epic] Portal de autoservicio", { exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Planificar la épica #9" })).toBeVisible();
  await panel.getByRole("radio", { name: "Descargar repo" }).click();
  await expect(panel.getByLabel("Repositorio de GitHub")).toHaveValue("synthetic/github");
  await panel.getByRole("radio", { name: "Crear repo nuevo" }).click();
  await expect(panel.getByLabel("Cuenta u organización")).toHaveValue("synthetic");
  await panel.getByRole("radio", { name: "Proyecto existente" }).click();
  await panel.getByRole("checkbox", { name: "github-project" }).check();
  await panel.getByText("Responder las preguntas del agente antes de planificar").click();
  const epicForm = testInfo.outputPath(`${testInfo.project.name}-plan-epic.png`);
  await page.screenshot({ path: epicForm, fullPage: true });
  await testInfo.attach("plan-epic", { path: epicForm, contentType: "image/png" });
  await panel.getByRole("button", { name: "Ejecutar Plan", exact: true }).click();
  await expect(page.locator(".run-detail h2")).toHaveText("Plan · Issue #9");
  const epic = starts[2]!.request.args;
  expect(epic[epic.indexOf("--issue") + 1]).toBe("9");
  expect(epic[epic.indexOf("--issue-repository") + 1]).toBe("synthetic/github");
  expect(epic[epic.indexOf("--working-directory") + 1]).toMatch(/\/github-project$/);
  await expect(page.locator("body")).toContainText(`Descarga · ${folder}`);

  // A command's own agent is shown, saved and kept, so the default never hides it.
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  const own = page.getByRole("checkbox", { name: "Plan usa otro agente" });
  await expect(own).not.toBeChecked();
  await own.check();
  await page.locator(".command-agent").first().getByRole("radio", { name: "Codex" }).click();
  await page.locator("#plan-agent-model").selectOption("gpt-synthetic-sol");
  await page.locator("#plan-agent-variant").selectOption("low");
  // Looking at another agent and coming back keeps what was chosen there.
  await page.locator(".command-agent").first().getByRole("radio", { name: "Claude Code" }).click();
  await expect(page.locator("#plan-agent-model")).toHaveValue("");
  await page.locator(".command-agent").first().getByRole("radio", { name: "Codex" }).click();
  await expect(page.locator("#plan-agent-model")).toHaveValue("gpt-synthetic-sol");
  await expect(page.locator("#plan-agent-variant")).toHaveValue("low");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(page.getByText("Ajustes guardados.")).toBeVisible();
  // Leaving and coming back renders what the server answered, not the edited form.
  await page.getByRole("button", { name: "Trabajo", exact: true }).click();
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await expect(own).toBeChecked();
  await expect(page.locator(".command-agent").first().getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#plan-agent-model")).toHaveValue("gpt-synthetic-sol");
  await expect(page.locator("#plan-agent-variant")).toHaveValue("low");
  await own.uncheck();
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(page.getByText("Plan usa el agente predeterminado.")).toBeVisible();
  expect(failures).toEqual([]);
});

test("the owner walks the server's folders to pick a repository instead of typing its path", async ({ page }, testInfo) => {
  // Registering a folder changes the shared fixture, so one phone run adds it.
  test.skip(testInfo.project.name !== "phone", "registers a folder once per fixture");
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto("/");
  await page.getByLabel("Usuario", { exact: true }).fill("owner");
  await page.getByLabel("Contraseña", { exact: true }).fill("synthetic-passphrase");
  await page.getByRole("button", { name: "Iniciar sesion", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Trabajo", exact: true })).toBeVisible();
  await page.locator(".repo-picker").getByRole("button", { name: "Agregar repositorio…" }).click();
  const folders = page.getByRole("dialog");
  // It opens on the browsable root, listing its visible folders: no keyboard, nothing to type.
  await expect(folders.locator(".folder-entry").first()).toHaveText("archive");
  await expect(folders.getByRole("button", { name: "github-project agregado" })).toBeVisible();
  await expect(folders.getByLabel("Ruta en el servidor")).not.toBeFocused();
  await expect(folders.getByRole("button", { name: "Carpeta superior" })).toHaveCount(0);
  await folders.getByRole("button", { name: "archive", exact: true }).click();
  await expect(folders.getByLabel("Ruta en el servidor")).toHaveValue(/\/archive$/);
  await expect(folders.getByText("Sin subcarpetas.")).toBeVisible();
  const registered = await page.getByLabel("Repositorio activo").locator("option").count();
  await folders.getByRole("button", { name: "Agregar repositorio", exact: true }).click();
  await expect(folders).toBeHidden();
  await expect(page.getByLabel("Repositorio activo")).toHaveValue(/\/archive$/);
  await expect(page.getByLabel("Repositorio activo").locator("option")).toHaveCount(registered + 1);
  // `..` walks back up; a folder already registered is selected, not added twice.
  await page.locator(".repo-picker").getByRole("button", { name: "Agregar repositorio…" }).click();
  await expect(folders.getByRole("button", { name: "archive agregado" })).toBeVisible();
  await folders.getByRole("button", { name: "archive agregado" }).click();
  await folders.getByRole("button", { name: "Carpeta superior" }).click();
  await folders.getByRole("button", { name: "azure-project agregado" }).click();
  await folders.getByRole("button", { name: "Agregar repositorio", exact: true }).click();
  await expect(page.getByLabel("Repositorio activo")).toHaveValue(/\/azure-project$/);
  await expect(page.getByLabel("Repositorio activo").locator("option")).toHaveCount(registered + 1);
  // A path outside the root the server allows is refused inside the dialog.
  await page.locator(".repo-picker").getByRole("button", { name: "Agregar repositorio…" }).click();
  await folders.getByLabel("Ruta en el servidor").fill("/");
  await folders.getByLabel("Ruta en el servidor").press("Enter");
  await expect(folders.getByRole("alert")).toContainText("cannot be browsed");
  await folders.getByRole("button", { name: "Cerrar selector de carpetas" }).click();
  await page.getByLabel("Repositorio activo").selectOption({ label: "github-project" });
  await expect(page.getByLabel("Repositorio activo")).toHaveValue(/\/github-project$/);
  expect(failures).toEqual([]);
});
