import { createAdapter } from './adapters.ts';
import { createServer } from './app.ts';
import { loadConfig } from './config.ts';
import { railSeed } from './seed.ts';

try {
  const config = loadConfig(process.env);
  const seed = railSeed(config.rail, process.env);
  const adapter = await createAdapter(config.rail, { env: process.env, now: () => new Date() });
  const server = createServer({
    ledger: config.ledgerPath,
    adapter,
    policy: seed.policy,
    demo: { currency: seed.currency, amountScale: seed.amountScale, payees: seed.payees },
  });
  server.listen(config.port, config.host, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config.port;
    console.log(`agent-pay api listening on http://${config.host}:${port} (rail=${config.rail}, ledger=${config.ledgerPath})`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (err) {
  console.error(`agent-pay api failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
