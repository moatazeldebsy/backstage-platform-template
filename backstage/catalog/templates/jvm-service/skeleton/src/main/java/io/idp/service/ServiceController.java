package io.idp.service;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ServiceController {

    @GetMapping("/")
    public Map<String, String> root() {
        return Map.of("service", "${{ values.name }}", "status", "running");
    }

    @GetMapping("/healthz")
    public Map<String, String> healthz() {
        return Map.of("status", "ok");
    }

    @GetMapping("/ready")
    public Map<String, String> ready() {
        return Map.of("status", "ready");
    }
}
