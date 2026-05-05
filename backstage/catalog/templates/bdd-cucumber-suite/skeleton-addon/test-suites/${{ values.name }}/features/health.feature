Feature: ${{ values.targetService }} health

  As an operator
  I want the service to report its health
  So that I know it is running correctly

  Scenario: Liveness probe returns 200
    Given the service is running at "${{ values.baseUrl }}"
    When I request "/healthz"
    Then the response status should be 200

  Scenario: Readiness probe returns 200
    Given the service is running at "${{ values.baseUrl }}"
    When I request "/ready"
    Then the response status should be 200
