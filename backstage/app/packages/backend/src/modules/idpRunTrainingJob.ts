import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node/alpha';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

const kubeEnv = {
  ...process.env,
  KUBECONFIG: process.env.KUBECONFIG ?? '/tmp/kubeconfig',
};

const frameworkDeps: Record<string, string> = {
  sklearn: 'scikit-learn numpy',
  xgboost: 'xgboost scikit-learn numpy',
  pytorch: 'torch scikit-learn numpy',
  tensorflow: 'tensorflow scikit-learn numpy',
};

// Minimal but real training script: trains on Iris, logs to MLflow.
// Reads MLFLOW_TRACKING_URI and MLFLOW_EXPERIMENT_NAME from env.
function buildTrainScript(framework: string): string {
  const isXgboost = framework === 'xgboost';
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
    mlflow.sklearn.log_model(model, "model")
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
  const { name, experimentName, framework, pythonVersion, trainScript, deps } = opts;
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
    spec:
      restartPolicy: Never
      containers:
        - name: train
          image: python:${pythonVersion}-slim
          command: ["/bin/sh", "-c"]
          args:
            - pip install --quiet mlflow ${deps} && python /app/train.py
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

function createRunTrainingJobAction() {
  return createTemplateAction({
    id: 'idp:run-training-job',
    description: 'Create a Kubernetes Job in ml-platform that runs the initial training and logs metrics to the in-cluster MLflow.',
    schema: {
      input: {
        required: ['name', 'experimentName'],
        type: 'object',
        properties: {
          name: { type: 'string', title: 'Experiment repo name' },
          experimentName: { type: 'string', title: 'MLflow experiment name' },
          framework: { type: 'string', title: 'ML framework', default: 'sklearn' },
          pythonVersion: { type: 'string', title: 'Python version', default: '3.11' },
        },
      },
      output: {
        type: 'object',
        properties: {
          mlflowUrl: { type: 'string', title: 'MLflow UI URL' },
          jobName: { type: 'string', title: 'Kubernetes Job name' },
        },
      },
    },

    async handler(ctx) {
      const name = ctx.input['name'] as string;
      const experimentName = ctx.input['experimentName'] as string;
      const framework = (ctx.input['framework'] as string | undefined) ?? 'sklearn';
      const pythonVersion = (ctx.input['pythonVersion'] as string | undefined) ?? '3.11';

      const deps = frameworkDeps[framework] ?? frameworkDeps['sklearn'];
      const trainScript = buildTrainScript(framework);
      const jobName = `${name}-initial-run`;

      ctx.logger.info(`Creating training job '${jobName}' in ml-platform (framework: ${framework}, python: ${pythonVersion})...`);

      // Verify cluster is reachable
      try {
        await execAsync('kubectl cluster-info --request-timeout=5s', { env: kubeEnv });
      } catch (e: any) {
        throw new Error(`Cannot reach the Kind cluster: ${e.message}`);
      }

      const yaml = buildManifests({ name, experimentName, framework, pythonVersion, trainScript, deps });

      const tmpFile = path.join(os.tmpdir(), `training-job-${name}-${Date.now()}.yaml`);
      try {
        await fs.writeFile(tmpFile, yaml, 'utf8');
        const { stdout, stderr } = await execAsync(`kubectl apply -f ${tmpFile}`, { env: kubeEnv });
        if (stdout) ctx.logger.info(stdout.trim());
        if (stderr) ctx.logger.warn(stderr.trim());
      } finally {
        await fs.unlink(tmpFile).catch(() => undefined);
      }

      ctx.logger.info(`✓ Job '${jobName}' submitted to ml-platform namespace`);
      ctx.logger.info(`  Training will appear at http://mlflow.idp.local once the pod completes (~60–90s for image pull + training)`);
      ctx.logger.info(`  Monitor: kubectl get pods -n ml-platform -l app=${name}`);

      ctx.output('mlflowUrl', 'http://mlflow.idp.local');
      ctx.output('jobName', jobName);
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
