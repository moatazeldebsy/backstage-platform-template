"""
ML training script for ${{ values.experimentName }}.
Logs parameters, metrics, and artifacts to MLflow.
"""

import os

import mlflow
{%- if values.framework == 'sklearn' %}
import mlflow.sklearn
{%- elif values.framework == 'xgboost' %}
import mlflow.xgboost
import xgboost as xgb
{%- endif %}
from sklearn.datasets import load_iris
{%- if values.framework == 'sklearn' %}
from sklearn.ensemble import RandomForestClassifier
{%- endif %}
{%- if values.framework == 'sklearn' %}
from sklearn.metrics import accuracy_score, f1_score
{%- else %}
from sklearn.metrics import accuracy_score
{%- endif %}
from sklearn.model_selection import train_test_split

MLFLOW_TRACKING_URI = os.getenv("MLFLOW_TRACKING_URI", "http://localhost:5000")
EXPERIMENT_NAME = "${{ values.experimentName }}"
REGISTER_MODEL = ${{ 'True' if values.registerModel else 'False' }}

def build_params():
    """Hyperparameters, read from the environment so CI and local runs can
    override them without editing this file. Kept out of main() so it can be
    unit-tested without an MLflow server."""
    return {
        "n_estimators": int(os.getenv("N_ESTIMATORS", "100")),
        "max_depth": int(os.getenv("MAX_DEPTH", "5")),
        "random_state": 42,
    }


def main():
    mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
    mlflow.set_experiment(EXPERIMENT_NAME)

    # Load data
    X, y = load_iris(return_X_y=True)
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )

    params = build_params()

    with mlflow.start_run(run_name="training-run"):
        mlflow.log_params(params)

{%- if values.framework == 'sklearn' %}
        model = RandomForestClassifier(**params)
        model.fit(X_train, y_train)
        preds = model.predict(X_test)

        acc = accuracy_score(y_test, preds)
        f1 = f1_score(y_test, preds, average="weighted")
        mlflow.log_metric("accuracy", acc)
        mlflow.log_metric("f1_score", f1)
        print(f"Accuracy: {acc:.4f} | F1: {f1:.4f}")

        if REGISTER_MODEL:
            mlflow.sklearn.log_model(
                model,
                artifact_path="model",
                registered_model_name="${{ values.name }}-model",
            )
{%- elif values.framework == 'xgboost' %}
        dtrain = xgb.DMatrix(X_train, label=y_train)
        dtest = xgb.DMatrix(X_test, label=y_test)
        bst = xgb.train({"max_depth": params["max_depth"], "objective": "multi:softmax", "num_class": 3}, dtrain, num_boost_round=params["n_estimators"])
        preds = bst.predict(dtest).astype(int)
        acc = accuracy_score(y_test, preds)
        mlflow.log_metric("accuracy", acc)
        print(f"Accuracy: {acc:.4f}")
        if REGISTER_MODEL:
            mlflow.xgboost.log_model(bst, "model", registered_model_name="${{ values.name }}-model")
{%- endif %}

        print(f"Run logged to {MLFLOW_TRACKING_URI}/experiments")

if __name__ == "__main__":
    main()
