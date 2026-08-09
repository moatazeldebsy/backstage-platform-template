import * as fs from 'fs/promises';

/**
 * Shared kubeconfig bootstrap for the scaffolder actions that shell out to
 * kubectl/helm.
 *
 * This used to be copy-pasted into every action module, and the copies had
 * drifted in two ways that only bit on AWS:
 *
 *  - idpDeployModelServer read `K8S_CLUSTER_CA_B64`, a name no part of this
 *    repo has ever set. Every producer uses `K8S_CLUSTER_CA_DATA`
 *    (terraform/secrets.tf, aws/backstage/deployment.yaml,
 *    scripts/get-k8s-credentials.sh, local/backstage/docker-compose.yml), so
 *    the action threw before it could do anything on EKS.
 *  - idpRunTrainingJob and idpSetupContractTesting skipped TLS verification
 *    (`insecure-skip-tls-verify: true`) rather than pinning the cluster CA.
 *
 * Both are fixed here: one implementation, correct variable name, CA pinned.
 * The CA is available in every environment this runs in — bootstrap-local.sh
 * writes it via get-k8s-credentials.sh, and on EKS it comes from Secrets
 * Manager through the deployment's env — so requiring it costs nothing and
 * removes a MITM window against the API server.
 */

export const KUBECONFIG_PATH = process.env.KUBECONFIG ?? '/tmp/kubeconfig';

export const kubeEnv = {
  ...process.env,
  KUBECONFIG: KUBECONFIG_PATH,
};

/**
 * Writes a kubeconfig to KUBECONFIG_PATH from the K8S_* env vars.
 *
 * No-ops when K8S_CLUSTER_URL / K8S_SERVICE_ACCOUNT_TOKEN are absent: that is
 * the local-dev case where Backstage runs on the host and the developer's own
 * kubeconfig already points at Kind. In-cluster (AWS) both are always set, and
 * /tmp/kubeconfig would not otherwise exist.
 */
export async function ensureKubeconfig(): Promise<void> {
  const k8sUrl = process.env.K8S_CLUSTER_URL;
  const k8sToken = process.env.K8S_SERVICE_ACCOUNT_TOKEN;
  const k8sCa = process.env.K8S_CLUSTER_CA_DATA;

  if (!k8sUrl || !k8sToken) return; // local dev — caller has their own kubeconfig
  if (!k8sCa) {
    throw new Error(
      'K8S_CLUSTER_CA_DATA env var required for secure TLS connections to the cluster API server. ' +
        'On AWS it comes from Secrets Manager via terraform/secrets.tf; locally, re-run ' +
        'scripts/get-k8s-credentials.sh to regenerate local/backstage/.env.',
    );
  }

  const kubeconfig = `apiVersion: v1
kind: Config
clusters:
- cluster:
    server: ${k8sUrl}
    certificate-authority-data: ${k8sCa}
  name: cluster
contexts:
- context:
    cluster: cluster
    user: backstage
  name: default
current-context: default
users:
- name: backstage
  user:
    token: ${k8sToken}
`;
  await fs.writeFile(KUBECONFIG_PATH, kubeconfig, { encoding: 'utf8', mode: 0o600 });
}
