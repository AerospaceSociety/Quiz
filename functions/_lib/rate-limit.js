import { HttpError } from './firebase-admin.js';

const ipBuckets = new Map();
const userBuckets = new Map();
const actionLimits = {
  claim: { minute: 5, day: 20 },
  session: { minute: 5, day: 300 },
  event: { minute: 8, day: 80 },
  baseline: { minute: 2, day: 4 },
  paper: { minute: 2, day: 10 },
  seal: { minute: 3, day: 200 },
  time: { minute: 10, day: 100 },
  submit: { minute: 5, day: 100 }
};
let lastCleanup = 0;

function cleanup(now) {
  if (now - lastCleanup <= 5 * 60 * 1000) return;
  for (const buckets of [ipBuckets, userBuckets]) {
    for (const [key, bucket] of buckets) if (now - bucket.lastSeen > 24 * 60 * 60 * 1000) buckets.delete(key);
  }
  lastCleanup = now;
}

function consume(buckets, key, minuteLimit, dayLimit, label) {
  const now = Date.now();
  cleanup(now);
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= 10000) {
      let oldestKey = null;
      let oldestSeen = Infinity;
      for (const [candidateKey, candidate] of buckets) {
        if (candidate.lastSeen < oldestSeen) { oldestKey = candidateKey; oldestSeen = candidate.lastSeen; }
      }
      if (oldestKey !== null) buckets.delete(oldestKey);
    }
    bucket = { minuteAt: Math.floor(now / 60000), minuteCount: 0, dayAt: Math.floor(now / 86400000), dayCount: 0, actions: {}, lastSeen: now };
    buckets.set(key, bucket);
  }
  const minuteAt = Math.floor(now / 60000);
  const dayAt = Math.floor(now / 86400000);
  if (bucket.minuteAt !== minuteAt) { bucket.minuteAt = minuteAt; bucket.minuteCount = 0; }
  if (bucket.dayAt !== dayAt) { bucket.dayAt = dayAt; bucket.dayCount = 0; bucket.actions = {}; }
  bucket.lastSeen = now;
  if (bucket.minuteCount >= minuteLimit || bucket.dayCount >= dayLimit) throw new HttpError(429, `${label} rate limit reached; retry later`);
  bucket.minuteCount++;
  bucket.dayCount++;
  return { bucket, minuteAt, dayAt };
}

export function enforceIpRateLimit(ip) {
  if (typeof ip !== 'string' || !ip || ip.length > 64) return;
  consume(ipBuckets, ip, 300, 6000, 'Network');
}

export function enforceUserRateLimit(uid) {
  consume(userBuckets, uid, 12, 500, 'Candidate');
}

export function enforceActionRateLimit(uid, action) {
  const limits = actionLimits[action];
  if (!limits) throw new HttpError(400, 'Unknown candidate action');
  const now = Date.now();
  const bucket = userBuckets.get(uid);
  if (!bucket) throw new HttpError(500, 'Candidate rate limit state is unavailable');
  const minuteAt = Math.floor(now / 60000);
  const usage = bucket.actions[action] || { minuteAt, minuteCount: 0, dayCount: 0 };
  if (usage.minuteAt !== minuteAt) { usage.minuteAt = minuteAt; usage.minuteCount = 0; }
  if (usage.minuteCount >= limits.minute || usage.dayCount >= limits.day) throw new HttpError(429, 'Candidate action rate limit reached; retry later');
  usage.minuteCount++;
  usage.dayCount++;
  bucket.actions[action] = usage;
}
