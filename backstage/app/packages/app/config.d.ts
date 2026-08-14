export interface Config {
  /**
   * Links to platform tools (ArgoCD, Grafana, KAgent UI) shown in the Support
   * page and the custom Home dashboard's "Useful Links" widget. Populated
   * with real ALB hostnames by bootstrap.sh (AWS) / docker-compose (local) —
   * frontend visibility is required here or these silently fall back to
   * their hardcoded *.idp.local defaults in every environment, since
   * Backstage strips any config key without an explicit visibility
   * annotation from what's sent to the browser.
   */
  externalLinks?: {
    /**
     * @visibility frontend
     */
    argocd?: string;
    /**
     * @visibility frontend
     */
    grafana?: string;
    /**
     * @visibility frontend
     */
    kagent?: string;
    /**
     * @visibility frontend
     */
    mlflow?: string;
    /**
     * Langfuse UI. The annotation below was missing while every sibling had it,
     * so Backstage stripped this key from the config delivered to the browser and
     * consumers fell back to the hardcoded langfuse.idp.local default — on AWS as
     * well as locally, even though the ConfigMap held the correct ALB hostname.
     * Note the tag must be the LAST thing in this comment: prose placed after it
     * is parsed as part of the tag's value and fails schema validation with
     * `keyword "visibility" value is invalid`, which surfaces only during
     * `yarn build`, not `yarn tsc`. Observed 2026-08-13.
     *
     * @visibility frontend
     */
    langfuse?: string;
    /**
     * owner/repo that agent-event-router files incident issues into. Read by the
     * Incidents page and the per-entity Incidents tab; it must match
     * INCIDENT_REPO on that service or the UI reads an empty list while records
     * are being created somewhere else.
     *
     * This is not a URL like its siblings, but it belongs here for the same
     * reason: it is environment-specific configuration the frontend needs. It
     * was added to both app-configs without this annotation, so Backstage
     * stripped it and the page showed "incidentRepo is not set" on a cluster
     * where it was set — exactly the failure documented on `langfuse` above.
     *
     * @visibility frontend
     */
    incidentRepo?: string;
  };

  /**
   * Whether the AI/ML layer (KAgent, MLflow, the MCP servers, and the ADP
   * approval-service) is actually deployed to this cluster.
   *
   * Defaults to false: `bootstrap-local.sh` alone does not install any of it,
   * so a stock local platform must not advertise AI Assistant / Agent
   * Approvals / KAgent links that dead-end. `bootstrap-ai.sh` flips this to
   * true (and `--destroy` flips it back) via the generated
   * `local/backstage/app-config.ai.yaml` overlay.
   *
   * Page and nav-item visibility is handled separately, by the `app.extensions`
   * disable list in app-config.yaml. This flag covers the links that are
   * hardcoded into the custom Home/Support/Learning-Center pages, which the
   * extension system cannot reach.
   */
  aiStack?: {
    /**
     * @visibility frontend
     */
    enabled?: boolean;
  };
}
