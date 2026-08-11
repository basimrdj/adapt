import { AuditEvent } from '../../shared/types';
import { STORAGE_KEYS } from '../../shared/constants';
import { StorageBackend } from '../recipes/store';

export class AuditStore {
  private backend: StorageBackend;
  private memoryLogs: AuditEvent[] = [];
  private initialized = false;

  constructor(backend: StorageBackend) {
    this.backend = backend;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    try {
      const data = await this.backend.get([STORAGE_KEYS.AUDIT_LOGS]);
      const stored = data[STORAGE_KEYS.AUDIT_LOGS] as AuditEvent[] | undefined;
      if (Array.isArray(stored)) {
        this.memoryLogs = stored;
      }
      this.initialized = true;
    } catch {
      this.initialized = true;
    }
  }

  public async recordEvent(event: AuditEvent): Promise<void> {
    await this.ensureInitialized();
    this.memoryLogs.push(event);
    if (this.memoryLogs.length > 500) {
      this.memoryLogs.shift();
    }
    try {
      await this.backend.set({ [STORAGE_KEYS.AUDIT_LOGS]: this.memoryLogs });
    } catch {
      // Storage failure ignored
    }
  }

  public async getRecentEvents(limit = 50): Promise<AuditEvent[]> {
    await this.ensureInitialized();
    return this.memoryLogs.slice(-limit);
  }

  public async clearLogs(): Promise<void> {
    this.memoryLogs = [];
    this.initialized = true;
    await this.backend.remove([STORAGE_KEYS.AUDIT_LOGS]);
  }
}
