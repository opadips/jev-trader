import { experimental_evaluate } from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import type { BookRow } from "./db";
import type { Features, TradeIndex } from "./features";
import { profit } from "./config";

/**
 * Bump when the state or the question changes: forecasts are stored under `model@vN`, and the
 * analyzer scores only the latest version, so old and new prompts are never mixed.
 */
export const PROMPT_VERSION = 2;

const r0 = (x: number) => Math.round(x);
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

/**
 * What Jev sees, and nothing else. Kept small on purpose (tokens are the cost): summaries only,
 * no raw trade or price-level lists (v1 sent both and cost ~3x more per call).
 */
export function jevState(f: Features, book: BookRow, _trades?: TradeIndex) {
  const band = (k: string) => [r0(f.depth[k]?.bid ?? 0), r0(f.depth[k]?.ask ?? 0)];
  return {
    horizonBlocks: profit.horizonBlocks,
    flatBps: profit.flatBps,
    kuru: {
      spreadBps: r1(f.spreadBps),
      imbalance: Math.round(f.imbalance * 100) / 100,
      touchMon: [r0(book.bids[0]?.[1] ?? 0), r0(book.asks[0]?.[1] ?? 0)],
      depthMon: { "10bps": band("10"), "25bps": band("25"), "50bps": band("50") },
      returnsBps: { "1": r1(f.retBps.b1), "5": r1(f.retBps.b5), "20": r1(f.retBps.b20), "100": r1(f.retBps.b100) },
      volBps: r1(f.volBps),
    },
    takerMon: { last20: [r0(f.flow.b20.buyMon), r0(f.flow.b20.sellMon)], last100: [r0(f.flow.b100.buyMon), r0(f.flow.b100.sellMon)] },
    otherExchanges: f.ref.venues
      ? { premiumChange20Bps: r1(f.ref.premiumChg20Bps), returnsBps: { "5": r1(f.ref.refRetBps.b5), "20": r1(f.ref.refRetBps.b20) } }
      : null,
  };
}

const question = (flatBps: number) => ({
  type: "choice",
  instructions: {
    question: "Kuru MON-USDC mid after `horizonBlocks` blocks (0.3 s each) vs now: up, down or flat?",
    context: "Pairs are [bid side, ask side] or [taker buys, taker sells] in MON. `returnsBps` keys are lookbacks in blocks. `otherExchanges` (Bybit, OKX) carry most MON volume and usually move first; Kuru follows.",
  },
  criteria: {
    up: `more than ${flatBps} bps above`,
    down: `more than ${flatBps} bps below`,
    flat: `within ${flatBps} bps`,
  },
} as const);

/** `confidence` is TypeSafe's own confidence in the answer, when it reports one. */
export interface Forecast { pUp: number; pDown: number; pFlat: number; choice: string; confidence: number | null; latencyMs: number; inputTokens: number }

export class JevForecaster {
  readonly name = `${profit.jevModelId}@v${PROMPT_VERSION}`;
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
