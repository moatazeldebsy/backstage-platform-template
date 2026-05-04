import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: ${{ values.vus }} },
    { duration: '${{ values.duration }}', target: ${{ values.vus }} },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<${{ values.p95Threshold }}'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.TARGET_URL || '${{ values.targetUrl }}';

export default function () {
  const res = http.get(`${BASE_URL}/`);
  check(res, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
    'response time ok': (r) => r.timings.duration < ${{ values.p95Threshold }},
  });
  sleep(1);
}
