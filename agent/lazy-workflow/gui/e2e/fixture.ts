import { test as base, expect } from "@playwright/test";

// Keep the production HTTPS origin/cookie contract while using an isolated port.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route("https://localhost/**", async (route) => {
      const url = new URL(route.request().url());
      url.hostname = "127.0.0.1"; url.port = "18443";
      const response = await route.fetch({ url: url.href, headers: { ...route.request().headers(), host: "localhost" } });
      try {
        await route.fulfill({ response });
      } catch (error) {
        // Navigation/logout can cancel a background poll while its proxy fetch completes.
        if (!(error instanceof Error) || !error.message.includes("Route is already handled!")) throw error;
      }
    });
    await use(page);
    await page.unrouteAll({ behavior: "wait" });
  },
});
export { expect };
