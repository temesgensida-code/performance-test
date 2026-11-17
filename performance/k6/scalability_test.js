import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const BASE_URL = __ENV.TARGET_URL || 'http://api:8000';
const DURATION = __ENV.SCALABILITY_DURATION || '3m';
const VUS = parseInt(__ENV.SCALABILITY_VUS || '40', 10);
const PASSWORD = 'SmokePassword123!';

// Custom Metrics for Scalability Analysis
const authLoginLatency = new Trend('auth_login_latency');
const authLoginRps = new Counter('auth_login_success');
const taskDispatchLatency = new Trend('task_dispatch_latency');
const taskDispatched = new Counter('tasks_dispatched_total');
const feedReadLatency = new Trend('feed_read_latency');
const feedDeepLatency = new Trend('feed_deep_latency');
const matchesLatency = new Trend('matches_query_latency');
const scalabilityErrors = new Rate('scalability_errors');

export const options = {
  setupTimeout: '45s',
  stages: [
    { duration: '20s', target: Math.min(15, VUS) }, // Ramp-up
    { duration: DURATION, target: VUS },             // Sustained scaling load
    { duration: '15s', target: 0 },                  // Ramp-down
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],                 // Error rate < 5%
    auth_login_latency: ['p(95)<5000'],             // Login SLA under single-worker queuing
    task_dispatch_latency: ['p(95)<1500'],           // Task enqueueing SLA under worker contention
    feed_read_latency: ['p(95)<1500'],               // Cached reads SLA during event loop saturation
  },
};

export function setup() {
  const users = [];
  const numAuthUsers = 6;

  for (let i = 1; i <= numAuthUsers; i++) {
    const username = `vol_user_${i}`;

    let loginRes = http.post(
      `${BASE_URL}/api/v1/auth/login`,
      `username=${encodeURIComponent(username)}&password=${encodeURIComponent(PASSWORD)}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    let token = null;
    let userId = null;

    if (loginRes.status === 200) {
      token = loginRes.json().access_token;
    } else {
      // Fallback: register fresh user
      const fallbackUser = `scale_user_${Date.now().toString().slice(-6)}_${i}`;
      http.post(
        `${BASE_URL}/api/v1/auth/register`,
        JSON.stringify({
          username: fallbackUser,
          email: `${fallbackUser}@example.com`,
          password: PASSWORD,
          display_name: `Scale User ${i}`,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );

      loginRes = http.post(
        `${BASE_URL}/api/v1/auth/login`,
        `username=${encodeURIComponent(fallbackUser)}&password=${encodeURIComponent(PASSWORD)}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      if (loginRes.status === 200) {
        token = loginRes.json().access_token;
      }
    }

    if (token) {
      const meRes = http.get(`${BASE_URL}/api/v1/users/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (meRes.status === 200) {
        userId = meRes.json().id;
      }
      users.push({ token, username, id: userId || i, password: PASSWORD });
    }
  }

  if (users.length === 0) {
    throw new Error('Setup failed: Could not authenticate test users for scalability testing.');
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

  if (rand < 0.40) {
    // -------------------------------------------------------------------------
    // 1. CPU-Bound Web Worker Scaling (40%): Login with bcrypt.checkpw
    // -------------------------------------------------------------------------
    const targetUser = `vol_user_${Math.floor(Math.random() * 20) + 1}`;
    const res = http.post(
      `${BASE_URL}/api/v1/auth/login`,
      `username=${encodeURIComponent(targetUser)}&password=${encodeURIComponent(PASSWORD)}`,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        tags: { dimension: 'cpu_worker_scaling' },
      }
    );

    authLoginLatency.add(res.timings.duration);
    const passed = check(res, {
      'login status is 200': (r) => r.status === 200,
    });
    if (passed) {
      authLoginRps.add(1);
    } else {
      scalabilityErrors.add(1);
    }

  } else if (rand < 0.75) {
    // -------------------------------------------------------------------------
    // 2. Celery Worker & Queue Scaling (35%): Background async dispatch
    // -------------------------------------------------------------------------
    if (Math.random() < 0.5) {
      // Profile Interests update -> triggers Celery recompute_matches.delay
      const interestTags = ['python', 'database', 'scalability', 'ai', 'cloud', 'backend'];
      const chosenInterests = interestTags
        .sort(() => 0.5 - Math.random())
        .slice(0, 3);

      const payload = JSON.stringify({
        interests: chosenInterests,
        bio: `Updated at ${Date.now()} to benchmark Celery worker drain rate.`,
      });

      const res = http.patch(`${BASE_URL}/api/v1/users/me`, payload, {
        headers: authHeaders,
        tags: { dimension: 'celery_worker_scaling' },
      });

      taskDispatchLatency.add(res.timings.duration);
      const passed = check(res, {
        'profile updated and match task queued': (r) => r.status === 200,
      });
      if (passed) {
        taskDispatched.add(1);
      } else {
        scalabilityErrors.add(1);
      }

    } else {
      // Post creation -> triggers Celery fanout_feed_invalidation.delay
      const payload = JSON.stringify({
        content: `Scalability benchmark post at timestamp ${Date.now()}`,
      });

      const res = http.post(`${BASE_URL}/api/v1/posts`, payload, {
        headers: authHeaders,
        tags: { dimension: 'celery_worker_scaling' },
      });

      taskDispatchLatency.add(res.timings.duration);
      const passed = check(res, {
        'post created and fanout queued': (r) => r.status === 201,
      });
      if (passed) {
        taskDispatched.add(1);
      } else {
        scalabilityErrors.add(1);
      }
    }

  } else {
    // -------------------------------------------------------------------------
    // 3. Database Connection Pool & Read Scaling (25%)
    // -------------------------------------------------------------------------
    if (Math.random() < 0.6) {
      // Cached feed read
      const res = http.get(`${BASE_URL}/api/v1/feed?page=1&page_size=20`, {
        headers: authHeaders,
        tags: { dimension: 'read_cache_scaling' },
      });
      feedReadLatency.add(res.timings.duration);
      check(res, {
        'cached feed status is 200': (r) => r.status === 200,
      });
    } else if (Math.random() < 0.85) {
      // Deep pagination query against 500k rows
      const deepPage = Math.floor(Math.random() * 200) + 50;
      const res = http.get(`${BASE_URL}/api/v1/feed?page=${deepPage}&page_size=20`, {
        headers: authHeaders,
        tags: { dimension: 'db_pool_scaling' },
      });
      feedDeepLatency.add(res.timings.duration);
      check(res, {
        'deep feed status is 200': (r) => r.status === 200,
      });
    } else {
      // Matches join query
      const res = http.get(`${BASE_URL}/api/v1/matches`, {
        headers: authHeaders,
        tags: { dimension: 'db_pool_scaling' },
      });
      matchesLatency.add(res.timings.duration);
      check(res, {
        'matches query status is 200': (r) => r.status === 200,
      });
    }
  }

  // Small pacing interval
  sleep(0.05 + Math.random() * 0.05);
}

export function teardown(data) {
  // Graceful cleanup
}
