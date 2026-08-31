import { MetricSample } from '@internal/engineering-intelligence-core';
import {
  CollectorContext,
  CollectorResult,
  getJson,
  proxyTarget,
  safeRatio,
} from './source';

// MLflow collector — model management.
//
// The question this answers is narrow on purpose: of the models someone has
// registered, how many are actually *managed*? A registered name with no
// versions is the registry equivalent of an empty repository — it shows intent,
// not practice, and counting it as managed would flatter a platform where
// somebody clicked "create" once.
//
// What it deliberately does not do is score model *quality*. MLflow holds run
// metrics, but a good accuracy number on an unknown dataset says nothing about
// production readiness, and turning one into a readiness score would be exactly
// the kind of invented figure this layer exists to avoid.

export interface RegisteredModel {
  name?: string;
  latest_versions?: { version?: string; current_stage?: string }[];
}

export interface SearchResponse {
  registered_models?: RegisteredModel[];
}

export interface ModelRegistryFacts {
  registered: number;
  versioned: number;
}

/** Count registered models and how many carry at least one version. Pure. */
export function registryFacts(models: RegisteredModel[]): ModelRegistryFacts {
  let versioned = 0;
  for (const model of models) {
    if ((model.latest_versions?.length ?? 0) > 0) versioned += 1;
  }
  return { registered: models.length, versioned };
}

export async function collectMlflow(
  ctx: CollectorContext,
): Promise<CollectorResult & { facts?: ModelRegistryFacts }> {
  const base = proxyTarget(ctx.config, '/mlflow');
  if (!base) {
    return {
      samples: [],
      unavailable: {
        source: 'mlflow',
        reason: 'No proxy.endpoints./mlflow.target is configured.',
      },
    };
  }

  // GET, not POST. MLflow 2.x is not consistent about this: `runs/search` and
  // `experiments/search` are POST, but `registered-models/search` answers
  // `Allow: HEAD, OPTIONS, GET` and returns 405 to a POST. Verified against a
  // real MLflow 2.13.0 — the version this platform deploys.
  const body = await getJson<SearchResponse>(
    `${base}/api/2.0/mlflow/registered-models/search?max_results=1000`,
  );

  if (!body) {
    return {
      samples: [],
      unavailable: {
        source: 'mlflow',
        reason: `MLflow at ${base} did not answer with a model list.`,
      },
    };
  }

  // An empty registry answers `{}` — the key is absent rather than an empty
  // array. Treating a missing key as a failed call reported a reachable MLflow
  // as unreachable, which is the opposite of the truth and hides a real
  // "nothing registered yet" finding behind an infrastructure complaint.
  const facts = registryFacts(body.registered_models ?? []);

  if (facts.registered === 0) {
    // An empty registry is not a badly managed registry. A platform with no
    // models has nothing to manage, and scoring it 0% would demand model
    // governance from a team that has not shipped a model.
    return {
      samples: [],
      facts,
      unavailable: {
        source: 'mlflow',
        reason:
          'No models are registered, so model management cannot be measured.',
      },
    };
  }

  const samples: MetricSample[] = [
    {
      metric: 'ai.modelVersionedRatio',
      value: safeRatio(facts.versioned, facts.registered) as number,
      source: 'mlflow',
      observedAt: new Date().toISOString(),
    },
  ];

  return { samples, facts };
}
