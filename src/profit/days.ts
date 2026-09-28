/**
 * Finished UTC days in the recording (today excluded), one per line, oldest first. The VPS agent
 * analyzes each once and keeps the result, so the reports never re-read the whole database.
 *
 *   bun run src/profit/days.ts
 */
import { profit } from "./config";
import { Store } from "./db";

if (await Bun.file(profit.dbPath).exists()) {
  const store = new Store(profit.dbPath, { readonly: true });
  const today = new Date().toISOString().slice(0, 10);
  for (const d of store.days()) if (d.day < today) console.log(d.day);
  store.close();
}
