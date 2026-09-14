/**
 * A stand-in for a 1BILL billing partner.
 *
 * WHY THIS EXISTS. The real partner API is behind a commercial onboarding pack, so there
 * is no sandbox to point at until CARE has a contract. Without something to call, the
 * 1BILL adapter could only ever be *inspected*, and "it looks right" is not a test. This
 * answers the two calls the adapter makes — register a bill, ask a bill's status — so
 * the whole path runs for real: HTTP out, JSON in, the consumer number stored on the
 * invoice, the callback verified, the payment recorded, the plan applied.
 *
 * WHAT IT DOES NOT PROVE. It answers in the shape this adapter currently expects, which
 * is a documented guess at a partner's field names, not the partner's actual contract.
 * It proves the plumbing, the failure handling and the idempotency — everything that is
 * ours. It cannot prove the field names, and passing here is not evidence that a real
 * partner would be satisfied. Correct the three marked blocks in `onebill.provider.ts`
 * against the partner's spec before go-live; these tests will still pass afterwards,
 * because they drive the adapter rather than the field names.
 *
 * Endpoints:
 *   POST /bills                 register a bill        → { consumer_number, status }
 *   GET  /bills/:id             status inquiry         → { status, amount_minor, ... }
 *   POST /_control/pay/:id      mark a bill paid       (test-only side channel)
 *   POST /_control/fail         next call 500s once    (test-only side channel)
 *   POST /_control/hang         next call never answers (test-only side channel)
 *   GET  /_control/bills        everything it holds    (test-only side channel)
 */
import http from 'node:http';

const bills = new Map();
let failNext = false;
let hangNext = false;

const json = (res, code, body) => {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
  res.end(payload);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });

export function startSimulator(port = 3999) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = url.pathname;

    // --- test-only controls -------------------------------------------------
    if (path === '/_control/fail' && req.method === 'POST') {
      failNext = true;
      return json(res, 200, { ok: true });
    }
    if (path === '/_control/hang' && req.method === 'POST') {
      hangNext = true;
      return json(res, 200, { ok: true });
    }
    if (path === '/_control/bills' && req.method === 'GET') {
      return json(res, 200, { bills: [...bills.values()] });
    }
    if (path.startsWith('/_control/amount/') && req.method === 'POST') {
      // Rewrite what the partner BELIEVES the bill is worth, so a unit mismatch — the
      // partner quoting rupees where we sent paisa — can actually be exercised.
      const id = decodeURIComponent(path.slice('/_control/amount/'.length));
      const bill = bills.get(id);
      if (!bill) return json(res, 404, { error: 'no such bill' });
      const body = await readBody(req);
      bill.amount_minor = body.amount_minor;
      return json(res, 200, bill);
    }
    if (path.startsWith('/_control/pay/') && req.method === 'POST') {
      const id = decodeURIComponent(path.slice('/_control/pay/'.length));
      const bill = bills.get(id);
      if (!bill) return json(res, 404, { error: 'no such bill' });
      const body = await readBody(req);
      bill.status = 'PAID';
      bill.paid = true;
      bill.transaction_id = body.transaction_id ?? `TXN${Date.now()}`;
      bill.paid_at = new Date().toISOString();
      return json(res, 200, bill);
    }

    // --- injected faults, consumed once -------------------------------------
    if (hangNext) {
      hangNext = false;
      // Accept the connection and never answer. This is the failure a timeout exists
      // for, and the one that hurts most without it.
      return;
    }
    if (failNext) {
      failNext = false;
      return json(res, 500, { error: 'simulated partner failure' });
    }

    // --- the two calls the adapter actually makes ---------------------------
    if (path === '/bills' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.consumer_number || body.amount === undefined) {
        return json(res, 400, { error: 'consumer_number and amount are required' });
      }
      // A real partner assigns its own number. Returning a DIFFERENT one from what was
      // sent is deliberate: it proves the application stores the partner's answer rather
      // than assuming its own guess was accepted.
      const assigned = `9${String(body.consumer_number).slice(-9)}`;
      const bill = {
        consumer_number: assigned,
        bill_reference: body.bill_reference,
        amount_minor: body.amount,
        currency: body.currency,
        due_date: body.due_date,
        status: 'UNPAID',
        paid: false,
      };
      bills.set(assigned, bill);
      return json(res, 201, { consumer_number: assigned, status: 'UNPAID' });
    }

    if (path.startsWith('/bills/') && req.method === 'GET') {
      const id = decodeURIComponent(path.slice('/bills/'.length));
      const bill = bills.get(id);
      if (!bill) return json(res, 404, { error: 'no such bill' });
      return json(res, 200, bill);
    }

    return json(res, 404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      server,
      port,
      reset: () => {
        bills.clear();
        failNext = false;
        hangNext = false;
      },
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}
