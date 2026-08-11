import { SiteRecipe } from '../../shared/types';
import { updateRecipeState } from './schema';

export class RecipePromotionManager {
  /**
   * Evaluates whether a provisional recipe should be promoted to confirmed
   * or degraded after a subsequent page visit.
   */
  public evaluateReplay(
    recipe: SiteRecipe,
    success: boolean,
    healthDelta: number
  ): SiteRecipe {
    if (success) {
      if (recipe.state === 'provisional' && recipe.evidence.successfulNavigations >= 2) {
        return updateRecipeState(recipe, 'confirmed', healthDelta);
      }
      return updateRecipeState(recipe, recipe.state, healthDelta);
    } else {
      // Recipe caused or failed to prevent breakage upon replay -> degrade
      return updateRecipeState(recipe, 'degraded', healthDelta);
    }
  }
}
