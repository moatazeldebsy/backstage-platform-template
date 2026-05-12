Feature: hello-service health

  Scenario: Liveness probe returns 200
    Given the service is running at "http://localhost:3000"
    When I request "/healthz"
    Then the response status should be 200

  Scenario: Readiness probe returns 200
    Given the service is running at "http://localhost:3000"
    When I request "/ready"
    Then the response status should be 200
