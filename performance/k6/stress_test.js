import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.TARGET_URL || 'http://api:8000';

export const options = {
  scenarios: {
    stress_trajectory: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        // Stage 1: Warmup / Normal Baseline
        { duration: '30s', target: 20 },
        { duration: '1m', target: 20 },
        // Stage 2: Moderate Stress (Approaching capacity)
        { duration: '1m', target: 80 },
        { duration: '1m30s', target: 80 },
        // Stage 3: Peak Saturation (Beyond capacity: CPU, DB pool, Celery saturation)
        { duration: '1m', target: 150 },
        { duration: '1m30s', target: 150 },
        // Stage 4: Cooldown / Recovery (Testing self-healing behavior)
        { duration: '30s', target: 10 },
        { duration: '1m', target: 10 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // Generous thresholds to observe full saturation and recovery without premature test abort
    http_req_failed: ['rate<0.15'],    // Max 15% error rate during extreme saturation
    http_req_duration: ['p(95)<2500'], // Peak p95 latency allowance under 150 VUs
  },
};

export function setup() {
  const numUsers = 20;
  const users = [];
  const baseTimestamp = Date.now().toString().slice(-6);

  // 1. Provision user pool
  for (let i = 0; i < numUsers; i++) {
    const username = `str_${baseTimestamp}_${i}`.slice(0, 28);
    const email = `${username}@example.com`;
    const password = 'StressPassword123!';
    const displayName = `Stress User ${i}`;

    http.post(
      `${BASE_URL}/api/v1/auth/register`,
      JSON.stringify({
        username: username,
        email: email,
        password: password,
        display_name: displayName,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );

    const loginRes = http.post(
      `${BASE_URL}/api/v1/auth/login`,
      `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    if (loginRes.status === 200) {
      const token = loginRes.json('access_token');
      const meRes = http.get(`${BASE_URL}/api/v1/users/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const userId = meRes.status === 200 ? meRes.json('id') : null;

      if (userId && token) {
        users.push({
          id: userId,
          username: username,
          password: password,
          token: token,
        });
      }
    }
  }

  // 2. Establish dense follower connections and seed initial posts
  for (let i = 0; i < users.length; i++) {
    const currentUser = users[i];
    const authHeaders = {
      headers: {
        Authorization: `Bearer ${currentUser.token}`,
        'Content-Type': 'application/json',
      },
    };

    const target1 = (i + 1) % users.length;
    const target2 = (i + 2) % users.length;
    const target3 = (i + 3) % users.length;

    http.post(`${BASE_URL}/api/v1/users/${users[target1].id}/follow`, null, authHeaders);
    http.post(`${BASE_URL}/api/v1/users/${users[target2].id}/follow`, null, authHeaders);
    http.post(`${BASE_URL}/api/v1/users/${users[target3].id}/follow`, null, authHeaders);

    http.post(
      `${BASE_URL}/api/v1/posts`,
      JSON.stringify({ content: `Initial stress seed post from ${currentUser.username}` }),
      authHeaders
    );
  }

  return { users: users };
}

export default function (data) {
  if (!data.users || data.users.length === 0) return;

  const user = data.users[Math.floor(Math.random() * data.users.length)];
  const otherUser = data.users[Math.floor(Math.random() * data.users.length)];

  const authHeaders = {
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
    },
  };

  const actionRoll = Math.random();

  // Vector 1: CPU & Thread Starvation (20% of requests)
  // Continuous bcrypt password hashing verification
  if (actionRoll < 0.20) {
    const loginRes = http.post(
      `${BASE_URL}/api/v1/auth/login`,
      `username=${encodeURIComponent(user.username)}&password=${encodeURIComponent(user.password)}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    check(loginRes, {
      'stress: login success': (r) => r.status === 200,
    });
  }
  // Vector 2: Cache Invalidation Cascades & Heavy Feed Reads (45% of requests)
  // Frequent posts triggering fanout invalidation + paginated feed reads
  else if (actionRoll < 0.65) {
    if (Math.random() < 0.35) {
      // Create post (triggers Redis feed invalidation + Celery fanout)
      const postRes = http.post(
        `${BASE_URL}/api/v1/posts`,
        JSON.stringify({
          content: `Stress post from VU ${__VU} iter ${__ITER} at ${Date.now()}`,
        }),
        authHeaders
      );
      check(postRes, {
        'stress: create post': (r) => r.status === 201,
      });
    } else {
      // Query feed (competes for DB connections when cache misses occur)
      const page = Math.floor(Math.random() * 3) + 1;
      const feedRes = http.get(`${BASE_URL}/api/v1/feed?page=${page}&page_size=20`, authHeaders);
      check(feedRes, {
        'stress: read feed': (r) => r.status === 200,
      });
    }
  }
  // Vector 3: Queue Backlog, Celery Flooding & Rate Limits (15% of requests)
  // Interests mutations + Match refresh lock contention
  else if (actionRoll < 0.80) {
    if (Math.random() < 0.5) {
      // Flood Celery queue with similarity calculations
      const sampleInterests = [
        ['stress', 'scaling', 'performance', 'queues'],
        ['redis', 'postgres', 'fastapi', 'celery'],
        ['concurrency', 'saturation', 'latency', 'resilience'],
      ];
      const interests = sampleInterests[Math.floor(Math.random() * sampleInterests.length)];
      const patchRes = http.patch(
        `${BASE_URL}/api/v1/users/me`,
        JSON.stringify({ interests: interests }),
        authHeaders
      );
      check(patchRes, {
        'stress: patch interests': (r) => r.status === 200,
      });
    } else {
      // Exercise Redis distributed lock contention (expect 202 or 429)
      const refreshRes = http.post(`${BASE_URL}/api/v1/matches/refresh`, null, authHeaders);
      check(refreshRes, {
        'stress: match refresh': (r) => r.status === 202 || r.status === 429,
      });
    }
  }
  // Vector 4: Relational Churn & Profile Lookups (20% of requests)
  // Concurrent follow/unfollow row lock contention and profile cache churn
  else {
    if (user.id !== otherUser.id && Math.random() < 0.5) {
      const isFollow = Math.random() < 0.5;
      if (isFollow) {
        const followRes = http.post(`${BASE_URL}/api/v1/users/${otherUser.id}/follow`, null, authHeaders);
        check(followRes, {
          'stress: follow': (r) => r.status === 204 || r.status === 400,
        });
      } else {
        const unfollowRes = http.del(`${BASE_URL}/api/v1/users/${otherUser.id}/follow`, null, authHeaders);
        check(unfollowRes, {
          'stress: unfollow': (r) => r.status === 204,
        });
      }
    } else {
      const profileRes = http.get(`${BASE_URL}/api/v1/users/${otherUser.id}`, authHeaders);
      check(profileRes, {
        'stress: get profile': (r) => r.status === 200,
      });
    }
  }

  // Tight pacing to maintain aggressive concurrency pressure
  sleep(Math.random() * 0.15 + 0.05);
}
