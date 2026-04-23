import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

const latency = new Trend('custom_latency_ms', true);
const errors = new Rate('custom_error_rate');
const requests = new Counter('custom_requests_total');

const BASE_URL = __ENV.BASE_URL || '${{ values.targetServiceUrl }}';

// Ramping load: warm up → peak → cool down
export const options = {
  stages: [
    { duration: '1m', target: Math.floor(${{ values.virtualUsers }} * 0.5) },  // ramp up
    { duration: '3m', target: ${{ values.virtualUsers }} },                     // peak
    { duration: '1m', target: 0 },                                              // ramp down
  ],
  thresholds: {
    http_req_failed: ['rate<${{ values.errorRateThreshold / 100 }}'],
    http_req_duration: ['p(95)<${{ values.p95LatencyThresholdMs }}', 'p(99)<${{ values.p95LatencyThresholdMs * 2 }}'],
    custom_error_rate: ['rate<${{ values.errorRateThreshold / 100 }}'],
  },
};

export default function () {
  const start = Date.now();

  // Main endpoint load
  const res = http.get(`${BASE_URL}/`, {
    headers: { Accept: 'application/json' },
  });

  const duration = Date.now() - start;
  latency.add(duration);
  errors.add(res.status >= 400);
  requests.add(1);

  check(res, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
    'response time OK': (r) => r.timings.duration < ${{ values.p95LatencyThresholdMs }},
  });

  // Readiness probe
  const ready = http.get(`${BASE_URL}/ready`);
  check(ready, { 'ready returns 200': (r) => r.status === 200 });

  sleep(Math.random() * 2 + 0.5);
}

export function handleSummary(data) {
  return {
    'k6-summary.json': JSON.stringify(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
