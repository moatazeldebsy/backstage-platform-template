import { DimensionId, DimensionScore, Recommendation } from './model';

// The five-level Engineering Maturity Model, computed from dimension scores.
//
// Deliberately not "overall score ÷ 20". A single average hides the shape that
// matters: an organisation with excellent Reliability and no platform at all is
// not Level 3, and an average would say it was.
//
// Levels are floors. An organisation is at the highest level whose *every*
// requirement it meets, so one weak dimension holds the level down. And a
// dimension reporting `insufficient-evidence` can neither satisfy a requirement
// nor fail one — it makes the level *unconfirmed*, which is a different and more
// honest answer than either. See docs/engineering-intelligence/maturity-model.md.

export type LevelNumber = 1 | 2 | 3 | 4 | 5;

/**
 * A requirement is either a score floor on a dimension, or a capability the
 * platform cannot currently observe at all.
 *
 * The second kind exists so Level 5 can state honestly that it is not reachable
 * from scores alone. Nothing in the platform measures whether agents actually
 * remediate incidents or whether the approval gate is genuinely enforced, and a
 * maturity model that awarded "Autonomous Engineering" for a high AI score would
 * be making exactly the claim it has no evidence for.
 */
export type Requirement =
  | {
      kind: 'dimension';
      dimension: DimensionId;
      minScore: number;
      because: string;
    }
  | {
      kind: 'capability';
      capability: string;
      because: string;
      /** Which roadmap phase would make this measurable, when one would. */
      availableFrom?: string;
    };

export interface LevelDefinition {
  level: LevelNumber;
  name: string;
  description: string;
  requirements: Requirement[];
}

export const LEVELS: LevelDefinition[] = [
  {
    level: 1,
    name: 'Ad Hoc',
    description:
      'Manual processes and inconsistent practice. Deployment is a person, not a pipeline.',
    // The floor. Every organisation running this platform is at least here, so
    // there is nothing to require — a Level 1 assessment is the absence of
    // evidence for Level 2, not a finding in its own right.
    requirements: [],
  },
  {
    level: 2,
    name: 'Standardised',
    description:
      'CI/CD exists and is used, infrastructure is code, and there is an observability stack.',
    requirements: [
      {
        kind: 'dimension',
        dimension: 'quality',
        minScore: 50,
        because:
          'Standardised practice means CI gates — coverage, static analysis and vulnerability scanning — are declared and passing on most services.',
      },
      {
        kind: 'dimension',
        dimension: 'platform',
        minScore: 40,
        because:
          'Services are owned and consistently catalogued, even where they are not yet scaffolded from a golden path.',
      },
      {
        kind: 'dimension',
        dimension: 'reliability',
        minScore: 40,
        because:
          'Change failure rate and time to restore are measured at all, which is what separates Standardised from Ad Hoc.',
      },
    ],
  },
  {
    level: 3,
    name: 'Platform Enabled',
    description:
      'An IDP exists and developers self-serve through it. Golden paths are the default rather than the exception.',
    requirements: [
      {
        kind: 'dimension',
        dimension: 'platform',
        minScore: 70,
        because:
          'Golden-path adoption and scorecard tiers are what distinguish a platform people use from a platform that exists.',
      },
      {
        kind: 'dimension',
        dimension: 'quality',
        minScore: 65,
        because:
          'Scorecards are enforced rather than advisory, and flakiness is under control.',
      },
      {
        kind: 'dimension',
        dimension: 'reliability',
        minScore: 65,
        because:
          'DORA change failure rate and MTTR sit in the High or Elite bands.',
      },
    ],
  },
  {
    level: 4,
    name: 'AI Enabled',
    description:
      'AI is part of how engineering works, and is governed like anything else in production: evaluated, observed and cost-attributed.',
    requirements: [
      {
        kind: 'dimension',
        dimension: 'aiEngineering',
        minScore: 65,
        because:
          'AI services carry model cards and evaluation suites, and their traces reach an observability backend.',
      },
      {
        kind: 'dimension',
        dimension: 'security',
        minScore: 60,
        because:
          'Governing AI in production is not credible while ordinary scanning controls are missing.',
      },
      {
        // The requirement that will hold most installations at Level 3 today,
        // and the reason this model reports "unconfirmed above 3" rather than
        // waving them through. Adding AI to a platform whose developer
        // experience is unmeasured is adding it on faith.
        kind: 'dimension',
        dimension: 'devEx',
        minScore: 60,
        because:
          'Level 4 asks whether the platform is measurably working before AI is layered on top of it, and that cannot be claimed without Developer Experience data.',
      },
    ],
  },
  {
    level: 5,
    name: 'Autonomous Engineering',
    description:
      'Agents do bounded work end to end under human-approved policy. Remediation is automated for known failure classes.',
    requirements: [
      {
        kind: 'dimension',
        dimension: 'aiEngineering',
        minScore: 80,
        because:
          'Autonomy rests on AI systems that are already evaluated, observed and governed to a high standard.',
      },
      {
        kind: 'dimension',
        dimension: 'reliability',
        minScore: 80,
        because:
          'Handing remediation to agents on an unreliable platform automates the failure rather than the fix.',
      },
      {
        kind: 'capability',
        capability: 'Approval-gated agent actions, enforced and measured',
        because:
          'The human-in-the-loop gate has to be demonstrably enforced, not merely deployed. Nothing in the platform currently measures approval outcomes, and this gate has been found silently disabled before — awarding Level 5 from a high AI score would make precisely the claim there is no evidence for.',
      },
      {
        kind: 'capability',
        capability: 'Automated remediation with a measured success rate',
        because:
          'No series records whether an agent-initiated remediation resolved the incident it was raised for.',
      },
    ],
  },
];

// ── Assessment ────────────────────────────────────────────────────────────────

export type RequirementStatus = 'met' | 'unmet' | 'unmeasurable';

export interface RequirementResult {
  requirement: Requirement;
  status: RequirementStatus;
  /** The dimension's score, or null for an unmeasurable requirement. */
  actual: number | null;
  /** One sentence a reader can act on. */
  detail: string;
}

export type LevelStatus = 'met' | 'unmet' | 'unconfirmed';

export interface LevelAssessment {
  level: LevelNumber;
  name: string;
  description: string;
  status: LevelStatus;
  requirements: RequirementResult[];
}

export interface MaturityAssessment {
  currentLevel: LevelNumber;
  currentLevelName: string;
  /**
   * False when the level above could not be evaluated because a dimension had
   * insufficient evidence — the difference between "we are not Level 4" and
   * "we cannot tell whether we are Level 4".
   */
  confirmed: boolean;
  /** Human-readable one-liner, e.g. "Level 3 — Platform Enabled (unconfirmed above 3)". */
  summary: string;
  targetLevel: LevelNumber;
  levels: LevelAssessment[];
  /** The target level's requirements that are not yet met. */
  gap: RequirementResult[];
  /** Existing recommendations that bear on the gap, most severe first. */
  recommendedActions: Recommendation[];
}

function evaluate(
  requirement: Requirement,
  dimensions: Record<DimensionId, DimensionScore>,
): RequirementResult {
  if (requirement.kind === 'capability') {
    return {
      requirement,
      status: 'unmeasurable',
      actual: null,
      detail: `Not measurable today: ${requirement.capability}.${
        requirement.availableFrom
          ? ` Expected from ${requirement.availableFrom}.`
          : ''
      }`,
    };
  }

  const scored = dimensions[requirement.dimension];
  if (!scored || scored.score === null) {
    const missing = scored?.missing.map(m => m.metric).join(', ');
    return {
      requirement,
      status: 'unmeasurable',
      actual: null,
      detail:
        `${requirement.dimension} has insufficient evidence, so this requirement can be ` +
        `neither met nor failed.${missing ? ` Missing: ${missing}.` : ''}`,
    };
  }

  const met = scored.score >= requirement.minScore;
  return {
    requirement,
    status: met ? 'met' : 'unmet',
    actual: scored.score,
    detail: met
      ? `${requirement.dimension} scores ${scored.score}, at or above the ${requirement.minScore} floor.`
      : `${requirement.dimension} scores ${scored.score}, below the ${requirement.minScore} floor.`,
  };
}

function levelStatus(results: RequirementResult[]): LevelStatus {
  // Order matters: a genuine failure outranks missing evidence. If one
  // requirement is definitively unmet, the level is unmet regardless of what
  // else could not be measured — knowing you fall short is knowing something.
  if (results.some(r => r.status === 'unmet')) return 'unmet';
  if (results.some(r => r.status === 'unmeasurable')) return 'unconfirmed';
  return 'met';
}

export function assessMaturity(
  dimensions: Record<DimensionId, DimensionScore>,
  recommendations: Recommendation[] = [],
): MaturityAssessment {
  const levels: LevelAssessment[] = LEVELS.map(definition => {
    const requirements = definition.requirements.map(r =>
      evaluate(r, dimensions),
    );
    return {
      level: definition.level,
      name: definition.name,
      description: definition.description,
      status: levelStatus(requirements),
      requirements,
    };
  });

  // Levels are floors, so walk up and stop at the first that is not fully met.
  // Stopping rather than taking the highest satisfied level is the point: an
  // organisation cannot skip Level 2 by scoring well on Level 4's dimensions.
  let currentLevel: LevelNumber = 1;
  for (const assessment of levels) {
    if (assessment.level === 1) continue;
    if (assessment.status !== 'met') break;
    currentLevel = assessment.level;
  }

  const next = levels.find(l => l.level === currentLevel + 1);
  const confirmed = !next || next.status === 'unmet';
  const targetLevel = (next ? next.level : currentLevel) as LevelNumber;

  const currentDefinition = levels.find(l => l.level === currentLevel)!;
  const gap = next ? next.requirements.filter(r => r.status !== 'met') : [];

  // Only recommendations bearing on the gap. A recommendation about a dimension
  // that already clears the next level's floor is real advice, but it is not
  // what would move the organisation up, and mixing the two makes the gap
  // unreadable.
  const gapDimensions = new Set(
    gap
      .map(r =>
        r.requirement.kind === 'dimension'
          ? r.requirement.dimension
          : undefined,
      )
      .filter((d): d is DimensionId => !!d),
  );
  const recommendedActions = recommendations.filter(r =>
    gapDimensions.has(r.dimension),
  );

  const summary = confirmed
    ? `Level ${currentLevel} — ${currentDefinition.name}`
    : `Level ${currentLevel} — ${currentDefinition.name} (unconfirmed above ${currentLevel})`;

  return {
    currentLevel,
    currentLevelName: currentDefinition.name,
    confirmed,
    summary,
    targetLevel,
    levels,
    gap,
    recommendedActions,
  };
}
