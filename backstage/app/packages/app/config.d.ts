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
