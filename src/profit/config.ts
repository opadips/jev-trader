import { config as base } from "../config";

const env = (key: string, fallback: string) => process.env[key] ?? fallback;

/** A reference venue: an exchange whose MON price we watch to see where Kuru is likely to go. */
export interface VenueSpec { venue: string; symbol: string }

/** "binance:MONUSDT,okx:MON-USDT" -> [{ venue: "binance", symbol: "MONUSDT" }, ...]. A bare venue name uses its default symbol. */
export function parseVenues(spec: string, defaults: Record<string, string>): VenueSpec[] {
  return spec.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [venue, symbol] = s.split(":") as [string, string | undefined];
    const v = venue.toLowerCase();
    return { venue: v, symbol: symbol ?? defaults[v] ?? "" };
  });
}

export const DEFAULT_SYMBOLS: Record<string, string> = { binance: "MONUSDT", bybit: "MONUSDT", okx: "MON-USDT", coinbase: "MON-USD" };

/**
 * Profit Mode (research phase). Shares RPC and market settings with the demo (`src/config.ts`),
 * never signs or sends anything: it records the market and asks Jev for forecasts so we can
 * measure whether any edge exists before a strategy touches money.
 */
export const profit = {
  rpcUrl: base.readRpcUrl,
  wsUrl: base.wsUrl,
  market: base.market,
  dbPath: env("PROFIT_DB", "data/profit.sqlite"),
  /** Reference venues and symbols. Venues that do not list MON simply never produce data (visible in /health). */
  venues: parseVenues(env("REF_VENUES", "binance,bybit,okx,coinbase"), DEFAULT_SYMBOLS),
  /** Store at most one reference tick per venue per this many ms (every Kuru book row also carries a snapshot). */
  refTickMs: Number(env("REF_TICK_MS", "250")),
  /**
   * Ask Jev every N recorded blocks. 50 (every ~15 s) is ~240 forecasts an hour, each about an
   * independent window. The horizon and flat band belong to the question (jev.ts). 0 turns Jev off.
   */
  jevEvery: Number(env("JEV_EVERY", "50")),
  jevModelId: base.jevModelId,
  jevUsdPerMTok: base.jevUsdPerMTok,
  jevMaxInflight: 2,
  /** Health endpoint. Loopback by default so nothing is exposed on a shared server. */
  healthHost: env("HEALTH_HOST", "127.0.0.1"),
  healthPort: Number(env("HEALTH_PORT", "3101")),
  /** A book older than this makes /health return 503. */
  staleMs: 10_000,
};

export const hasJev = () => profit.jevEvery > 0 && !!process.env.TYPESAFE_AI_API_KEY;
