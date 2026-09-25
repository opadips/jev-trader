/**
 * Write a synthetic recording (Kuru lags the reference by 3 rows, a forecaster with some skill) so
 * the analyzer can be tried without a live feed:
 *
 *   bun run scripts/profit-synth.ts data/synth.sqlite && bun run analyze --db data/synth.sqlite
 */
import { Store } from "../src/profit/db";
import { synth } from "../src/profit/synth";

const path = process.argv[2] ?? "data/synth.sqlite";
const store = new Store(path);
const { books, trades, preds } = synth({ rows: 24_000 });
store.setMeta("market", { takerFeeBps: 3, makerFeeBps: 0, synthetic: true });
for (const b of books) store.addBook(b);
for (const t of trades) store.addTrade(t);
for (const p of preds) store.addPrediction(p);
console.log(`wrote ${store.flush()} synthetic rows to ${path}`);
store.close();
