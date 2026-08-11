import { AuditEvent } from '../../shared/types';
import { STORAGE_KEYS } from '../../shared/constants';
import { StorageBackend } from '../recipes/store';

export class AuditStore {
  private backend: StorageBackend;
  private memoryLogs: AuditEvent[] = [];

  constructor(backend: StorageBackend) {
    this.backend = backend;
  }

  public async recordEvent(event: AuditEvent): Promise<void> {
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
    try {
      const data = await this.backend.get([STORAGE_KEYS.AUDIT_LOGS]);
      const stored = data[STORAGE_KEYS.AUDIT_LOGS] as AuditEvent[] | undefined;
      if (Array.isArray(stored)) {
        this.memoryLogs = stored;
      }
    } catch {
      // Fallback to in-memory
    }
    return this.memoryLogs.slice(-limit);
  }

  public async clearLogs(): Promise<void> {
    this.memoryLogs = [];
    await this.backend.remove([STORAGE_KEYS.AUDIT_LOGS]);
  }
}
