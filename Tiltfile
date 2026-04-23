# Tiltfile — hot-reload dev environment for IDP MVP
# Requirements: tilt, kind cluster running (./scripts/bootstrap-local.sh)
# Usage: tilt up

LOCAL_REGISTRY = "localhost:5003"

# ── hello-service (full hot-reload — source lives in this repo) ───────────────
docker_build(
    ref          = LOCAL_REGISTRY + "/hello-service",
    context      = "services/hello-service",
    dockerfile   = "services/hello-service/Dockerfile",
    live_update  = [
        # Sync Go source changes — triggers a rebuild (Go compiles fast)
        sync("services/hello-service/src/", "/app/src/"),
    ],
    build_args   = {"VERSION": "tilt-dev"},
)

k8s_yaml(helm(
    "helm/service-template",
    name      = "hello-service",
    namespace = "services",
    set       = [
        "image.repository=" + LOCAL_REGISTRY + "/hello-service",
        "image.tag=latest",
    ],
    values    = ["services/hello-service/helm-values-local.yaml"],
))

k8s_resource(
    "hello-service",
    port_forwards = ["8080:8080"],
    labels        = ["services"],
)

# ── Auto-discover scaffolded services ─────────────────────────────────────────
# Any service under services/<name>/ that has a helm-values-local.yaml is
# deployed automatically. Build and push the image first:
#
#   docker build -t localhost:5003/<name>:local <path-to-source>
#   docker push localhost:5003/<name>:local
#
# Tilt will deploy it to Kind and watch for image updates.

for svc in listdir("services"):
    local_values = "services/" + svc + "/helm-values-local.yaml"
    if svc == "hello-service" or not os.path.exists(local_values):
        continue

    k8s_yaml(helm(
        "helm/service-template",
        name      = svc,
        namespace = "services",
        set       = ["image.repository=" + LOCAL_REGISTRY + "/" + svc],
        values    = [local_values],
    ))

    k8s_resource(
        svc,
        labels = ["services"],
    )
