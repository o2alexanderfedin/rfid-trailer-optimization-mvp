import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

/** A 1×1 transparent PNG, served in place of every OpenStreetMap tile. */
const BLANK_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function isExternal(url: URL): boolean {
  return url.hostname !== "localhost" && url.hostname !== "127.0.0.1";
}

/**
 * `test` for the hermetic e2e projects: no request leaves the machine.
 *
 * The page still ASKS for its OpenStreetMap tiles (so `page.on("request")`
 * sees the real https tile URLs), but each one is answered with a blank PNG
 * instead of being downloaded. Any other off-machine request is aborted.
 * Routes a spec registers itself (e.g. `**\/api/hubs`) take precedence.
 */
export const test = base.extend<{ noExternalNetwork: undefined }>({
  noExternalNetwork: [
    async ({ page }, use) => {
      await page.route(isExternal, async (route) => {
        if (new URL(route.request().url()).hostname.endsWith("tile.openstreetmap.org")) {
          await route.fulfill({ status: 200, contentType: "image/png", body: BLANK_TILE });
        } else {
          await route.abort("internetdisconnected");
        }
      });
      await use(undefined);
    },
    { auto: true },
  ],
});
