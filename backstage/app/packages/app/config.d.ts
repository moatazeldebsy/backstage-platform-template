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
}
