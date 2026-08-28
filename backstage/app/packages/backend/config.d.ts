export interface Config {
  /**
   * Engineering Intelligence — the scoring layer over the platform's existing
   * telemetry. Every key is optional; with the block absent the plugin runs on
   * its defaults and reads the same `proxy.endpoints` targets the frontend uses.
   *
   * Backend-only by design: no `@visibility frontend` annotations here, because
   * scores reach the browser through the plugin's API rather than through config.
   */
  engineeringIntelligence?: {
    /**
     * Minutes between scheduled refreshes. Defaults to 30, matching the
     * Tech Insights fact-retriever cadence it reads from — collecting more often
     * than the facts are recomputed would record the same numbers repeatedly.
     */
    refreshMinutes?: number;

    /**
     * Per-source kill switches, for environments where a source is not deployed.
     * Each defaults to true; a source that is enabled but unreachable simply
     * produces no samples, so switching one off is an optimisation rather than a
     * requirement.
     */
    sources?: {
      prometheus?: boolean;
      opencost?: boolean;
      langfuse?: boolean;
      catalog?: boolean;
      techInsights?: boolean;
    };

    /**
     * Relative weight of each dimension in the overall Engineering Health score.
     * Defaults to 1 apiece. Unknown keys and non-positive values are ignored
     * rather than throwing, so a typo degrades to the default weighting instead
     * of taking the backend down at startup.
     */
    weights?: {
      platform?: number;
      devEx?: number;
      quality?: number;
      reliability?: number;
      aiEngineering?: number;
      security?: number;
      finops?: number;
    };
  };

  /**
   * Langfuse project credentials, for server-side collection.
   *
   * The frontend never holds these — the `/langfuse` proxy endpoint injects HTTP
   * Basic auth on its behalf. A backend collector calls Langfuse directly and so
   * needs them in config. Without them the AI observability signal is reported
   * as unavailable rather than assumed absent.
   */
  langfuse?: {
    publicKey?: string;
    /**
     * @visibility secret
     */
    secretKey?: string;
  };
}
