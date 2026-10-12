import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "./fixture.ts";

/**
 * Every screen on an iPhone 15, held to what makes a phone interface usable:
 * nothing wider than the screen, controls a thumb can hit (44 pt), no field
 * small enough for Safari to zoom into on focus, and no control hidden under
 * the fixed bottom navigation.
 */
async function audit(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const width = window.innerWidth;
    if (document.documentElement.scrollWidth > width) problems.push(`page is ${document.documentElement.scrollWidth}px wide`);
    for (const element of document.querySelectorAll<HTMLElement>(".main, .work-panel, .panel-card, .feed")) {
      if (element.scrollWidth > element.clientWidth + 1) problems.push(`${element.className} overflows by ${element.scrollWidth - element.clientWidth}px`);
    }
    // A fixed bottom navigation must end the scrolling area, not cover its last controls.
    const navigation = document.querySelector(".nav-items")?.getBoundingClientRect();
    for (const area of document.querySelectorAll<HTMLElement>(".main")) {
      const box = area.getBoundingClientRect();
      if (navigation && box.height > 0 && navigation.top > box.top && box.bottom > navigation.top + 1) problems.push(`${area.className} scrolls under the navigation`);
    }
    const label = (element: Element) => `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 30)}"`;
    for (const element of document.querySelectorAll<HTMLElement>("button, select, input:not([type=radio]):not([type=checkbox]), textarea, summary, .choice, .toggle")) {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (box.width === 0 || box.height === 0 || style.visibility === "hidden" || box.bottom < 0 || box.top > window.innerHeight) continue;
      if (box.right > width + 1 || box.left < -1) problems.push(`${label(element)} sticks out horizontally`);
      if (box.height < 44 && !element.closest(".nav-items")) problems.push(`${label(element)} is ${Math.round(box.height)}px tall`);
      if (["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName) && parseFloat(style.fontSize) < 16) problems.push(`${label(element)} has ${style.fontSize} text and zooms on focus`);
    }
    return [...new Set(problems)];
  });
}

async function shoot(page: Page, testInfo: TestInfo, name: string, problems: string[]) {
  const path = testInfo.outputPath(`${testInfo.project.name}-${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
  problems.push(...(await audit(page)).map((problem) => `${name}: ${problem}`));
}

test("every screen fits and is usable on an iPhone 15", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("iphone"), "iPhone-only walkthrough");
  const problems: string[] = [];
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("dialog", (dialog) => { void dialog.accept(); });
  await page.goto("/");
  await page.getByLabel("Usuario", { exact: true }).fill("owner");
  await page.getByLabel("Contraseña", { exact: true }).fill("synthetic-passphrase");
  await page.getByRole("button", { name: "Iniciar sesion", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Trabajo", exact: true })).toBeVisible();
  await expect(page.getByText("Buscando tu trabajo…")).toBeHidden();
  await shoot(page, testInfo, "1-work", problems);

  const list = page.locator(".work-list");
  await list.getByText("Mejorar el portal de clientes", { exact: true }).click();
  const panel = page.locator(".work-panel");
  await expect(panel.getByText("1 de 2 tareas terminadas")).toBeVisible();
  // The panel replaces the list and starts at its own top, wherever the list was scrolled.
  await expect(panel.getByRole("button", { name: "Volver a la lista" })).toBeInViewport();
  await shoot(page, testInfo, "2-hu", problems);

  await panel.getByRole("button", { name: "Implementar", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Implementar HU #50" })).toBeInViewport();
  await shoot(page, testInfo, "3-code-form", problems);
  await panel.getByText("Más opciones", { exact: true }).click();
  await panel.getByText("Agregar respaldo", { exact: true }).click();
  await panel.getByRole("button", { name: "Ejecutar Code", exact: true }).scrollIntoViewIfNeeded();
  await shoot(page, testInfo, "4-code-options", problems);
  await expect(panel.getByRole("button", { name: "Ejecutar Code", exact: true })).toBeInViewport();
  await panel.getByRole("button", { name: "Cancelar", exact: true }).click();
  await panel.getByRole("button", { name: "Volver a la lista" }).click();

  await page.locator(".section-header").filter({ hasText: "synthetic/github" }).click();
  await expect(panel.locator(".task-list")).toContainText("Agregar el menú lateral");
  await shoot(page, testInfo, "5-github-queue", problems);
  await panel.getByRole("button", { name: "Nuevo plan", exact: true }).click();
  await panel.getByLabel("Qué quieres planificar").fill("Un menú lateral con accesos rápidos");
  await panel.getByRole("button", { name: "Ejecutar Plan", exact: true }).click();
  await expect(page.getByText("Synthetic: one service or two?", { exact: true })).toBeVisible();
  await shoot(page, testInfo, "6-interview", problems);
  await page.getByRole("button", { name: "Enviar respuestas", exact: true }).click();
  await expect(page.locator(".run-detail")).toContainText("syntheticAnswers");
  await shoot(page, testInfo, "7-run-output", problems);
  await page.getByRole("button", { name: "Volver a las ejecuciones" }).click();
  await page.locator(".history-summary").first().click();
  await shoot(page, testInfo, "8-executions", problems);

  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Estado del equipo" })).toBeVisible();
  await shoot(page, testInfo, "9-settings", problems);
  await page.getByRole("button", { name: "Guardar", exact: true }).scrollIntoViewIfNeeded();
  await shoot(page, testInfo, "10-settings-end", problems);

  await page.locator(".repo-picker").getByRole("button", { name: "Agregar repositorio…" }).click();
  await expect(page.getByRole("dialog").locator(".folder-entry")).toHaveCount(4);
  await shoot(page, testInfo, "11-server-folders", problems);
  await page.getByRole("button", { name: "Cerrar selector de carpetas" }).click();

  expect(problems).toEqual([]);
  expect(failures).toEqual([]);
});
