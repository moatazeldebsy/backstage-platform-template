import http from 'k6/http';
import { check, sleep } from 'k6';

const PEAK_VUS = ${{ values.vus }} * 3;

export const options = {
  stages: [
    { duration: '2m', target: ${{ values.vus }} },
    { duration: '5m', target: ${{ values.vus }} },
    { duration: '2m', target: PEAK_VUS },
    { duration: '5m', target: PEAK_VUS },
    { duration: '2m', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(99)<2000'],
    http_req_failed: ['rate<0.05'],
  },
};

const BASE_URL = __ENV.TARGET_URL || '${{ values.targetUrl }}';

export default function () {
  const res = http.get(`${BASE_URL}/`);
  check(res, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
  });
  sleep(1);
}
