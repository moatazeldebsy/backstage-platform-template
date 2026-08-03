"""Unit tests for ${{ values.experimentName }}.

Kept at the repo root (not under tests/) so `import train` resolves — pytest
puts the rootdir on sys.path, but a tests/ package would shadow that.

These cover the parts of train.py that do not need a running MLflow server;
the end-to-end training run is covered by the "Training smoke test" job in
.github/workflows/ci.yml.
"""

import train


def test_build_params_defaults(monkeypatch):
    monkeypatch.delenv("N_ESTIMATORS", raising=False)
    monkeypatch.delenv("MAX_DEPTH", raising=False)

    params = train.build_params()

    assert params["n_estimators"] == 100
    assert params["max_depth"] == 5
    assert params["random_state"] == 42


def test_build_params_reads_environment(monkeypatch):
    monkeypatch.setenv("N_ESTIMATORS", "7")
    monkeypatch.setenv("MAX_DEPTH", "3")

    params = train.build_params()

    assert params["n_estimators"] == 7
    assert params["max_depth"] == 3


def test_build_params_are_ints(monkeypatch):
    monkeypatch.setenv("N_ESTIMATORS", "42")

    params = train.build_params()

    assert all(isinstance(v, int) for v in params.values())


def test_experiment_is_configured():
    assert train.EXPERIMENT_NAME
    assert train.MLFLOW_TRACKING_URI.startswith("http")
    assert isinstance(train.REGISTER_MODEL, bool)
