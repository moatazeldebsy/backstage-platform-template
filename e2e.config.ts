import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { createAnthropic } from '@ai-sdk/anthropic';
import { readFileSync } from 'node:fs';

// Reuse the platform's ANTHROPIC_API_KEY from local/.env (same key KAgent/LiteLLM use) without
// loading the rest of that file into the runner. An exported env var wins.
function anthropicKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const line = readFileSync('local/.env', 'utf8').match(/^ANTHROPIC_API_KEY=(.*)$/m);
    return line?.[1].trim().replace(/^["']|["']$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

const anthropic = createAnthropic({ apiKey: anthropicKey() });

export default {
  agents: {
    default: {
      model: anthropic('claude-sonnet-5-5'),
      system: 'You are a thorough QA agent. Verify every outcome.',
      context:
        'The app is Backstage, an internal developer portal. The Catalog lists software entities ' +
        '(Components, APIs, Systems, Groups); Create lists Software Templates (golden paths).',
    },
  },
  targets: [{
    engine: web(),
    app: {
      // Backstage runs in Docker Compose behind the Kind ingress (see CLAUDE.md "Local Access URLs").
      url: process.env.APP_URL ?? 'http://127.0.0.1:3000',
      command: {
        executable: 'docker',
        args: ['compose', '-f', 'local/backstage/docker-compose.yml', 'up', 'backstage'],
        reuseExisting: true,
        startupTimeout: 180_000,
        log: '.e2e/logs/app.log',
      },
    },
  }],
} satisfies E2EConfig;
