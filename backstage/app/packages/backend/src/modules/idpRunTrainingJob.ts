import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { ensureKubeconfig, kubeEnv } from './kubeconfig';

const execAsync = promisify(exec);

// Must track the MLflow *server* image tag in kubernetes/ml-platform/mlflow.yaml
// and aws/ml-platform/mlflow.yaml. An unpinned `pip install mlflow` pulls a 3.x
// client, whose log_model() calls POST /api/2.0/mlflow/logged-models — an
// endpoint the 2.x server does not serve, so training fails with a 404 *after*
// the run and its metrics have already been logged.
const MLFLOW_CLIENT_VERSION = process.env.MLFLOW_CLIENT_VERSION ?? '2.13.0';

const frameworkDeps: Record<string, string> = {
  sklearn: 'scikit-learn numpy',
  xgboost: 'xgboost scikit-learn numpy',
  pytorch: 'torch scikit-learn numpy',
  tensorflow: 'tensorflow scikit-learn numpy',
};

// Minimal but real training script: trains on Iris, logs to MLflow.
// Reads MLFLOW_TRACKING_URI and MLFLOW_EXPERIMENT_NAME from env.
//
// This mirrors the skeleton's train.py, including its "<name>-model" registry
// naming — the two are separate implementations of the same job and drift
// easily. It differs deliberately in one respect: the skeleton skips
// log_model() entirely when registration is off, whereas this always logs the
// model artifact and only attaches registered_model_name when asked. The
// parameter is "register in the Model Registry", not "produce a model".
function buildTrainScript(framework: string, name: string, registerModel: boolean): string {
  const isXgboost = framework === 'xgboost';
  const registerArg = registerModel ? `, registered_model_name="${name}-model"` : '';
  return `import os, mlflow, mlflow.sklearn
from sklearn.datasets import load_iris
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, f1_score
${isXgboost ? 'from xgboost import XGBClassifier' : 'from sklearn.ensemble import RandomForestClassifier'}

tracking_uri = os.getenv("MLFLOW_TRACKING_URI", "http://localhost:5000")
experiment  = os.getenv("MLFLOW_EXPERIMENT_NAME", "Default")
n_estimators = int(os.getenv("N_ESTIMATORS", "100"))
max_depth    = int(os.getenv("MAX_DEPTH", "5"))

mlflow.set_tracking_uri(tracking_uri)
mlflow.set_experiment(experiment)

X, y = load_iris(return_X_y=True)
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

with mlflow.start_run():
    mlflow.log_param("n_estimators", n_estimators)
    mlflow.log_param("max_depth", max_depth)
    mlflow.log_param("framework", "${framework}")
${isXgboost
    ? `    model = XGBClassifier(n_estimators=n_estimators, max_depth=max_depth, use_label_encoder=False, eval_metric="mlogloss")
    model.fit(X_train, y_train)`
    : `    model = RandomForestClassifier(n_estimators=n_estimators, max_depth=max_depth, random_state=42)
    model.fit(X_train, y_train)`}
    preds = model.predict(X_test)
    acc = accuracy_score(y_test, preds)
    f1  = f1_score(y_test, preds, average="weighted")
    mlflow.log_metric("accuracy", acc)
    mlflow.log_metric("f1_score", f1)
    mlflow.sklearn.log_model(model, "model"${registerArg})
    print(f"accuracy={acc:.4f}  f1={f1:.4f}")
print("Training complete.")
`;
}

function buildManifests(opts: {
  name: string;
  experimentName: string;
  framework: string;
  pythonVersion: string;
  trainScript: string;
  deps: string;
}): string {
  const { name, experimentName, pythonVersion, trainScript, deps } = opts;
  const jobName = `${name}-initial-run`;
  const cmName = `${name}-train-code`;
  // Indent train.py content for the ConfigMap literal block (4 spaces)
  const indented = trainScript.split('\n').map(l => `    ${l}`).join('\n');

  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${cmName}
  namespace: ml-platform
data:
  train.py: |
${indented}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: ${jobName}
  namespace: ml-platform
  labels:
    app: ${name}
    backstage.io/kubernetes-id: ${name}
spec:
  ttlSecondsAfterFinished: 3600
  backoffLimit: 1
  template:
    # Labels are repeated on the pod template on purpose: labels on the Job's
    # own metadata are not inherited by its pods, so without these the pods
    # carry only job-name= and are invisible to both a kubectl -l app=<name>
    # lookup and the entity's Kubernetes tab.
    metadata:
      labels:
        app: ${name}
        backstage.io/kubernetes-id: ${name}
    spec:
      restartPolicy: Never
      containers:
        - name: train
          image: python:${pythonVersion}-slim
          command: ["/bin/sh", "-c"]
          args:
            - pip install --quiet "mlflow==${MLFLOW_CLIENT_VERSION}" ${deps} && python /app/train.py
          env:
            - name: MLFLOW_TRACKING_URI
              value: http://mlflow.ml-platform.svc.cluster.local:5000
            - name: MLFLOW_EXPERIMENT_NAME
              value: "${experimentName}"
            - name: N_ESTIMATORS
              value: "100"
            - name: MAX_DEPTH
              value: "5"
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 1Gi
          volumeMounts:
            - name: code
              mountPath: /app
      volumes:
        - name: code
          configMap:
            name: ${cmName}
`;
}

/**
 * Submits the ml-training-pipeline WorkflowTemplate instead of a bare Job.
 *
 * The pipeline can do the two things a Job cannot: fail the run when accuracy is
 * below a threshold, and stop at a suspend gate for a human before anything is
 * promoted. The ConfigMap carrying train.py is identical either way, so only the
 * second document differs.
 */
function buildWorkflowManifests(opts: {
  name: string;
  experimentName: string;
  pythonVersion: string;
  trainScript: string;
  deps: string;
  registerModel: boolean;
  minAccuracy: number;
}): string {
  const { name, experimentName, pythonVersion, trainScript, deps, registerModel, minAccuracy } = opts;
  const cmName = `${name}-train-code`;
  const indented = trainScript.split('\n').map(l => `    ${l}`).join('\n');

  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${cmName}
  namespace: ml-platform
data:
  train.py: |
${indented}
---
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: ${name}-train-
  namespace: ml-platform
  labels:
    app: ${name}
    backstage.io/kubernetes-id: ${name}
spec:
  workflowTemplateRef:
    name: ml-training-pipeline
  arguments:
    parameters:
      - name: name
        value: "${name}"
      - name: experiment-name
        value: "${experimentName}"
      - name: python-version
        value: "${pythonVersion}"
      - name: deps
        value: "${deps}"
      - name: code-configmap
        value: "${cmName}"
      - name: mlflow-client-version
        value: "${MLFLOW_CLIENT_VERSION}"
      - name: min-accuracy
        value: "${minAccuracy}"
      - name: register-model
        value: "${registerModel}"
`;
}

/**
 * Argo Workflows is part of the opt-in AI/ML layer, so it is legitimately absent
 * on a core-only install. Falling back to the original Job keeps this action
 * working there rather than failing the scaffold.
 */
async function workflowsAvailable(): Promise<boolean> {
  if (process.env.IDP_TRAINING_BACKEND === 'job') return false;
  try {
    await execAsync('kubectl get crd workflowtemplates.argoproj.io --request-timeout=5s', {
      env: kubeEnv,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function createRunTrainingJobAction() {
  return createTemplateAction({
    id: 'idp:run-training-job',
    description: 'Create a Kubernetes Job in ml-platform that runs the initial training and logs metrics to the in-cluster MLflow.',
    schema: {
      input: {
        name: z => z.string().describe('Experiment repo name'),
        experimentName: z => z.string().describe('MLflow experiment name'),
        framework: z => z.string().optional().describe('ML framework (default: sklearn)'),
        pythonVersion: z => z.string().optional().describe('Python version (default: 3.11)'),
        registerModel: z =>
          z.boolean().optional().describe('Register the trained model in the MLflow Model Registry (default: true)'),
        minAccuracy: z =>
          z.number().optional().describe('Fail the pipeline below this accuracy (default: 0, i.e. no gate). Ignored on the Job fallback.'),
      },
      output: {
        mlflowUrl: z => z.string().describe('MLflow UI URL'),
        // Emitted by the handler but previously undeclared, so it was invisible
        // to templates — `steps.<id>.output.catalogUrl` resolved to nothing.
        catalogUrl: z => z.string().describe('Backstage catalog entity URL'),
        jobName: z => z.string().describe('Kubernetes Job name (empty when the Argo Workflows pipeline was used)'),
        // Declared, not just emitted — an undeclared output resolves to nothing
        // in `steps.<id>.output.<name>`, which is how catalogUrl was invisible.
        workflowName: z => z.string().describe('Argo Workflow name (empty when the Job fallback was used)'),
        argoUrl: z => z.string().describe('Argo Workflows UI URL'),
      },
    },

    async handler(ctx) {
      const name = ctx.input.name as string;
      const experimentName = ctx.input.experimentName as string;
      const framework = (ctx.input.framework as string | undefined) ?? 'sklearn';
      const pythonVersion = (ctx.input.pythonVersion as string | undefined) ?? '3.11';
      // Default true to match the template's parameter default, so an older
      // template revision that omits the input still registers.
      const registerModel = (ctx.input.registerModel as boolean | undefined) ?? true;

      const deps = frameworkDeps[framework] ?? frameworkDeps.sklearn;
      const trainScript = buildTrainScript(framework, name, registerModel);
      const jobName = `${name}-initial-run`;

      ctx.logger.info(`Creating training job '${jobName}' in ml-platform (framework: ${framework}, python: ${pythonVersion})...`);

      await ensureKubeconfig();

      // Verify cluster is reachable
      try {
        await execAsync('kubectl cluster-info --request-timeout=5s', { env: kubeEnv, timeout: 10_000 });
      } catch (e: any) {
        throw new Error(`Cannot reach the Kubernetes cluster: ${e.message}`);
      }

      const useWorkflow = await workflowsAvailable();
      const minAccuracy = (ctx.input.minAccuracy as number | undefined) ?? 0;

      const yaml = useWorkflow
        ? buildWorkflowManifests({
            name, experimentName, pythonVersion, trainScript, deps, registerModel, minAccuracy,
          })
        : buildManifests({ name, experimentName, framework, pythonVersion, trainScript, deps });

      if (!useWorkflow) {
        ctx.logger.warn(
          'Argo Workflows is not installed (no workflowtemplates.argoproj.io CRD) — ' +
            'falling back to a single Kubernetes Job. The accuracy gate and the ' +
            'deploy approval step are skipped. Install the AI/ML layer to get them: ' +
            './scripts/bootstrap-ai.sh',
        );
      }

      const tmpFile = path.join(os.tmpdir(), `training-${useWorkflow ? 'workflow' : 'job'}-${name}-${Date.now()}.yaml`);
      let submittedWorkflow = '';
      try {
        await fs.writeFile(tmpFile, yaml, 'utf8');
        // `create` not `apply`: the Workflow uses generateName, which apply
        // rejects because it has no name to diff against.
        const verb = useWorkflow ? 'create' : 'apply';
        const { stdout, stderr } = await execAsync(`kubectl ${verb} -f ${tmpFile}`, { env: kubeEnv, timeout: 30_000 });
        if (stdout) {
          ctx.logger.info(stdout.trim());
          const m = stdout.match(/workflow\.argoproj\.io\/(\S+)\s+created/);
          if (m) submittedWorkflow = m[1];
        }
        if (stderr) ctx.logger.warn(stderr.trim());
      } finally {
        await fs.unlink(tmpFile).catch(() => undefined);
      }

      const mlflowExternalUrl = process.env.MLFLOW_EXTERNAL_URL ?? 'http://mlflow.idp.local';
      const argoExternalUrl = process.env.ARGO_WORKFLOWS_EXTERNAL_URL ?? 'http://argo-workflows.idp.local';
      const backstageBaseUrl = process.env.APP_BASE_URL ?? process.env.BACKSTAGE_URL ?? 'http://backstage.idp.local';

      if (useWorkflow) {
        ctx.logger.info(`✓ Workflow '${submittedWorkflow || `${name}-train-*`}' submitted to ml-platform`);
        ctx.logger.info(`  Steps: train → evaluate → register → deploy-gate (suspends for approval)`);
        ctx.logger.info(`  Resume the gate with: argo resume ${submittedWorkflow || '<workflow>'} -n ml-platform`);
        ctx.logger.info(`  Monitor: ${argoExternalUrl}`);
      } else {
        ctx.logger.info(`✓ Job '${jobName}' submitted to ml-platform namespace`);
        ctx.logger.info(`  Monitor: kubectl get pods -n ml-platform -l app=${name}`);
      }
      ctx.logger.info(`  Training will appear at ${mlflowExternalUrl} once the pod completes (~60–90s for image pull + training)`);

      ctx.output('mlflowUrl', mlflowExternalUrl);
      ctx.output('catalogUrl', `${backstageBaseUrl}/catalog/default/component/${name}`);
      ctx.output('jobName', useWorkflow ? '' : jobName);
      ctx.output('workflowName', submittedWorkflow);
      ctx.output('argoUrl', argoExternalUrl);
    },
  });
}

export const idpRunTrainingJobModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-run-training-job',
  register(env) {
    env.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint },
      async init({ scaffolder }) {
        scaffolder.addActions(createRunTrainingJobAction());
      },
    });
  },
});
