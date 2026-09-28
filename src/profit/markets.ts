/**
 * The extra Kuru markets recorded next to the MON-USDC control (which keeps its own recorder,
 * database and Jev experiment, untouched). Chosen from the on-chain survey (survey.ts); each gets
 * its own database under data/markets/.
 */
import type { VenueSpec } from "./config";

/** Exchange symbols for each reference asset. A venue that does not list one simply stays silent. */
export const REFERENCE_VENUES: Record<string, VenueSpec[]> = {
  MON: [{ venue: "bybit", symbol: "MONUSDT" }, { venue: "okx", symbol: "MON-USDT" }, { venue: "coinbase", symbol: "MON-USD" }],
  BTC: [{ venue: "binance", symbol: "BTCUSDT" }, { venue: "bybit", symbol: "BTCUSDT" }, { venue: "okx", symbol: "BTC-USDT" }, { venue: "coinbase", symbol: "BTC-USD" }],
  ETH: [{ venue: "binance", symbol: "ETHUSDT" }, { venue: "bybit", symbol: "ETHUSDT" }, { venue: "okx", symbol: "ETH-USDT" }, { venue: "coinbase", symbol: "ETH-USD" }],
  XAUT: [{ venue: "bybit", symbol: "XAUTUSDT" }, { venue: "okx", symbol: "XAUT-USDT" }],
};

export interface ExtraMarket {
  /** Short name used for files: data/markets/<slug>.sqlite, reports markets/<slug>.* */
  slug: string;
  address: string;
  pair: string;
  /** Key into REFERENCE_VENUES. */
  reference: keyof typeof REFERENCE_VENUES;
}

/**
 * Survey of 2026-09-28 (every Kuru Trade log over 1 h, no address filter): only four markets traded
 * at all. MON/USDC is the control; these are the other three. MON/AUSD, AUSD/USDC and emo/MON had
 * no trades and empty books.
 *   cbBTC/USDC  $324k/h, 1,036 trades/h, 21 takers, spread 3.4 bps, $167k within 10 bps
 *   WETH/USDC   $268k/h,   725 trades/h, 30 takers, spread 1.9 bps,  $67k within 10 bps
 *   XAUt0/USDC   $93k/h,   658 trades/h, 51 takers, spread 0.6 bps,  $55k within 10 bps
 */
export const EXTRA_MARKETS: ExtraMarket[] = [
  { slug: "cbbtc-usdc", address: "0x40c49f171202f91ff5d2fae34c22dd2bfdd22af0", pair: "cbBTC/USDC", reference: "BTC" },
  { slug: "weth-usdc", address: "0xa6afd386135b7d41a6c40c525abc4a1019b0d132", pair: "WETH/USDC", reference: "ETH" },
  { slug: "xaut0-usdc", address: "0x851145eaefdc37956b08da829fa31722199f3f07", pair: "XAUt0/USDC", reference: "XAUT" },
];

/**
 * Book reads per market happen every `SAMPLE_EVERY` blocks (trade logs are read for every block
 * regardless), to stay inside the public RPC's ~25 requests/s next to the control recorder.
 */
export const SAMPLE_EVERY = 2;

export const dbPathFor = (slug: string) => `data/markets/${slug}.sqlite`;
