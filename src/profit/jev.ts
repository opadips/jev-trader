import { experimental_evaluate } from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import type { BookRow } from "./db";
import type { Features, TradeIndex } from "./features";
import { profit } from "./config";

/**
 * The question Jev is asked. Bump `version` whenever the state, wording, horizon or flat band
 * changes: forecasts are stored as `model@vN` and the analyzer scores only the newest version.
 *
 * v1, v2 (2026-09-25): 100 blocks (~30 s), flat within 5 bps. Day 1 verdict: no skill, worse
 *   than always guessing the most common outcome.
 * v3 (2026-09-26): 10 blocks (~3 s), flat within 2 bps. The one pattern the data shows is that
 *   Kuru follows Bybit/OKX within a few blocks (~60% of their move within 3 blocks), so this asks
 *   about the window where that lead lives.
 */
export const QUESTION = { version: 3, horizonBlocks: 10, flatBps: 2 } as const;

const r0 = (x: number) => Math.round(x);
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

/**
 * What Jev sees, and nothing else. Kept small on purpose (tokens are the cost): summaries only,
 * no raw trade or price-level lists.
 */
export function jevState(f: Features, book: BookRow, _trades?: TradeIndex) {
  return {
    horizonBlocks: QUESTION.horizonBlocks,
    flatBps: QUESTION.flatBps,
    kuru: {
      spreadBps: r1(f.spreadBps),
      imbalance: Math.round(f.imbalance * 100) / 100,
      touchMon: [r0(book.bids[0]?.[1] ?? 0), r0(book.asks[0]?.[1] ?? 0)],
      returnsBps: { "1": r1(f.retBps.b1), "5": r1(f.retBps.b5), "20": r1(f.retBps.b20) },
    },
    takerMon: { last20: [r0(f.flow.b20.buyMon), r0(f.flow.b20.sellMon)] },
    otherExchanges: f.ref.venues
      ? {
        returnsBps: { "1": r1(f.ref.refRetBps.b1), "3": r1(f.ref.refRetBps.b3), "5": r1(f.ref.refRetBps.b5), "20": r1(f.ref.refRetBps.b20) },
        notYetFollowedBps: { "5": r1(f.ref.premiumChg5Bps), "20": r1(f.ref.premiumChg20Bps) },
      }
      : null,
  };
}

const question = () => ({
  type: "choice",
  instructions: {
    question: "Kuru MON-USDC mid after `horizonBlocks` blocks (0.3 s each, so ~3 s) vs now: up, down or flat?",
    context: "Bybit and OKX (`otherExchanges`) carry most MON volume and lead Kuru by about a block: Kuru usually makes ~60% of their move within 3 blocks. `notYetFollowedBps` is how far they moved relative to Kuru over the last 5 / 20 blocks (positive: they rose and Kuru has not caught up). Pairs are [bid side, ask side] or [taker buys, taker sells] in MON; `returnsBps` keys are lookbacks in blocks.",
  },
  criteria: {
    up: `more than ${QUESTION.flatBps} bps above`,
    down: `more than ${QUESTION.flatBps} bps below`,
    flat: `within ${QUESTION.flatBps} bps`,
  },
} as const);

/** `confidence` is TypeSafe's own confidence in the answer, when it reports one. */
export interface Forecast { pUp: number; pDown: number; pFlat: number; choice: string; confidence: number | null; latencyMs: number; inputTokens: number }

export class JevForecaster {
  readonly name = `${profit.jevModelId}@v${QUESTION.version}`;
  private model;

  /** `fetch` and `baseURL` are for tests; the API key comes from TYPESAFE_AI_API_KEY. */
  constructor(opts: { fetch?: typeof fetch; baseURL?: string } = {}) {
    this.model = createTypeSafeAi(opts).evaluationModel(profit.jevModelId);
  }

  async forecast(state: ReturnType<typeof jevState>): Promise<Forecast> {
    const t0 = performance.now();
    const r = await experimental_evaluate({ model: this.model, state: state as any, questions: { direction: question() }, maxRetries: 0, abortSignal: AbortSignal.timeout(5000) });
    const a = r.answers.direction;
    const p = a.probabilities ?? { up: 0, down: 0, flat: 0, [a.choice]: 1 };
    const confidence = (r.providerMetadata?.typesafe as { confidence?: Record<string, number> } | undefined)?.confidence?.direction ?? null;
    return { pUp: p.up ?? 0, pDown: p.down ?? 0, pFlat: p.flat ?? 0, choice: a.choice, confidence, latencyMs: Math.round(performance.now() - t0), inputTokens: r.usage?.inputTokens ?? 0 };
  }
}
