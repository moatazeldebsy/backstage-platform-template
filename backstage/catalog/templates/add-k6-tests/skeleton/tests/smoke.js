import http from 'k6/http';
import { check, sleep } from 'k6';

// Smoke test: minimal load, verifies the service is alive
export const options = {
  vus: 1,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<${{ values.p95LatencyThresholdMs }}'],
  },
};

const BASE_URL = __ENV.BASE_URL || '${{ values.targetServiceUrl }}';

export default function () {
  const res = http.get(`${BASE_URL}/healthz`);
  check(res, {
    'healthz returns 200': (r) => r.status === 200,
    'healthz responds quickly': (r) => r.timings.duration < 500,
  });
  sleep(1);
}
