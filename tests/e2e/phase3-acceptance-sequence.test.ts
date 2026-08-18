import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import puppeteer, { Browser, WebWorker } from 'puppeteer';
import { startTestServers, TestServerInstances } from '../pages/server';
import { chromeExecutable } from '../support/chrome-executable';

interface ExperimentState {
  hypothesisId: string;
  documentId: string;
  navigationEpoch: number;
  candidate: { actions: Array<{ type: string }> };
  record: {
    id: string;
    status: string;
    transactionId: string;
    rollbackVerified: boolean;
    healthDelta?: number;
    privacyScore?: number;
    policyDecisionId?: string;
  };
}

describe('Phase 3 original acceptance sequence in real Chromium', () => {
  let browser: Browser;
  let servers: TestServerInstances;
  let worker: WebWorker;
  const extensionPath = path.resolve(__dirname, '../../dist');

  beforeAll(async () => {
    servers = await startTestServers(4030, 4031);
    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromeExecutable(),
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--headless=new', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox'],
    });
    const target = await browser.waitForTarget(
      (item) => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'),
      { timeout: 10_000 }
    );
    const resolved = await target.worker();
    if (!resolved) throw new Error('extension service worker unavailable');
    worker = resolved;
  });

  afterAll(async () => {
    await browser?.close();
    await servers?.close();
  });

  async function experimentStates(): Promise<ExperimentState[]> {
    return worker.evaluate(async () => {
      const value = await chrome.storage.session.get('adapt_causal_experiments_v1');
      return Object.values(
        (value.adapt_causal_experiments_v1 ?? {}) as Record<string, ExperimentState>
      );
    });
  }

  it('rolls back the lower-value hypothesis before supporting the true mechanism', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('http://localhost:4030/t29-phase3-acceptance/index.html', { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 3200));

    // The belief row for the rolled-back hypothesis is persisted after the
    // experiment records and the follow-up staging path, so poll for the fully
    // settled sequence instead of trusting a single fixed wait.
    let states: ExperimentState[] = [];
    let causalSession: unknown;
    let wrongBelief: { alpha: number; beta: number } | undefined;
    const settleDeadline = Date.now() + 10_000;
    for (;;) {
      states = (await experimentStates()).sort(
        (left, right) => left.record.id.localeCompare(right.record.id, undefined, { numeric: true })
      );
      causalSession = await worker.evaluate(async () => {
        const value = await chrome.storage.session.get('adapt_causal_session_state_v1');
        return value.adapt_causal_session_state_v1;
      });
      const rows = (causalSession as {
        belief?: { beliefs?: Array<[string, { alpha: number; beta: number }]> };
      })?.belief?.beliefs ?? [];
      wrongBelief = rows.find(([key]) => key.includes('SCROLL_LOCK_REACTION'))?.[1];
      const settled =
        states.length >= 2 &&
        states[0]?.record.status === 'ROLLED_BACK' &&
        states[1]?.record.status === 'COMMITTED' &&
        wrongBelief !== undefined;
      if (settled || Date.now() >= settleDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(states.length, JSON.stringify({ states, causalSession }, null, 2)).toBeGreaterThanOrEqual(2);
    console.log('ACCEPTANCE_STATES_DEBUG', JSON.stringify(states.map((state) => ({
      id: state.record.id,
      status: state.record.status,
      hypothesisId: state.hypothesisId,
      actionTypes: state.candidate.actions.map((action) => action.type),
      rollbackVerified: state.record.rollbackVerified,
      healthDelta: state.record.healthDelta,
      privacyScore: state.record.privacyScore,
      policyDecisionId: state.record.policyDecisionId,
      primitiveId: (state.record as { primitiveId?: string }).primitiveId,
      txId: state.record.transactionId,
    })), null, 2));
    console.log('ACCEPTANCE_BELIEFS_DEBUG', JSON.stringify((causalSession as {
      belief?: { beliefs?: Array<[string, { alpha: number; beta: number }]> };
    })?.belief?.beliefs ?? [], null, 2));
    expect(
      wrongBelief?.beta,
      JSON.stringify(
        {
          beliefRows: (causalSession as {
            belief?: { beliefs?: Array<[string, { alpha: number; beta: number }]> };
          })?.belief?.beliefs ?? [],
          states,
        },
        null,
        2
      )
    ).toBeGreaterThan(wrongBelief?.alpha ?? Number.POSITIVE_INFINITY);
    expect(states[0]?.candidate.actions.some((action) => action.type === 'DOM_RESTORE_SCROLL')).toBe(true);
    expect(states[0]?.record.status).toBe('ROLLED_BACK');
    expect(states[0]?.record.rollbackVerified).toBe(true);
    expect(states[1]?.candidate.actions.some((action) => action.type === 'DOM_PRESERVE_BAIT_CANDIDATE')).toBe(true);
    expect(states[1]?.record.status).toBe('COMMITTED');
    expect(states[1]?.record.rollbackVerified).toBe(true);
    expect(states[1]?.record.privacyScore).toBeGreaterThanOrEqual(0.9);
    expect(states[1]?.record.healthDelta).toBeGreaterThan(0);

    const pageState = await page.evaluate(() => ({
      trueMechanismObserved: Boolean((window as typeof window & { __phase3_true_mechanism_observed?: boolean }).__phase3_true_mechanism_observed),
    }));
    expect(pageState.trueMechanismObserved).toBe(true);
    console.log('PHASE3_SEQUENCE_EVIDENCE', JSON.stringify({
      fixture: 't29-phase3-acceptance',
      wrong: {
        experimentRef: states[0]?.record.id,
        transactionId: states[0]?.record.transactionId,
        documentId: states[0]?.documentId,
        epoch: states[0]?.navigationEpoch,
        policyDecisionId: states[0]?.record.id ? `policy:${states[0].record.id}` : undefined,
        status: states[0]?.record.status,
        rollbackVerified: states[0]?.record.rollbackVerified,
      },
      true: {
        experimentRef: states[1]?.record.id,
        transactionId: states[1]?.record.transactionId,
        documentId: states[1]?.documentId,
        epoch: states[1]?.navigationEpoch,
        policyDecisionId: states[1]?.record.id ? `policy:${states[1].record.id}` : undefined,
        status: states[1]?.record.status,
        rollbackVerified: states[1]?.record.rollbackVerified,
        healthDelta: states[1]?.record.healthDelta,
        privacyScore: states[1]?.record.privacyScore,
      },
    }));
    await page.close();
  }, 25_000);
});
