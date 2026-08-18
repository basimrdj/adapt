/**
 * Shared Azure credential resolution for the live-eval dev scripts.
 * Fully env-var driven — no account names, resource groups, endpoints, or keys
 * live in source control:
 *
 *   AZURE_OPENAI_API_KEY        API key (if unset, resolved via the Azure CLI…)
 *   AZURE_OPENAI_ACCOUNT        Azure OpenAI account name (for az CLI lookup)
 *   AZURE_OPENAI_RESOURCE_GROUP resource group   (for az CLI lookup)
 *   AZURE_OPENAI_BASE_URL       endpoint, e.g. https://<account>.openai.azure.com/openai/v1/
 *   AZURE_OPENAI_MODEL          deployment/model name
 */
import { execSync } from 'node:child_process';

export function resolveAzureApiKey(): string | undefined {
  const fromEnv = process.env.AZURE_OPENAI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const account = process.env.AZURE_OPENAI_ACCOUNT;
  const resourceGroup = process.env.AZURE_OPENAI_RESOURCE_GROUP;
  if (!account || !resourceGroup) return undefined;
  try {
    const key = execSync(
      `az cognitiveservices account keys list --name ${account} --resource-group ${resourceGroup} --query key1 -o tsv`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }
    ).trim();
    return key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

export function requireAzureApiKey(): string {
  const key = resolveAzureApiKey();
  if (!key) {
    console.error('No Azure credential: set AZURE_OPENAI_API_KEY, or AZURE_OPENAI_ACCOUNT + AZURE_OPENAI_RESOURCE_GROUP for az CLI lookup.');
    process.exit(1);
  }
  return key;
}

export function requireAzureBaseURL(): string {
  const baseURL = process.env.AZURE_OPENAI_BASE_URL;
  if (!baseURL) {
    console.error('Set AZURE_OPENAI_BASE_URL, e.g. https://<account>.openai.azure.com/openai/v1/');
    process.exit(1);
  }
  return baseURL;
}

export function requireAzureModel(): string {
  const model = process.env.AZURE_OPENAI_MODEL;
  if (!model) {
    console.error('Set AZURE_OPENAI_MODEL to your deployment/model name.');
    process.exit(1);
  }
  return model;
}
