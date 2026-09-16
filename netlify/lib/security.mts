import { getDeployStore, getStore } from "@netlify/blobs";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

declare const Netlify: {
  env: { get(name: string): string | undefined };
  context?: { deploy?: { context?: string } };
};

export type SessionUser = {
  name: string;
  email: string;
  emailHash: string;
  sessionId: string;
  exp: number;
};

const STORE_NAME = "wellstar-ai-security";

function isProduction() {
  return Netlify.context?.deploy?.context === "production";
}

export function securityStore() {
  if (isProduction()) return getStore(STORE_NAME, { consistency: "strong" });
  return getDeployStore(STORE_NAME);
}

function requiredSecret() {
  const value = Netlify.env.get("AI_ACCESS_SIGNING_SECRET");
  if (!value) throw new Error("AI_ACCESS_SIGNING_SECRET is not configured for this site.");
  return value;
}

function intEnv(name: string, fallback: number) {
  const raw = Netlify.env.get(name);
  const parsed = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function limitsConfig() {
  return {
    minute: intEnv("AI_RATE_MINUTE", 5),
    hour: intEnv("AI_RATE_HOUR", 20),
    day: intEnv("AI_RATE_DAY", 50),
    ipDay: intEnv("AI_RATE_IP_DAY", 100),
    globalDay: intEnv("AI_GLOBAL_DAILY_LIMIT", 300),
    promptMax: intEnv("AI_PROMPT_MAX_CHARS", 800),
    sessionDays: intEnv("AI_SESSION_DAYS", 7),
    repeatCooldownSeconds: intEnv("AI_REPEAT_COOLDOWN_SECONDS", 10)
  };
}

export function aiIsDisabled() {
  return String(Netlify.env.get("AI_KILL_SWITCH") || "").toLowerCase() === "true";
}

export function normalizeEmail(value: string) {
  return String(value || "").trim().toLowerCase();
}

export function validEmail(value: string) {
  const email = normalizeEmail(value);
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validName(value: string) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  return name.length >= 2 && name.length <= 80;
}

export function cleanName(value: string) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function hmac(value: string) {
  return createHmac("sha256", requiredSecret()).update(value).digest("base64url");
}

export function hashIdentifier(kind: string, value: string) {
  return hmac(`${kind}:${String(value || "").trim().toLowerCase()}`);
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createSessionToken(name: string, email: string) {
  const cfg = limitsConfig();
  const normalizedEmail = normalizeEmail(email);
  const payload = {
    v: 1,
    n: cleanName(name),
    e: normalizedEmail,
    s: randomUUID(),
    exp: Date.now() + cfg.sessionDays * 24 * 60 * 60 * 1000
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${hmac(encoded)}`;
}

export function verifySessionToken(token: string): SessionUser | null {
  try {
    const [encoded, signature] = String(token || "").split(".");
    if (!encoded || !signature || !safeEqual(signature, hmac(encoded))) return null;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (payload?.v !== 1 || !payload?.n || !validEmail(payload?.e) || !payload?.s) return null;
    if (!Number.isFinite(payload?.exp) || payload.exp <= Date.now()) return null;
    return {
      name: cleanName(payload.n),
      email: normalizeEmail(payload.e),
      emailHash: hashIdentifier("email", payload.e),
      sessionId: String(payload.s),
      exp: payload.exp
    };
  } catch {
    return null;
  }
}

export function sessionFromRequest(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? verifySessionToken(match[1]) : null;
}

function clientIp(req: Request) {
  const direct = req.headers.get("x-nf-client-connection-ip") || req.headers.get("cf-connecting-ip");
  if (direct) return direct.trim();
  const forwarded = req.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

export function hashedClientIp(req: Request) {
  return hashIdentifier("ip", clientIp(req));
}

function minuteBucket(now: Date) {
  return now.toISOString().slice(0, 16).replace(/[:T-]/g, "");
}

function hourBucket(now: Date) {
  return now.toISOString().slice(0, 13).replace(/[:T-]/g, "");
}

function dayBucket(now: Date) {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

async function incrementCounter(key: string, limit: number) {
  const store = securityStore();
  const existing = await store.get(key, { type: "json" }) as any;
  const count = Number(existing?.count || 0) + 1;
  await store.setJSON(key, { count, updatedAt: new Date().toISOString() });
  return { allowed: count <= limit, count, limit };
}

export async function enforceAccessRate(req: Request) {
  const now = new Date();
  const ipHash = hashedClientIp(req);
  const bucket = hourBucket(now);
  const result = await incrementCounter(`limits/access-ip-hour/${ipHash}/${bucket}.json`, 20);
  if (!result.allowed) {
    return { allowed: false, status: 429, error: "Too many access attempts from this network. Please try again later." };
  }
  return { allowed: true, ipHash };
}

export async function enforceQueryRate(user: SessionUser, req: Request, message: string) {
  const cfg = limitsConfig();
  const now = new Date();
  const ipHash = hashedClientIp(req);
  const m = minuteBucket(now);
  const h = hourBucket(now);
  const d = dayBucket(now);
  const queryHash = hashIdentifier("query", message);
  const store = securityStore();
  const repeatKey = `repeat/${user.emailHash}/${queryHash}.json`;
  const previous = await store.get(repeatKey, { type: "json" }) as any;
  const previousAt = Number(previous?.at || 0);
  if (previousAt && Date.now() - previousAt < cfg.repeatCooldownSeconds * 1000) {
    return {
      allowed: false,
      status: 429,
      error: `Please wait ${cfg.repeatCooldownSeconds} seconds before repeating the same request.`
    };
  }
  await store.setJSON(repeatKey, { at: Date.now() });

  const checks = [
    ["minute", `limits/user-minute/${user.emailHash}/${m}.json`, cfg.minute],
    ["hour", `limits/user-hour/${user.emailHash}/${h}.json`, cfg.hour],
    ["day", `limits/user-day/${user.emailHash}/${d}.json`, cfg.day],
    ["network-day", `limits/ip-day/${ipHash}/${d}.json`, cfg.ipDay],
    ["global-day", `limits/global-day/${d}.json`, cfg.globalDay]
  ] as const;

  const results: Record<string, { count: number; limit: number }> = {};
  for (const [label, key, limit] of checks) {
    const result = await incrementCounter(key, limit);
    results[label] = { count: result.count, limit: result.limit };
    if (!result.allowed) {
      const messageByLabel: Record<string, string> = {
        minute: "You have reached the per-minute AI request limit.",
        hour: "You have reached the hourly AI request limit.",
        day: "You have reached today's AI request limit.",
        "network-day": "This network has reached today's AI request limit.",
        "global-day": "The public AI demo has reached today's usage limit. Please try again tomorrow."
      };
      return { allowed: false, status: 429, error: messageByLabel[label], results, ipHash };
    }
  }

  return { allowed: true, results, ipHash };
}

export function obviousAbuse(message: string) {
  const text = String(message || "");
  const patterns = [
    /ignore\s+(all|any|the)?\s*(previous|prior|above)\s+(instructions?|prompts?)/i,
    /(reveal|show|print|repeat)\s+(your|the)\s+(system|developer)\s+(prompt|message|instructions?)/i,
    /prompt\s*injection/i,
    /jailbreak/i,
    /act\s+as\s+(an?|the)\s+(unrestricted|uncensored)/i,
    /exfiltrat(e|ion)/i
  ];
  return patterns.some((pattern) => pattern.test(text));
}

export async function registerUser(name: string, email: string, req: Request) {
  const clean = cleanName(name);
  const normalizedEmail = normalizeEmail(email);
  const emailHash = hashIdentifier("email", normalizedEmail);
  const ipHash = hashedClientIp(req);
  const store = securityStore();
  const key = `users/${emailHash}.json`;
  const now = new Date().toISOString();
  const existing = await store.get(key, { type: "json" }) as any;
  const token = createSessionToken(clean, normalizedEmail);
  const session = verifySessionToken(token)!;

  await store.setJSON(key, {
    name: clean,
    email: normalizedEmail,
    emailHash,
    firstSeen: existing?.firstSeen || now,
    lastSeen: now,
    lastIpHash: ipHash,
    sessions: Number(existing?.sessions || 0) + 1
  });

  await logEvent({
    type: "access_granted",
    user: session,
    ipHash,
    status: "ok"
  });

  return { token, session };
}

export async function touchUser(user: SessionUser, req: Request) {
  const store = securityStore();
  const key = `users/${user.emailHash}.json`;
  const existing = await store.get(key, { type: "json" }) as any;
  if (!existing) return;
  await store.setJSON(key, {
    ...existing,
    name: user.name,
    email: user.email,
    lastSeen: new Date().toISOString(),
    lastIpHash: hashedClientIp(req)
  });
}

export async function logEvent(input: {
  type: string;
  user?: SessionUser | null;
  ipHash?: string;
  status?: string;
  message?: string;
  detail?: any;
}) {
  const store = securityStore();
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const key = `events/${day}/${now.getTime()}-${randomUUID()}.json`;
  await store.setJSON(key, {
    timestamp: now.toISOString(),
    type: input.type,
    status: input.status || "",
    name: input.user?.name || "",
    email: input.user?.email || "",
    emailHash: input.user?.emailHash || "",
    sessionId: input.user?.sessionId || "",
    ipHash: input.ipHash || "",
    message: String(input.message || "").slice(0, limitsConfig().promptMax),
    detail: input.detail || null
  });
}

export function adminAuthorized(req: Request) {
  const configured = Netlify.env.get("AI_ADMIN_KEY") || "";
  if (!configured) return false;
  const auth = req.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return Boolean(match?.[1] && safeEqual(match[1], configured));
}
