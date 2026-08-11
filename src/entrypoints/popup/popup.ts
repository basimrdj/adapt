import { extractSiteKey } from '../../core/navigation/epoch';
import { STORAGE_KEYS } from '../../shared/constants';
import { SiteRecipe, AuditEvent } from '../../shared/types';

document.addEventListener('DOMContentLoaded', async () => {
  const currentSiteEl = document.getElementById('current-site')!;
  const recipeStatusEl = document.getElementById('recipe-status')!;
  const auditDrawerEl = document.getElementById('audit-drawer')!;
  const auditListEl = document.getElementById('audit-list')!;
  const btnAudit = document.getElementById('btn-view-audit')!;

  // Query active tab
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (tab && tab.url) {
      const siteKey = extractSiteKey(tab.url) || 'browser-surface';
      currentSiteEl.textContent = siteKey;

      // Check stored recipes
      chrome.storage.local.get([STORAGE_KEYS.RECIPES], (data) => {
        const recipes = data[STORAGE_KEYS.RECIPES] as Record<string, SiteRecipe> | undefined;
        if (recipes && recipes[siteKey]) {
          const r = recipes[siteKey];
          recipeStatusEl.textContent = `Recipe Active (${r.state}) — ${r.actions.length} action(s)`;
        } else {
          recipeStatusEl.textContent = 'Baseline DNR Protection Active';
        }
      });
    }
  });

  btnAudit.addEventListener('click', () => {
    const isHidden = auditDrawerEl.classList.contains('hidden');
    if (isHidden) {
      auditDrawerEl.classList.remove('hidden');
      loadAuditLogs();
    } else {
      auditDrawerEl.classList.add('hidden');
    }
  });

  function loadAuditLogs() {
    chrome.storage.local.get([STORAGE_KEYS.AUDIT_LOGS], (data) => {
      const logs = (data[STORAGE_KEYS.AUDIT_LOGS] as AuditEvent[]) || [];
      auditListEl.innerHTML = '';
      if (logs.length === 0) {
        auditListEl.innerHTML = '<div class="audit-item">No adaptation events recorded yet.</div>';
        return;
      }
      logs.slice(-10).reverse().forEach((log) => {
        const item = document.createElement('div');
        item.className = 'audit-item';
        const time = new Date(log.timestamp).toLocaleTimeString();
        item.textContent = `[${time}] ${log.eventType} on ${log.siteKey}`;
        auditListEl.appendChild(item);
      });
    });
  }
});
