import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ApiClientError, postApprove, postIntent } from '../src/client.ts';

const INTENT = {
  agentId: 'demo-agent',
  payee: 'openai-api',
  amount: 1,
  currency: 'USD',
  purpose: 'compat',
};

/**
 * Local 127.0.0.1 stub. Clients today copy only `body.error`, so the joined
 * "code: detail" message fails until postIntent/postApprove combine `message`.
 */
function serveJson(
  t: { after: (fn: () => Promise<void>) => void },
  status: number,
  json: unknown,
): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr !== 'object') {
        reject(new Error('expected a tcp port'));
        return;
      }
      t.after(
        () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      );
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

async function expectInProgress(run: () => Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof ApiClientError);
    assert.equal(err.status, 409);
    assert.equal(err.message, message);
    assert.equal(err.message.startsWith('in_progress'), true);
    return true;
  });
}

test('postIntent and postApprove join {error, message} into code: detail', async (t) => {
  const base = await serveJson(t, 409, { error: 'in_progress', message: 'intent x is submitting' });
  const expected = 'in_progress: intent x is submitting';
  await expectInProgress(() => postIntent(base, INTENT), expected);
  await expectInProgress(() => postApprove(base, 'pi_x', 'alice'), expected);
});

test('postIntent and postApprove keep an old single-field error body', async (t) => {
  const base = await serveJson(t, 409, { error: 'in_progress: y' });
  await expectInProgress(() => postIntent(base, INTENT), 'in_progress: y');
  await expectInProgress(() => postApprove(base, 'pi_x', 'alice'), 'in_progress: y');
});
