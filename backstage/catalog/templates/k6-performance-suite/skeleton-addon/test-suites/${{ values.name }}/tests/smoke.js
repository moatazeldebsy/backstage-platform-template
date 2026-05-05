import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<${{ values.p95Threshold }}'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.TARGET_URL || '${{ values.targetUrl }}';

export default function () {
  const res = http.get(`${BASE_URL}/healthz`);
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < ${{ values.p95Threshold }}ms': (r) => r.timings.duration < ${{ values.p95Threshold }},
  });
  sleep(1);
}
