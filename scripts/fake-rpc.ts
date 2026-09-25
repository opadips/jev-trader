/**
 * A tiny stand-in for the Monad RPC, for smoke-testing the recorder offline: a new block every
 * 300 ms, a random-walk MON-USDC book behind getL2Book, an inactive vault, market params, and no logs.
 *
 *   bun run scripts/fake-rpc.ts 8545
 *   RPC_URL=http://127.0.0.1:8545 READ_RPC_URL=http://127.0.0.1:8545 WS_URL= bun run record
 */
import { ethers } from "ethers";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";

const port = Number(process.argv[2] ?? 8545);
const iface = new ethers.utils.Interface(OrderBookAbi.abi);
const PRICE_DEC = 8, SIZE_DEC = 10;
let block = 100_000_000, mid = 0.0226;
setInterval(() => { block++; mid *= 1 + (Math.random() - 0.5) * 4e-4; }, 300);

const word = (x: bigint) => x.toString(16).padStart(64, "0");
const units = (x: number, d: number) => BigInt(Math.round(x * 10 ** d));

function l2Book() {
  const tick = 1e-6, bid = Math.floor((mid - 4 * tick) / tick) * tick, ask = bid + 8 * tick;
  let payload = word(BigInt(block));
  for (let i = 0; i < 5; i++) payload += word(units(bid - i * tick, PRICE_DEC)) + word(units(2000 + i * 500, SIZE_DEC));
  payload += word(0n);
  for (let i = 4; i >= 0; i--) payload += word(units(ask + i * tick, PRICE_DEC)) + word(units(1500 + i * 500, SIZE_DEC));
  const len = payload.length / 2;
  return "0x" + word(32n) + word(BigInt(len)) + payload.padEnd(Math.ceil(payload.length / 64) * 64, "0");
}

const marketParams = () => iface.encodeFunctionResult("getMarketParams", [
  10n ** 8n, 10n ** 10n, ethers.constants.AddressZero, 18, "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", 6, 100, 200n * 10n ** 10n, 10n ** 20n, 3, 0,
]);

function handle(req: { id: number; method: string; params: any[] }) {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "eth_chainId": return ok("0x8f");
    case "net_version": return ok("143");
    case "eth_blockNumber": return ok("0x" + block.toString(16));
    case "eth_getLogs": return ok([]);
    case "eth_call": {
      const sel = String(req.params[0].data).slice(0, 10);
      if (sel === "0x46fdfbb1") return ok(l2Book());
      if (sel === "0x88bb4f60") return ok("0x" + word(0n).repeat(8));
      if (sel === iface.getSighash("getMarketParams")) return ok(marketParams());
      return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: `unknown selector ${sel}` } };
    }
    default: return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `unsupported ${req.method}` } };
  }
}

Bun.serve({
  hostname: "127.0.0.1", port,
  async fetch(r) {
    const body = await r.json();
    return Response.json(Array.isArray(body) ? body.map(handle) : handle(body));
  },
});
console.log(`fake monad rpc on http://127.0.0.1:${port}`);
