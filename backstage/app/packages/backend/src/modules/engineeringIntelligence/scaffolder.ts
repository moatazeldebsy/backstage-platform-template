import { MetricSample } from '@internal/engineering-intelligence-core';
import { CollectorResult, getJson, safeRatio } from './source';

// Scaffolder collector — does self-service actually work?
//
// Golden-path *adoption* (from the catalog) says how many services came from a
// template. This says something different and equally important: whether the
// scaffolder succeeds when a developer uses it. A platform whose templates fail
// half the time is not self-service, however good its adoption number looks.
//
// Read through the scaffolder's own HTTP API rather than its database. The task
// rows live in `backstage_plugin_scaffolder`, and reaching into another plugin's
// tables would couple this collector to a schema it does not own and Backstage
// does not treat as public.

/** Task states the scaffolder reports. `open`/`processing` are still running. */
type TaskStatus = 'open' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface ScaffolderTask {
  id?: string;
  status?: TaskStatus;
  createdAt?: string;
  spec?: { templateInfo?: { entityRef?: string } };
}

export interface ScaffolderTasksResponse {
  tasks?: ScaffolderTask[];
}

export interface TaskOutcome {
  completed: number;
  failed: number;
  /** Tasks still running, counted but excluded from the ratio. */
  inFlight: number;
}

/** Tally task outcomes. Pure, so the counting rules are testable. */
export function tallyTasks(tasks: ScaffolderTask[]): TaskOutcome {
  let completed = 0;
  let failed = 0;
  let inFlight = 0;

  for (const task of tasks) {
    switch (task.status) {
      case 'completed':
        completed += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      case 'open':
      case 'processing':
        inFlight += 1;
        break;
      // `cancelled` is counted as neither. Someone changing their mind mid-run
      // is not the scaffolder failing, and scoring it as one would punish the
      // platform for a human decision — the same distinction build failure
      // ratio draws against change failure rate.
      default:
        break;
    }
  }

  return { completed, failed, inFlight };
}

export interface ScaffolderAccess {
  baseUrl(): Promise<string>;
  token(): Promise<string>;
}

export async function collectScaffolder(
  access: ScaffolderAccess,
): Promise<CollectorResult & { outcome?: TaskOutcome }> {
  const observedAt = new Date().toISOString();

  let base: string;
  let token: string;
  try {
    base = await access.baseUrl();
    token = await access.token();
  } catch (error) {
    return {
      samples: [],
      unavailable: {
        source: 'scaffolder',
        reason: `Could not obtain scaffolder credentials: ${error}`,
      },
    };
  }

  const body = await getJson<ScaffolderTasksResponse>(`${base}/v2/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!body || !Array.isArray(body.tasks)) {
    return {
      samples: [],
      unavailable: {
        source: 'scaffolder',
        reason: `Scaffolder at ${base} did not answer with a task list.`,
      },
    };
  }

  const outcome = tallyTasks(body.tasks);
  const decided = outcome.completed + outcome.failed;

  if (decided === 0) {
    // A platform nobody has scaffolded on yet has no self-service track record.
    // Reporting 0% success would say the scaffolder is broken; reporting 100%
    // would say it is proven. Neither is true, so report nothing.
    return {
      samples: [],
      outcome,
      unavailable: {
        source: 'scaffolder',
        reason:
          'No scaffolder task has finished yet, so self-service success cannot be measured.',
      },
    };
  }

  const samples: MetricSample[] = [
    {
      metric: 'scaffolder.taskSuccessRatio',
      value: safeRatio(outcome.completed, decided) as number,
      source: 'scaffolder',
      observedAt,
    },
  ];

  return { samples, outcome };
}
