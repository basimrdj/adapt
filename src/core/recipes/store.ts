import { SiteRecipe } from '../../shared/types';
import { STORAGE_KEYS } from '../../shared/constants';

export interface StorageBackend {
  get: (keys: string[]) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (keys: string[]) => Promise<void>;
}

export class RecipeStore {
  private backend: StorageBackend;
  private memoryCache = new Map<string, SiteRecipe>();
  private initialized = false;

  constructor(backend: StorageBackend) {
    this.backend = backend;
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const data = await this.backend.get([STORAGE_KEYS.RECIPES]);
      const stored = data[STORAGE_KEYS.RECIPES] as Record<string, SiteRecipe> | undefined;
      if (stored && typeof stored === 'object') {
        for (const [key, recipe] of Object.entries(stored)) {
          this.memoryCache.set(key, recipe);
        }
      }
    } catch {
      // Memory fallback if storage is empty
    }
    this.initialized = true;
  }

  public async getRecipe(siteKey: string): Promise<SiteRecipe | undefined> {
    await this.init();
    return this.memoryCache.get(siteKey);
  }

  public async saveRecipe(recipe: SiteRecipe): Promise<void> {
    await this.init();
    this.memoryCache.set(recipe.siteKey, recipe);
    await this.persist();
  }

  public async deleteRecipe(siteKey: string): Promise<void> {
    await this.init();
    this.memoryCache.delete(siteKey);
    await this.persist();
  }

  public async getAllRecipes(): Promise<SiteRecipe[]> {
    await this.init();
    return Array.from(this.memoryCache.values());
  }

  private async persist(): Promise<void> {
    const obj: Record<string, SiteRecipe> = {};
    for (const [k, v] of this.memoryCache.entries()) {
      obj[k] = v;
    }
    await this.backend.set({ [STORAGE_KEYS.RECIPES]: obj });
  }
}
