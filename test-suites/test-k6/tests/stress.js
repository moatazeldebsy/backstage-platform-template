import http from 'k6/http';
import { check, sleep } from 'k6';

const PEAK = 10 * 3;
export const options = {
  stages: [
    { duration: '2m', target: 10 }, { duration: '5m', target: 10 },
    { duration: '2m', target: PEAK },       { duration: '5m', target: PEAK },
    { duration: '2m', target: 0 },
  ],
  thresholds: { http_req_duration: ['p(99)<2000'], http_req_failed: ['rate<0.05'] },
};

const BASE = __ENV.TARGET_URL || 'http://localhost:8080';
export default function () {
  check(http.get(`${BASE}/`), { 'status 2xx': (r) => r.status >= 200 && r.status < 300 });
  sleep(1);
}
