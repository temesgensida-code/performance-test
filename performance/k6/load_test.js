import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.TARGET_URL || 'http://api:8000';

export const options = {
  scenarios: {
    // 80% Read-heavy traffic (Browsing feed, viewing profiles, looking up matches)
    readers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 32 },  // Ramp up to 32 VUs
        { duration: '3m', target: 32 },  // Sustained load
        { duration: '30s', target: 0 },  // Ramp down
      ],
      gracefulRampDown: '15s',
      exec: 'runReaders',
    },
    // 15% Write-heavy traffic (Creating posts, following/unfollowing)
    writers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 6 },   // Ramp up to 6 VUs
        { duration: '3m', target: 6 },   // Sustained load
        { duration: '30s', target: 0 },  // Ramp down
      ],
      gracefulRampDown: '15s',
      exec: 'runWriters',
    },
    // 5% Compute & Auth traffic (Login/bcrypt verification, interest updates triggering Celery, match refresh)
    compute_and_auth: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 2 },   // Ramp up to 2 VUs
        { duration: '3m', target: 2 },   // Sustained load
        { duration: '30s', target: 0 },  // Ramp down
      ],
      gracefulRampDown: '15s',
      exec: 'runComputeAndAuth',
    },
  },
  thresholds: {
    // Standard SLA: 95% < 500ms, 99% < 1000ms, error rate < 1%
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    // Fast read SLA
    'http_req_duration{scenario:readers}': ['p(95)<300'],
  },
};

export function setup() {
  const numUsers = 15;
  const users = [];
  const baseTimestamp = Date.now().toString().slice(-6);

  // 1. Provision user pool
  for (let i = 0; i < numUsers; i++) {
    const username = `ldu_${baseTimestamp}_${i}`.slice(0, 28);
    const email = `${username}@example.com`;
    const password = 'LoadPassword123!';
    const displayName = `Load User ${i}`;

    const regRes = http.post(
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
      // Fetch me to get the auto-increment user id
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

  // 2. Establish mutual follow graph (each user follows the next 2-3 users)
  for (let i = 0; i < users.length; i++) {
    const currentUser = users[i];
    const authHeaders = {
      headers: {
        Authorization: `Bearer ${currentUser.token}`,
        'Content-Type': 'application/json',
      },
    };

    const targetIndex1 = (i + 1) % users.length;
    const targetIndex2 = (i + 2) % users.length;

    http.post(`${BASE_URL}/api/v1/users/${users[targetIndex1].id}/follow`, null, authHeaders);
    http.post(`${BASE_URL}/api/v1/users/${users[targetIndex2].id}/follow`, null, authHeaders);

    // 3. Post initial seed content so feeds are populated
    http.post(
      `${BASE_URL}/api/v1/posts`,
      JSON.stringify({ content: `Initial seed post by ${currentUser.username} (part 1)` }),
      authHeaders
    );
    http.post(
      `${BASE_URL}/api/v1/posts`,
      JSON.stringify({ content: `Initial seed post by ${currentUser.username} (part 2)` }),
      authHeaders
    );
  }

  return { users: users };
}

// 80% Read Scenario: Feed consumption, user profile lookups, cached matches
export function runReaders(data) {
  if (!data.users || data.users.length === 0) return;
  const user = data.users[Math.floor(Math.random() * data.users.length)];
  const otherUser = data.users[Math.floor(Math.random() * data.users.length)];

  const authHeaders = {
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
    },
  };

  // 1. Read timeline feed (heavy read)
  const feedRes = http.get(`${BASE_URL}/api/v1/feed?page=1&page_size=20`, authHeaders);
  check(feedRes, {
    'reader: get feed 200': (r) => r.status === 200,
  });

  // 2. Browse another user's profile (cache hit / miss)
  const profileRes = http.get(`${BASE_URL}/api/v1/users/${otherUser.id}`, authHeaders);
  check(profileRes, {
    'reader: get user profile 200': (r) => r.status === 200,
  });

  // 3. Check own profile
  const meRes = http.get(`${BASE_URL}/api/v1/users/me`, authHeaders);
  check(meRes, {
    'reader: get /me 200': (r) => r.status === 200,
  });

  // 4. View matches
  const matchesRes = http.get(`${BASE_URL}/api/v1/matches`, authHeaders);
  check(matchesRes, {
    'reader: get matches 200': (r) => r.status === 200,
  });

  sleep(Math.random() * 0.6 + 0.3);
}

// 15% Write Scenario: Post creation and follow/unfollow relations
export function runWriters(data) {
  if (!data.users || data.users.length === 0) return;
  const user = data.users[Math.floor(Math.random() * data.users.length)];
  const otherUser = data.users[Math.floor(Math.random() * data.users.length)];

  const authHeaders = {
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
    },
  };

  // 1. Create a post (triggers follower feed invalidations)
  const postRes = http.post(
    `${BASE_URL}/api/v1/posts`,
    JSON.stringify({
      content: `Load test post from VU ${__VU} at ${new Date().toISOString()}`,
    }),
    authHeaders
  );
  check(postRes, {
    'writer: create post 201': (r) => r.status === 201,
  });

  // 2. Relationship modification (Follow or Unfollow)
  if (user.id !== otherUser.id) {
    const isFollow = Math.random() > 0.5;
    if (isFollow) {
      const followRes = http.post(`${BASE_URL}/api/v1/users/${otherUser.id}/follow`, null, authHeaders);
      check(followRes, {
        'writer: follow 204': (r) => r.status === 204,
      });
    } else {
      const unfollowRes = http.del(`${BASE_URL}/api/v1/users/${otherUser.id}/follow`, null, authHeaders);
      check(unfollowRes, {
        'writer: unfollow 204': (r) => r.status === 204,
      });
    }
  }

  sleep(Math.random() * 1.0 + 0.5);
}

// 5% Compute & Auth Scenario: Password hashing (login), async Celery trigger (interests), match refresh
export function runComputeAndAuth(data) {
  if (!data.users || data.users.length === 0) return;
  const user = data.users[Math.floor(Math.random() * data.users.length)];

  const authHeaders = {
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
    },
  };

  // 1. CPU-intensive authentication verification (bcrypt)
  const loginRes = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    `username=${encodeURIComponent(user.username)}&password=${encodeURIComponent(user.password)}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  check(loginRes, {
    'compute: login 200': (r) => r.status === 200,
  });

  // 2. Modify interests (triggers Celery matching calculation)
  const sampleInterests = [
    ['coding', 'python', 'fastapi'],
    ['databases', 'postgres', 'redis'],
    ['architecture', 'distributed-systems', 'perf'],
  ];
  const newInterests = sampleInterests[Math.floor(Math.random() * sampleInterests.length)];

  const patchRes = http.patch(
    `${BASE_URL}/api/v1/users/me`,
    JSON.stringify({ interests: newInterests }),
    authHeaders
  );
  check(patchRes, {
    'compute: update interests 200': (r) => r.status === 200,
  });

  // 3. Request match refresh (rate-limited to 1/min per user by Redis lock)
  const refreshRes = http.post(`${BASE_URL}/api/v1/matches/refresh`, null, authHeaders);
  check(refreshRes, {
    'compute: match refresh accepted or rate-limited': (r) => r.status === 202 || r.status === 429,
  });

  sleep(Math.random() * 2.0 + 1.0);
}
