"""
ML training script for ${{ values.experimentName }}.
Logs parameters, metrics, and artifacts to MLflow.
"""

import os
import mlflow
import mlflow.sklearn
import numpy as np
from sklearn.datasets import load_iris
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, f1_score
{%- if values.framework == 'sklearn' %}
from sklearn.ensemble import RandomForestClassifier
{%- elif values.framework == 'xgboost' %}
import xgboost as xgb
{%- elif values.framework == 'pytorch' %}
import torch
import torch.nn as nn
{%- endif %}

MLFLOW_TRACKING_URI = os.getenv("MLFLOW_TRACKING_URI", "http://localhost:5000")
EXPERIMENT_NAME = "${{ values.experimentName }}"
REGISTER_MODEL = ${{ 'True' if values.registerModel else 'False' }}

def main():
    mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
    mlflow.set_experiment(EXPERIMENT_NAME)

    # Load data
    X, y = load_iris(return_X_y=True)
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )

    # Hyperparameters
    params = {
        "n_estimators": int(os.getenv("N_ESTIMATORS", "100")),
        "max_depth": int(os.getenv("MAX_DEPTH", "5")),
        "random_state": 42,
    }

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
