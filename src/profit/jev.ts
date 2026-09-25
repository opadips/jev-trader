import { experimental_evaluate } from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import type { BookRow } from "./db";
import type { Features, TradeIndex } from "./features";
import { profit } from "./config";

/** What Jev sees. Everything Jev is told about is in here and nothing else. */
export function jevState(f: Features, book: BookRow, trades: TradeIndex) {
  const lvl = (l: [number, number]) => `${l[0].toFixed(6)} x ${Math.round(l[1])}`;
  return {
    market: "MON-USDC on Kuru (Monad on-chain order book)",
    horizonBlocks: profit.horizonBlocks,
    horizonSeconds: Math.round(profit.horizonBlocks * 0.3),
    flatBps: profit.flatBps,
    kuru: {
      mid: f.mid, spreadBps: f.spreadBps, bookImbalance: f.imbalance, depthMon: f.depth,
      bids: book.bids.slice(0, 5).map(lvl), asks: book.asks.slice(0, 5).map(lvl),
      returnsBps: f.retBps, volatilityBps: f.volBps,
    },
    takerFlow: {
      last20Blocks: f.flow.b20, last100Blocks: f.flow.b100,
      recent: trades.recent(book.block, 10).map((t) => `${book.block - t.block} blocks ago: taker ${t.side} ${Math.round(t.size)} @ ${t.price.toFixed(6)}`),
    },
    otherExchanges: f.ref.venues
      ? { venuesLive: f.ref.venues, premiumBps: f.ref.premiumBps, premiumChangeLast20BlocksBps: f.ref.premiumChg20Bps, returnsBps: f.ref.refRetBps }
      : "no live data",
  };
}

const question = (flatBps: number) => ({
  type: "choice",
  instructions: {
    question: "Where will the Kuru MON-USDC mid be after `horizonBlocks` more blocks (about `horizonSeconds` seconds) relative to `kuru.mid` now: up, down, or flat?",
    goal: "A forecast for a trading strategy on Kuru. It is scored against what actually happens, and moves inside the flat band are worth nothing, so only call up or down when a move bigger than `flatBps` is more likely than not.",
    inputs: "`otherExchanges` is MON on centralized exchanges, which carry most MON volume and usually move first: `premiumBps` is how much dearer MON is there than on Kuru (it has a steady currency basis, so `premiumChangeLast20BlocksBps` and `returnsBps` matter more). `takerFlow` shows who is hitting the Kuru book. `kuru.depthMon`, `bids` and `asks` show resting liquidity; thin depth on one side means price moves more easily that way.",
  },
  criteria: {
    up: `The mid will be more than ${flatBps} bps above the current mid.`,
    down: `The mid will be more than ${flatBps} bps below the current mid.`,
    flat: `The mid will be within ${flatBps} bps of the current mid.`,
  },
} as const);

/** `confidence` is TypeSafe's own confidence in the answer, when it reports one. */
export interface Forecast { pUp: number; pDown: number; pFlat: number; choice: string; confidence: number | null; latencyMs: number; inputTokens: number }

export class JevForecaster {
  readonly name = profit.jevModelId;
  private model;

  /** `fetch` and `baseURL` are for tests; the API key comes from TYPESAFE_AI_API_KEY. */
  constructor(opts: { fetch?: typeof fetch; baseURL?: string } = {}) {
    this.model = createTypeSafeAi(opts).evaluationModel(profit.jevModelId);
  }

  async forecast(state: ReturnType<typeof jevState>): Promise<Forecast> {
    const t0 = performance.now();
    const r = await experimental_evaluate({ model: this.model, state: state as any, questions: { direction: question(profit.flatBps) }, maxRetries: 0, abortSignal: AbortSignal.timeout(5000) });
    const a = r.answers.direction;
    const p = a.probabilities ?? { up: 0, down: 0, flat: 0, [a.choice]: 1 };
    const confidence = (r.providerMetadata?.typesafe as { confidence?: Record<string, number> } | undefined)?.confidence?.direction ?? null;
    return { pUp: p.up ?? 0, pDown: p.down ?? 0, pFlat: p.flat ?? 0, choice: a.choice, confidence, latencyMs: Math.round(performance.now() - t0), inputTokens: r.usage?.inputTokens ?? 0 };
  }
}
