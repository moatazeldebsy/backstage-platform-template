"""
${{ values.name }} — ML Training Job
${{ values.description }}

Framework: ${{ values.modelFramework }}
MLflow experiment: ${{ values.mlflowExperiment }}

This module is the entry point run by the container and the Argo Workflow step.
Customize the load_data(), build_model(), and train() functions for your use-case.
All metrics, parameters, and model artifacts are automatically tracked in MLflow.
"""
import logging
import json
import os
import mlflow
import mlflow.sklearn  # swap for mlflow.pytorch / mlflow.tensorflow as needed
import numpy as np
from sklearn.datasets import load_iris
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, f1_score

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MLFLOW_TRACKING_URI = os.getenv(
    "MLFLOW_TRACKING_URI",
    "http://mlflow.ml-platform.svc.cluster.local:5000",
)
EXPERIMENT_NAME = os.getenv("MLFLOW_EXPERIMENT_NAME", "${{ values.mlflowExperiment }}")
MODEL_NAME = os.getenv("MODEL_NAME", "${{ values.name }}")


def load_data():
    """Load and split training data. Replace with your own data source."""
    data = load_iris()
    X_train, X_test, y_train, y_test = train_test_split(
        data.data, data.target, test_size=0.2, random_state=42
    )
    return X_train, X_test, y_train, y_test


def build_model(params: dict):
    """Build model from hyperparameters. Adapt to your framework."""
    return RandomForestClassifier(
        n_estimators=params.get("n_estimators", 100),
        max_depth=params.get("max_depth", None),
        random_state=42,
    )


def train():
    mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
    mlflow.set_experiment(EXPERIMENT_NAME)

    # Hyperparameters — override via env vars in the Argo Workflow step
    params = {
        "n_estimators": int(os.getenv("N_ESTIMATORS", "100")),
        "max_depth": os.getenv("MAX_DEPTH"),  # None = unlimited
    }
    if params["max_depth"] is not None:
        params["max_depth"] = int(params["max_depth"])

    with mlflow.start_run():
        mlflow.log_params(params)

        X_train, X_test, y_train, y_test = load_data()
        model = build_model(params)
        model.fit(X_train, y_train)

        preds = model.predict(X_test)
        accuracy = accuracy_score(y_test, preds)
        f1 = f1_score(y_test, preds, average="weighted")

        mlflow.log_metrics({"accuracy": accuracy, "f1_weighted": f1})
        logger.info(json.dumps({
            "msg": "training complete",
            "accuracy": round(accuracy, 4),
            "f1": round(f1, 4),
        }))

        mlflow.sklearn.log_model(
            model,
            artifact_path="model",
            registered_model_name=MODEL_NAME,
        )
        logger.info(json.dumps({"msg": "model registered", "name": MODEL_NAME}))


if __name__ == "__main__":
    train()
