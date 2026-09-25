---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## The core message (do not break this)

This section governs Demo Mode: `src/*.ts` and `web/`. Profit Mode (`src/profit/`) has its own rules below.

The demo exists to support this tweet. Every design or strategy change must keep all four claims true:

> I built a trading bot with Jev!
>
> Jev decides if it should "buy" or "sell", given the price feed of an asset pair, and executes real trades.
>
> It uses Monad to place the orders on Kuru's on-chain order book in every 300ms block.
>
> Demo link: https://jev-trader.vercel.app

Non-negotiables: Jev makes the buy/sell call (not code), from the price feed; real trades from a real wallet; an order placed on Kuru's on-chain book every 300 ms block; the demo is the live dashboard. Never decide every N blocks. No middle dots, em dashes or en dashes in any rendered text. No blinking or pulsing indicators.

## Profit Mode (`src/profit/`, see docs/PROFIT.md)

A separate mode whose only goal is to find out whether a bot on Kuru MON-USDC can make money. The demo rules above (every block, Jev decides alone) do not apply to it, and it must never change Demo Mode behavior.

- Nothing in Profit Mode signs or sends a transaction until the user explicitly approves going live. Today it records and analyzes; later phases paper trade.
- Move through the phases in docs/PROFIT.md in order, and justify every strategy choice with `bun run analyze` numbers. Count every cost: gas on the limit (charged even on reverts), Kuru fees, one block of latency, the fills we would not get.
- Jev earns a role only by beating simple baselines out of sample. Report what the data says, including "no edge".
- Changes to shared modules (`chain.ts`, `book.ts`, `trades.ts`, `config.ts`) stay backward compatible with the demo.
- `bun test` must pass. Keep the analysis in pure functions with tests; use `src/profit/synth.ts` and `scripts/fake-rpc.ts` to test without a live chain.
- Keep docs/PROGRESS.md current: update it at the end of every work session (phase table, done, decisions, waiting on the user, next).
- The server is reached only through GitHub (docs/VPS-SETUP.md): it deploys the `vps` branch when `bun test` passes and pushes status to the reports repo. Never add a way to run arbitrary commands on it through git.
- The server it runs on is shared with other services: unprivileged user, loopback-only ports, resource limits (deploy/jev-recorder.service). Never commit `.env` or any key.
