import { describe, it, expect } from 'vitest';
import { RecipePromotionManager } from '../../src/core/recipes/promotion';
import { createNewRecipe } from '../../src/core/recipes/schema';

describe('RecipePromotionManager', () => {
  const manager = new RecipePromotionManager();

  it('promotes provisional recipe to confirmed after 2 successful replays', () => {
    let recipe = createNewRecipe('testsite.com', [
      { id: 'act_1', type: 'DOM_REMOVE_OVERLAY' },
    ]);

    expect(recipe.state).toBe('provisional');
    expect(recipe.evidence.successfulNavigations).toBe(1);

    // First replay success -> reaches count 2 and promotes to confirmed!
    recipe = manager.evaluateReplay(recipe, true, 0.25);
    expect(recipe.state).toBe('confirmed');
    expect(recipe.evidence.successfulNavigations).toBe(2);
    expect(recipe.evidence.lastHealthDelta).toBe(0.25);
  });

  it('degrades recipe on replay failure', () => {
    let recipe = createNewRecipe('brokensite.com', [
      { id: 'act_1', type: 'DOM_REMOVE_OVERLAY' },
    ]);

    recipe = manager.evaluateReplay(recipe, false, -0.10);
    expect(recipe.state).toBe('degraded');
  });
});
