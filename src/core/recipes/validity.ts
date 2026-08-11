import { SiteRecipe } from '../../shared/types';

export function isRecipeValidForSite(recipe: SiteRecipe, siteKey: string): boolean {
  if (recipe.siteKey !== siteKey) return false;
  if (recipe.state === 'quarantined' || recipe.state === 'expired') return false;

  // Check age (e.g. valid for 30 days)
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  if (Date.now() - recipe.updatedAt > thirtyDaysMs) {
    return false;
  }

  return true;
}
