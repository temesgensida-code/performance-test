import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const BASE_URL = __ENV.TARGET_URL || 'http://api:8000';
const VOLUME_DURATION = __ENV.VOLUME_DURATION || '5m';
const VOLUME_VUS = parseInt(__ENV.VOLUME_VUS || '30', 10);

// Custom Metrics for Volume Degradation Analysis
const feedShallowLatency = new Trend('feed_shallow_latency');
const feedDeepLatency = new Trend('feed_deep_latency');
const matchesLatency = new Trend('matches_volume_latency');
const userProfileLatency = new Trend('user_profile_latency');
const postWriteLatency = new Trend('posts_write_latency');
const deepPaginationErrors = new Rate('deep_pagination_errors');

export const options = {
  stages: [
    { duration: '1m', target: Math.min(10, VOLUME_VUS) }, // Ramp-up & warm-up (10 VUs)
    { duration: '3m', target: VOLUME_VUS },                // Sustained volume load (30 VUs)
    { duration: '1m', target: 0 },                         // Graceful ramp-down
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],                        // Overall error rate < 5%
    feed_shallow_latency: ['p(95)<150'],                   // Shallow cache reads < 150ms
    feed_deep_latency: ['p(95)<2500'],                     // Deep pagination SLA < 2.5s
    deep_pagination_errors: ['rate<0.05'],
  },
};

export function setup() {
  const users = [];
  const numAuthUsers = 12;

  // Log in a pool of pre-seeded volume users (or register fallback users)
  for (let i = 1; i <= numAuthUsers; i++) {
    const username = `vol_user_${i}`;
    const password = 'password123';

    let loginRes = http.post(
      `${BASE_URL}/api/v1/auth/login`,
      `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    let token = null;
    let userId = null;

    if (loginRes.status === 200) {
      const data = loginRes.json();
      token = data.access_token;
    } else {
      // Fallback: register fresh test user if volume users not present
      const fallbackUsername = `vol_test_${Date.now().toString().slice(-6)}_${i}`;
      http.post(
        `${BASE_URL}/api/v1/auth/register`,
        JSON.stringify({
          username: fallbackUsername,
          email: `${fallbackUsername}@example.com`,
          password: password,
          display_name: `Volume Test User ${i}`,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );

      loginRes = http.post(
        `${BASE_URL}/api/v1/auth/login`,
        `username=${encodeURIComponent(fallbackUsername)}&password=${encodeURIComponent(password)}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      if (loginRes.status === 200) {
        token = loginRes.json().access_token;
      }
    }

    if (token) {
      // Get current user id
      const meRes = http.get(`${BASE_URL}/api/v1/users/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (meRes.status === 200) {
        userId = meRes.json().id;
      }
      users.push({ token, username, id: userId || i });
    }
  }

  if (users.length === 0) {
    throw new Error('Setup failed: Could not authenticate any users for volume test.');
  }

  return { users };
}

export default function (data) {
  const user = data.users[Math.floor(Math.random() * data.users.length)];
  const authHeaders = {
    Authorization: `Bearer ${user.token}`,
    'Content-Type': 'application/json',
  };

  const rand = Math.random();

  if (rand < 0.60) {
    // -------------------------------------------------------------------------
    // 1. Shallow Feed (60%): page 1 to 5 (Cache hit evaluation under volume)
    // -------------------------------------------------------------------------
    const page = Math.floor(Math.random() * 5) + 1;
    const res = http.get(`${BASE_URL}/api/v1/feed?page=${page}&page_size=20`, {
      headers: authHeaders,
      tags: { query_type: 'feed_shallow' },
    });

    feedShallowLatency.add(res.timings.duration);
    check(res, {
      'shallow feed status is 200': (r) => r.status === 200,
    });

  } else if (rand < 0.85) {
    // -------------------------------------------------------------------------
    // 2. Deep Pagination (25%): page 50 to 500 (PostgreSQL OFFSET/LIMIT penalty)
    // -------------------------------------------------------------------------
    const page = Math.floor(Math.random() * 450) + 50; // page 50 to 499 (offset 980 to 9980)
    const res = http.get(`${BASE_URL}/api/v1/feed?page=${page}&page_size=20`, {
      headers: authHeaders,
      tags: { query_type: 'feed_deep' },
    });

    feedDeepLatency.add(res.timings.duration);
    const passed = check(res, {
      'deep feed status is 200': (r) => r.status === 200,
    });
    deepPaginationErrors.add(!passed);

  } else if (rand < 0.95) {
    // -------------------------------------------------------------------------
    // 3. Large Matches & Profiles (10%): Large joins & index lookups
    // -------------------------------------------------------------------------
    if (Math.random() < 0.5) {
      const res = http.get(`${BASE_URL}/api/v1/matches`, {
        headers: authHeaders,
        tags: { query_type: 'matches' },
      });
      matchesLatency.add(res.timings.duration);
      check(res, {
        'matches status is 200': (r) => r.status === 200,
      });
    } else {
      // Pick random user ID from the 20,000 volume pool
      const randomUserId = Math.floor(Math.random() * 19000) + 40;
      const res = http.get(`${BASE_URL}/api/v1/users/${randomUserId}`, {
        headers: authHeaders,
        tags: { query_type: 'user_profile' },
      });
      userProfileLatency.add(res.timings.duration);
      check(res, {
        'profile status is 200 or 404': (r) => r.status === 200 || r.status === 404,
      });
    }

  } else {
    // -------------------------------------------------------------------------
    // 4. Concurrent Post Insertions (5%): B-Tree index insertion depth
    // -------------------------------------------------------------------------
    const payload = JSON.stringify({
      content: `Live volume write test post at timestamp ${Date.now()}`,
    });
    const res = http.post(`${BASE_URL}/api/v1/posts`, payload, {
      headers: authHeaders,
      tags: { query_type: 'post_create' },
    });
    postWriteLatency.add(res.timings.duration);
    check(res, {
      'post created is 201': (r) => r.status === 201,
    });
  }

  // Pacing jitter between requests
  sleep(0.05 + Math.random() * 0.1);
}

export function teardown(data) {
  // Volume tests preserve dataset for subsequent runs and analysis
}
