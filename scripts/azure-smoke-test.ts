import { OpenAI } from 'openai';
import { execSync } from 'child_process';

async function runSmokeTest() {
  console.log('=== ADAPT Phase 2A: Azure OpenAI Extended Smoke Test ===');

  let apiKey = process.env.AZURE_OPENAI_API_KEY;
  if (!apiKey) {
    try {
      apiKey = execSync(
        'az cognitiveservices account keys list --name basim-agent3-openai-eastus2 --resource-group rg-maheekodhan42-8571 --query key1 -o tsv',
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
    } catch {
      console.error('Failed to obtain Azure key via CLI.');
      process.exit(1);
    }
  }

  if (!apiKey || apiKey.length === 0) {
    console.error('Azure OpenAI key retrieval failed.');
    process.exit(1);
  }

  const baseURL =
    process.env.AZURE_OPENAI_BASE_URL ||
    'https://basim-agent3-openai-eastus2.openai.azure.com/openai/v1/';
  const model = process.env.AZURE_OPENAI_MODEL || 'buzz-gpt-5-4-mini';

  const client = new OpenAI({ apiKey, baseURL });

  const testSchema = {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['ADAPT', 'OBSERVE', 'ABSTAIN'] },
      confidence: { type: 'number' },
      hypothesis: { type: 'string' },
    },
    required: ['decision', 'confidence', 'hypothesis'],
    additionalProperties: false,
  } as const;

  const reasoningLevels = ['low', 'medium'] as const;

  for (const level of reasoningLevels) {
    console.log(`\nTesting reasoning_effort: "${level}" with max_completion_tokens=600...`);
    const t0 = Date.now();

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are the ADAPT Policy Planner. Evaluate evidence and return structured plan.',
        },
        {
          role: 'user',
          content:
            'Evidence: Fullscreen anti-adblock overlay covering 90% of screen with text "Please disable adblocker".',
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'smoke_test_plan',
          strict: true,
          schema: testSchema,
        },
      },
      reasoning_effort: level,
      max_completion_tokens: 600,
    });

    const elapsed = Date.now() - t0;
    const content = response.choices[0]?.message?.content;
    const parsed = content ? JSON.parse(content) : null;

    console.log(`✓ Latency: ${elapsed}ms`);
    console.log(`✓ Decision: ${parsed?.decision}, Confidence: ${parsed?.confidence}`);
    console.log(`✓ Hypothesis: ${parsed?.hypothesis}`);
    console.log(`✓ Usage: prompt=${response.usage?.prompt_tokens}, completion=${response.usage?.completion_tokens}, total=${response.usage?.total_tokens}`);
    if (response.usage && 'completion_tokens_details' in response.usage) {
      console.log(`✓ Reasoning Tokens: ${(response.usage as any).completion_tokens_details?.reasoning_tokens || 0}`);
    }
  }

  console.log('\n=== Extended Smoke Test Complete ===');
}

runSmokeTest().catch((err) => {
  console.error('Smoke test error:', err.message);
  process.exit(1);
});
