import { StorageBackend } from '../../core/recipes/store';

/** Promise wrapper that propagates chrome.runtime.lastError instead of silently succeeding. */
export class ChromeStorageBackend implements StorageBackend {
  constructor(private readonly area: chrome.storage.StorageArea) {}

  get(keys: string[]): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      this.area.get(keys, (items) => {
        const error = chrome.runtime.lastError;
        if (error) return reject(new Error(error.message));
        resolve(items ?? {});
      });
    });
  }

  set(items: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.area.set(items, () => {
        const error = chrome.runtime.lastError;
        if (error) return reject(new Error(error.message));
        resolve();
      });
    });
  }

  remove(keys: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.area.remove(keys, () => {
        const error = chrome.runtime.lastError;
        if (error) return reject(new Error(error.message));
        resolve();
      });
    });
  }
}
