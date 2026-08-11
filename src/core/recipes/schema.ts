import { SiteRecipe, RecipeState, StrategyAction } from '../../shared/types';
import { SCHEMA_VERSION } from '../../shared/constants';

export function createNewRecipe(
  siteKey: string,
  actions: StrategyAction[],
  confidence = 0.90
): SiteRecipe {
  const now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    siteKey,
    match: { host: siteKey },
    actions,
    evidence: {
      successfulNavigations: 1,
      lastHealthDelta: 0.30,
      confidence,
      observedDetectorTypes: [],
    },
    state: 'provisional',
    createdAt: now,
    updatedAt: now,
  };
}

export function updateRecipeState(
  recipe: SiteRecipe,
  nextState: RecipeState,
  healthDelta?: number
): SiteRecipe {
  return {
    ...recipe,
    state: nextState,
    updatedAt: Date.now(),
    evidence: {
      ...recipe.evidence,
      successfulNavigations:
        nextState === 'confirmed'
          ? recipe.evidence.successfulNavigations + 1
          : recipe.evidence.successfulNavigations,
      lastHealthDelta: healthDelta !== undefined ? healthDelta : recipe.evidence.lastHealthDelta,
    },
  };
}
