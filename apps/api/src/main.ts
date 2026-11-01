import { createAdapter } from './adapters.ts';
import { createServer } from './app.ts';
import { loadConfig } from './config.ts';
import { railSeed } from './seed.ts';
import { formatStartupError } from './startup-error.ts';

/** Prints names-only startup errors (see startup-error.ts) and exits 1 without a stack trace. */
function failStart(err: unknown, rail?: string): never {
  for (const line of formatStartupError(err, process.env, rail)) console.error(line);
  process.exit(1);
}

let rail: string | undefined;
try {
  const config = loadConfig(process.env);
  rail = config.rail;
  const seed = railSeed(config.rail, process.env);
  const adapter = await createAdapter(config.rail, { env: process.env, now: () => new Date() });
  const server = createServer({
    ledger: config.ledgerPath,
    adapter,
    policy: seed.policy,
    demo: { currency: seed.currency, amountScale: seed.amountScale, payees: seed.payees },
    ...(config.receiptPoll ? { receiptPoll: config.receiptPoll } : {}),
  });
  server.on('error', (err) => failStart(err, config.rail));
  server.listen(config.port, config.host, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config.port;
    console.log(`agent-pay api listening on http://${config.host}:${port} (rail=${config.rail}, ledger=${config.ledgerPath})`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (err) {
  failStart(err, rail);
}
