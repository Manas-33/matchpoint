// The spikes share the app's fixture helpers (lib/fixtures.ts); saving also logs the path.
import { saveFixture as save } from "../../../lib/fixtures.js";

export { listFixtures, loadFixture, slug } from "../../../lib/fixtures.js";

export function saveFixture(path: string, data: unknown): string {
  const file = save(path, data);
  console.log(`  saved ${file}`);
  return file;
}
