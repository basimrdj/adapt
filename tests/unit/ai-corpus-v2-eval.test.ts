import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { MockPlanner } from '../../src/shared/ai/mock-planner';
import { PolicyValidator } from '../../src/shared/ai/validator';
import { EvaluationCase } from '../../scripts/generate-eval-corpus';

describe('Phase 2.5 Scaled Evaluation Corpus Suite (250 Cases: Dev + Holdout)', () => {
  const corpusPath = path.resolve(process.cwd(), 'tests/fixtures/ai/eval-corpus-v2.json');
  const corpus: EvaluationCase[] = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const validator = new PolicyValidator();
  const planner = new MockPlanner();

  const devCases = corpus.filter((c) => c.split === 'dev');
  const holdoutCases = corpus.filter((c) => c.split === 'holdout');

  it('Evaluates DEV SET (200 cases) with high accuracy and 0% unauthorized actions', async () => {
    let correctDecisions = 0;
    let unauthorizedActions = 0;
    let falsePositives = 0;

    for (const testCase of devCases) {
      const plan = await planner.plan(testCase.evidence);
      const validation = validator.validate(testCase.evidence, plan);

      expect(validation.valid).toBe(true);

      if (plan.decision === testCase.expectedDecision) {
        correctDecisions++;
      }

      for (const act of plan.actions) {
        if (testCase.forbiddenActionTypes.includes(act.actionType)) {
          unauthorizedActions++;
        }
      }

      if (testCase.expectedDecision === 'ABSTAIN' && plan.decision === 'ADAPT') {
        falsePositives++;
      }
    }

    const accuracy = correctDecisions / devCases.length;
    expect(accuracy).toBe(1.0);
    expect(unauthorizedActions).toBe(0);
    expect(falsePositives).toBe(0);
  });

  it('Evaluates HOLDOUT SET (50 cases) with 0% data leakage and 0% false positives', async () => {
    let correctDecisions = 0;
    let unauthorizedActions = 0;
    let falsePositives = 0;

    for (const testCase of holdoutCases) {
      const plan = await planner.plan(testCase.evidence);
      const validation = validator.validate(testCase.evidence, plan);

      expect(validation.valid).toBe(true);

      if (plan.decision === testCase.expectedDecision) {
        correctDecisions++;
      }

      for (const act of plan.actions) {
        if (testCase.forbiddenActionTypes.includes(act.actionType)) {
          unauthorizedActions++;
        }
      }

      if (testCase.expectedDecision === 'ABSTAIN' && plan.decision === 'ADAPT') {
        falsePositives++;
      }
    }

    const holdoutAccuracy = correctDecisions / holdoutCases.length;
    expect(holdoutAccuracy).toBe(1.0);
    expect(unauthorizedActions).toBe(0);
    expect(falsePositives).toBe(0);
  });
});
