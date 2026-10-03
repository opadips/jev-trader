/**
 * Disk guard helpers for the VPS agent (deploy/vps-agent.sh runs them on every pass).
 *
 *   bun run src/profit/guard.ts tier <free_kb>               how worried to be, 0 (fine) to 4
 *   bun run src/profit/guard.ts prune <keep_hours> <db>...   drop old ref_ticks rows
 *
 * ref_ticks (every exchange quote, up to 4 a second per venue) is the biggest table and nothing
 * reads it: each book row already carries the quotes current at its block. Deleting old rows frees
 * pages SQLite reuses for new rows, so a database stops growing without a risky VACUUM.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

const GB = 1024 * 1024;

/** Free space (in KB, as `df -Pk` prints it) to a tier: 0 fine, 1 trim ticks, 2 stop the extra markets, 3 delete their data, 4 stop the control too. */
export function diskTier(freeKb: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(freeKb)) return 0; // never act on a failed read
  if (freeKb >= 9 * GB) return 0;
  if (freeKb >= 6 * GB) return 1;
  if (freeKb >= 3.5 * GB) return 2;
  if (freeKb >= 2 * GB) return 3;
  return 4;
}

/** Delete ref_ticks older than `keepHours` in small batches so the recorder's writes never wait long. Returns rows deleted. */
export function pruneTicks(path: string, keepHours: number, now = Date.now()): number {
  if (path !== ":memory:" && !existsSync(path)) return 0;
  const db = new Database(path);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    const cutoff = now - keepHours * 3_600_000;
    const del = db.prepare("DELETE FROM ref_ticks WHERE rowid IN (SELECT rowid FROM ref_ticks WHERE ts < ? LIMIT 5000)");
    let total = 0;
    for (;;) {
      const n = del.run(cutoff).changes;
      total += n;
      if (n < 5000) break;
      db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    }
    if (total > 0 && path !== ":memory:") db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // briefly waits for the recorder, so only when needed
    return total;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [cmd, a, ...rest] = process.argv.slice(2);
  if (cmd === "tier") console.log(diskTier(Number(a)));
  else if (cmd === "prune") for (const p of rest) console.log(`${p}: ${pruneTicks(p, Number(a))} old ticks deleted`);
  else { console.error("usage: guard.ts tier <free_kb> | prune <keep_hours> <db>..."); process.exit(2); }
}
