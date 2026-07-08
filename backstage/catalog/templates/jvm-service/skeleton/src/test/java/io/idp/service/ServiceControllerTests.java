package io.idp.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.boot.test.context.SpringBootTest.WebEnvironment.RANDOM_PORT;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;

@SpringBootTest(webEnvironment = RANDOM_PORT)
class ServiceControllerTests {

    @Autowired
    private TestRestTemplate restTemplate;

    @Test
    void healthzReturnsOk() {
        var response = restTemplate.getForObject("/healthz", Map.class);
        assertThat(response.get("status")).isEqualTo("ok");
    }

    @Test
    void readyReturnsReady() {
        var response = restTemplate.getForObject("/ready", Map.class);
        assertThat(response.get("status")).isEqualTo("ready");
    }

    @Test
    void rootReturnsServiceInfo() {
        var response = restTemplate.getForObject("/", Map.class);
        assertThat(response).containsKey("status");
    }

    @Test
    void prometheusEndpointIsExposed() {
        var response = restTemplate.getForEntity("/actuator/prometheus", String.class);
        assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
    }
}
