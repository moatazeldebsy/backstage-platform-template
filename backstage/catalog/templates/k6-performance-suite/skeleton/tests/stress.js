import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || '${{ values.targetServiceUrl }}';
const PEAK_VUS = ${{ values.virtualUsers }};

// Stress test: push beyond normal load to find the breaking point
export const options = {
  stages: [
    { duration: '2m', target: PEAK_VUS },
    { duration: '3m', target: PEAK_VUS * 2 },
    { duration: '2m', target: PEAK_VUS * 3 },
    { duration: '2m', target: 0 },
  ],
  thresholds: {
    // Stress thresholds are deliberately relaxed — the goal is observation, not hard failure
    http_req_failed: ['rate<0.10'],
    http_req_duration: ['p(99)<${{ values.p95LatencyThresholdMs * 4 }}'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/`);
  check(res, { 'status < 500': (r) => r.status < 500 });
  sleep(0.5);
}
