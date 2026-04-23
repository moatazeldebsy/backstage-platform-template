"""
Tool stubs for ${{ values.name }}.

Each tool is a plain callable decorated with @tool.
Replace the stub bodies with real implementations.

Tools enabled for this agent: ${{ values.tools | join(', ') }}
"""
from langchain_core.tools import tool


{%- if 'web_search' in values.tools %}


@tool
def web_search(query: str) -> str:
    """Search the web for up-to-date information about a topic."""
    # TODO: replace with a real search API (Tavily, SerpAPI, etc.)
    return f"[stub] web_search result for: {query}"
{%- endif %}
{%- if 'k8s_lookup' in values.tools %}


@tool
def k8s_lookup(resource: str) -> str:
    """Look up the status of a Kubernetes resource by name (e.g. 'pod/my-pod')."""
    # TODO: use the Kubernetes Python client with in-cluster credentials
    return f"[stub] k8s_lookup result for: {resource}"
{%- endif %}
{%- if 'mlflow_query' in values.tools %}


@tool
def mlflow_query(experiment_name: str) -> str:
    """Query MLflow for the best run in an experiment and return its metrics."""
    import os
    import mlflow

    tracking_uri = os.getenv(
        "MLFLOW_TRACKING_URI",
        "http://mlflow.ml-platform.svc.cluster.local:5000",
    )
    mlflow.set_tracking_uri(tracking_uri)
    try:
        runs = mlflow.search_runs(
            experiment_names=[experiment_name],
            order_by=["metrics.accuracy DESC"],
            max_results=1,
        )
        if runs.empty:
            return f"No runs found for experiment '{experiment_name}'"
        best = runs.iloc[0]
        return f"Best run {best['run_id']}: accuracy={best.get('metrics.accuracy', 'N/A')}"
    except Exception as exc:
        return f"mlflow_query error: {exc}"
{%- endif %}
{%- if 'calculator' in values.tools %}


@tool
def calculator(expression: str) -> str:
    """Evaluate a simple arithmetic expression (e.g. '2 + 2 * 10')."""
    # ast.literal_eval can't do math; use a safe eval limited to numeric ops
    import ast
    import operator as op

    allowed_ops: dict = {
        ast.Add: op.add,
        ast.Sub: op.sub,
        ast.Mult: op.mul,
        ast.Div: op.truediv,
        ast.Pow: op.pow,
        ast.USub: op.neg,
    }

    def _eval(node: ast.AST) -> float:
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return float(node.value)
        if isinstance(node, ast.BinOp) and type(node.op) in allowed_ops:
            return allowed_ops[type(node.op)](_eval(node.left), _eval(node.right))
        if isinstance(node, ast.UnaryOp) and type(node.op) in allowed_ops:
            return allowed_ops[type(node.op)](_eval(node.operand))
        raise ValueError(f"Unsupported expression: {ast.dump(node)}")

    try:
        tree = ast.parse(expression, mode="eval")
        result = _eval(tree.body)
        return str(result)
    except Exception as exc:
        return f"calculator error: {exc}"
{%- endif %}


# Registry — collected by agent.py
TOOLS = [
{%- if 'web_search' in values.tools %}
    web_search,
{%- endif %}
{%- if 'k8s_lookup' in values.tools %}
    k8s_lookup,
{%- endif %}
{%- if 'mlflow_query' in values.tools %}
    mlflow_query,
{%- endif %}
{%- if 'calculator' in values.tools %}
    calculator,
{%- endif %}
]
