import fs from 'fs';

export interface PolicyRule {
  // Tool/action name this rule matches, e.g. "sync_app", "rollback_app", "approve_pr".
  action: string;
  // Simple glob-ish match against the target string (e.g. an ArgoCD app name, a
  // "repo#pr_number", or a namespace) — "*" matches anything, "prod-*" matches a prefix.
  targetPattern: string;
  requiresApproval: boolean;
  reason: string;
}

const DEFAULT_POLICY: PolicyRule[] = [
  { action: 'sync_app', targetPattern: '*', requiresApproval: true, reason: 'ArgoCD sync is a production-affecting action by default — require approval unless a more specific rule says otherwise.' },
  { action: 'rollback_app', targetPattern: '*', requiresApproval: true, reason: 'ArgoCD rollback always requires approval — it reverts a live deployment.' },
  { action: 'approve_pr', targetPattern: '*', requiresApproval: true, reason: 'Approving a PR is a merge-enabling action — require human sign-off.' },
  { action: 'request_changes', targetPattern: '*', requiresApproval: false, reason: 'Requesting changes blocks merge rather than enabling it — safe to auto-approve.' },
];

function targetMatches(pattern: string, target: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return target.startsWith(pattern.slice(0, -1));
  return pattern === target;
}

let cachedPolicy: PolicyRule[] | null = null;

export function loadPolicy(policyPath = process.env.POLICY_FILE ?? '/etc/approval-service/policy.json'): PolicyRule[] {
  if (cachedPolicy) return cachedPolicy;
  try {
    if (fs.existsSync(policyPath)) {
      const parsed = JSON.parse(fs.readFileSync(policyPath, 'utf-8')) as PolicyRule[];
      cachedPolicy = parsed;
      return parsed;
    }
  } catch (err) {
    console.warn(`[approval-service] failed to load policy from ${policyPath}, using default: ${(err as Error).message}`);
  }
  cachedPolicy = DEFAULT_POLICY;
  return DEFAULT_POLICY;
}

export function resetPolicyCache(): void {
  cachedPolicy = null;
}

export function checkPolicy(action: string, target: string): { requiresApproval: boolean; reason: string; matchedRule: string } {
  const policy = loadPolicy();
  for (const rule of policy) {
    if (rule.action === action && targetMatches(rule.targetPattern, target)) {
      return { requiresApproval: rule.requiresApproval, reason: rule.reason, matchedRule: `${rule.action}:${rule.targetPattern}` };
    }
  }
  // No matching rule — fail safe: require approval for anything not explicitly allow-listed.
  return { requiresApproval: true, reason: `No policy rule matched action "${action}" — defaulting to require approval.`, matchedRule: 'default-fallback' };
}
