import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ALLOWED_ORIGIN = "https://alooshalshawwa8-wq.github.io";
const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};
const headers = { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const cache = new Map<string, { until: number; data: unknown }>();
const requests = new Map<string, number[]>();
const providerFetchInFlight = new Map<string, Promise<Record<string, any>>>();
let providerStatusCheckAt = 0;

function reply(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}
function rateAllowed(ip: string) {
  const now = Date.now();
  const recent = (requests.get(ip) ?? []).filter(t => now - t < 60_000);
  if (recent.length >= 30) return false;
  recent.push(now);
  requests.set(ip, recent);
  return true;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
type FetchTracker = { upstreamCalls: number; cacheHits: number; staleHits: number; budgetBlocked: number };
async function dbRest(path: string, init: RequestInit = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Persistent storage credentials unavailable");
  return await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    ...init,
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}
let providerPolicyMemo: { until: number; data: Record<string, any> } | null = null;
async function getProviderPolicy(): Promise<Record<string, any> | null> {
  if (providerPolicyMemo && providerPolicyMemo.until > Date.now()) return providerPolicyMemo.data;
  const response = await dbRest("football_api_budget_policy?select=provider_blocked,provider_block_reason,live_cache_seconds,non_live_refresh_minutes,finished_match_cache_hours&singleton=eq.true&limit=1");
  if (!response.ok) return null;
  const rows = await response.json();
  const policy = Array.isArray(rows) ? rows[0] : null;
  if (policy) providerPolicyMemo = { until: Date.now() + 15_000, data: policy };
  return policy;
}
function fixtureCacheTtls(policy: Record<string, any>) {
  return {
    live: Math.max(60, Number(policy.live_cache_seconds) || 60) * 1000,
    nonLive: Math.max(1, Number(policy.non_live_refresh_minutes) || 10) * 60_000,
    finished: Math.max(1, Number(policy.finished_match_cache_hours) || 24) * 60 * 60_000
  };
}

async function persistentCacheGet(key: string, allowStale = false): Promise<unknown | null> {
  try {
    const response = await dbRest("football_api_cache?cache_key=eq." + encodeURIComponent(key) + "&select=payload,expires_at&limit=1");
    if (!response.ok) return null;
    const rows = await response.json();
    if (!Array.isArray(rows) || !rows[0]) return null;
    const expired = Date.parse(rows[0].expires_at) <= Date.now();
    if (expired && !allowStale) return null;
    if (expired && rows[0].payload && typeof rows[0].payload === "object") return { ...rows[0].payload, stale: true, staleAt: rows[0].expires_at };
    return rows[0].payload;
  } catch { return null; }
}
async function persistentCacheSet(key: string, endpoint: string, payload: unknown, ttl: number) {
  try {
    await dbRest("football_api_cache?on_conflict=cache_key", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        cache_key: key, endpoint, payload,
        expires_at: new Date(Date.now() + ttl).toISOString(),
        updated_at: new Date().toISOString()
      })
    });
  } catch (error) { console.error("Football persistent cache write failed", String(error).slice(0,160)); }
}
async function recordProviderUsage(row: {
  endpoint: string; cacheKey: string; status: number; errors?: unknown;
  responseCount?: number; remaining?: number | null; limit?: number | null; minuteRemaining?: number | null; minuteLimit?: number | null; providerPlan?: string | null; durationMs: number;
}) {
  try {
    await dbRest("football_api_usage", {
      method: "POST",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify({
        endpoint: row.endpoint, cache_key: row.cacheKey, http_status: row.status,
        provider_errors: row.errors ?? null, response_count: row.responseCount ?? null,
        requests_remaining: row.remaining ?? null, requests_limit: row.limit ?? null,
        minute_remaining: row.minuteRemaining ?? null, minute_limit: row.minuteLimit ?? null,
        provider_plan: row.providerPlan ?? null, duration_ms: row.durationMs
      })
    });
  } catch (error) { console.error("Football usage log failed", String(error).slice(0,160)); }
}
async function hashClientKey(value: string) {
  const bytes = new TextEncoder().encode(value || "unknown");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2,"0")).join("");
}
async function persistentRateAllowed(bucket: string, maxRequests = 60): Promise<boolean | null> {
  try {
    const response = await dbRest("rpc/football_rate_limit_hit", {
      method: "POST", body: JSON.stringify({ p_bucket_key: bucket, p_window_seconds: 60, p_max_requests: maxRequests })
    });
    if (!response.ok) return null;
    const count = Number(await response.json());
    return Number.isFinite(count) && count <= maxRequests;
  } catch { return null; }
}
function hasProviderErrors(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

const AUTH_API_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? SERVICE_KEY;
let launchConfigMemo: { until: number; data: Record<string, any> } | null = null;
async function getLaunchConfig() {
  if (launchConfigMemo && launchConfigMemo.until > Date.now()) return launchConfigMemo.data;
  const response = await dbRest("platform_launch_config?select=launch_mode,billing_enabled,paid_features_enforced,trial_free_all_features&limit=1");
  if (!response.ok) throw new Error("Feature policy unavailable");
  const rows = await response.json();
  if (!Array.isArray(rows) || !rows[0]) throw new Error("Feature policy missing");
  launchConfigMemo = { until: Date.now() + 15_000, data: rows[0] };
  return rows[0];
}
async function authenticatedFootballUser(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || !SUPABASE_URL || !AUTH_API_KEY) return null;
  try {
    const response = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { "apikey": AUTH_API_KEY, "Authorization": authorization, "Accept": "application/json" }
    });
    if (!response.ok) return null;
    const user = await response.json();
    if (!user?.id) return null;
    return { id: String(user.id), appMetadata: user.app_metadata ?? {} };
  } catch { return null; }
}
async function footballEntitlements(userId: string): Promise<Set<string>> {
  const response = await dbRest("entitlements?user_id=eq." + encodeURIComponent(userId) + "&active=eq.true&select=entitlement_key");
  if (!response.ok) throw new Error("Entitlements unavailable");
  const rows = await response.json();
  return new Set((Array.isArray(rows) ? rows : []).map((row: Record<string, any>) => String(row.entitlement_key)));
}
async function authorizeFootballFeature(request: Request, featureCode: string) {
  let launch: Record<string, any>;
  try { launch = await getLaunchConfig(); }
  catch { return { allowed: false, status: 503, code: "FEATURE_POLICY_UNAVAILABLE" }; }
  if (launch.launch_mode !== "paid" || launch.billing_enabled !== true || launch.paid_features_enforced !== true || launch.trial_free_all_features === true) {
    return { allowed: true, status: 200, code: "TRIAL_OR_ENFORCEMENT_OFF" };
  }
  const featureResponse = await dbRest("platform_plan_features?feature_code=eq." + encodeURIComponent(featureCode) + "&access_level=eq.included&select=plan_code");
  if (!featureResponse.ok) return { allowed: false, status: 503, code: "FEATURE_CATALOG_UNAVAILABLE" };
  const featureRows = await featureResponse.json();
  const planCodes = new Set((Array.isArray(featureRows) ? featureRows : []).map((row: Record<string, any>) => String(row.plan_code)));
  if (planCodes.has("free")) return { allowed: true, status: 200, code: "FREE_FEATURE" };
  const user = await authenticatedFootballUser(request);
  if (!user) return { allowed: false, status: 401, code: "AUTH_REQUIRED" };
  let entitlements: Set<string>;
  try { entitlements = await footballEntitlements(user.id); }
  catch { return { allowed: false, status: 503, code: "ENTITLEMENT_LOOKUP_FAILED" }; }
  const metadataOwner = user.appMetadata?.role === "OWNER" && user.appMetadata?.owner === true;
  if (metadataOwner || entitlements.has("owner_access") || entitlements.has("all_features")) {
    return { allowed: true, status: 200, code: "OWNER_OR_ALL_FEATURES" };
  }
  const planEntitlements: Record<string, string[]> = {
    pro_monthly: ["pro_access", "vip_access", "business_access"],
    vip_monthly: ["vip_access", "business_access"],
    business_monthly: ["business_access"]
  };
  const allowed = [...planCodes].some(planCode => (planEntitlements[planCode] ?? []).some(key => entitlements.has(key)));
  return { allowed, status: allowed ? 200 : 403, code: allowed ? "ENTITLED" : "PLAN_REQUIRED" };
}
function requiredFootballFeature(action: string, url: URL): string | null {
  if (action === "fixtures") return "fixtures_scores";
  if (action === "teams" || action === "team") return "basic_team_pages";
  if (action === "leagues" || action === "standings") return "league_tables";
  if (action === "leaders") return "scorers_assists_cards";
  if (action === "match") return "match_lineups_events";
  if (action === "studio") return "match_studio";
  if (action === "trophies") return "player_profiles_ratings";
  if (action !== "catalog") return null;
  const dataset = url.searchParams.get("dataset") ?? "";
  if (["standings","rounds"].includes(dataset)) return "league_tables";
  if (["scorers","assists","yellow_cards","red_cards"].includes(dataset)) return "scorers_assists_cards";
  if (["fixture_events","fixture_lineups"].includes(dataset)) return "match_lineups_events";
  if (["fixture_stats","team_stats","odds","odds_live","odds_bets","bookmakers","odds_mapping"].includes(dataset)) return "advanced_match_stats";
  if (["fixture_players","players","player_seasons","squads","coaches","transfers","sidelined","trophies"].includes(dataset)) return "player_profiles_ratings";
  if (["injuries","predictions"].includes(dataset)) return "injuries_predictions";
  if (dataset === "headtohead") return "head_to_head_history";
  if (["team_list","team_countries","team_seasons","venues"].includes(dataset)) return "basic_team_pages";
  if (dataset === "fixture_list") return "fixtures_scores";
  return null;
}
async function reserveFootballBudget(bucket: string, endpoint: string) {
  const response = await dbRest("rpc/football_api_budget_reserve", {
    method: "POST", body: JSON.stringify({ p_bucket: bucket, p_endpoint: endpoint })
  });
  if (!response.ok) throw new Error("FOOTBALL_BUDGET_GUARD_UNAVAILABLE");
  return await response.json();
}
async function providerFetchFresh(path: string, query: Record<string,string>, ttl: number, tracker: FetchTracker, budgetBucket = "core") {
  const params = new URLSearchParams(query);
  const cacheKey = path + "?" + params.toString();
  const local = cache.get("provider:" + cacheKey);
  if (local && local.until > Date.now()) { tracker.cacheHits++; return local.data as Record<string, any>; }
  const persisted = await persistentCacheGet(cacheKey);
  if (persisted && typeof persisted === "object") {
    tracker.cacheHits++;
    cache.set("provider:" + cacheKey, { until: Date.now() + Math.min(ttl, 60_000), data: persisted });
    return persisted as Record<string, any>;
  }
  const providerState = await getProviderPolicy();
  if (!providerState) {
    const error = new Error("FOOTBALL_PROVIDER_STATE_UNAVAILABLE");
    (error as any).status = 503;
    throw error;
  }
  const cacheTtls = fixtureCacheTtls(providerState);
  let effectiveTtl = ttl;
  if (path === "fixtures") {
    if (query.live) effectiveTtl = cacheTtls.live;
    else if (query.id || query.date || query.league || query.team) effectiveTtl = cacheTtls.nonLive;
  }
  if (providerState.provider_blocked === true) {
    const stale = await persistentCacheGet(cacheKey, true);
    if (stale && typeof stale === "object") {
      tracker.cacheHits++; tracker.staleHits++; tracker.budgetBlocked++;
      return { ...stale as Record<string, any>, cached: true, stale: true, providerBlocked: true };
    }
    const error = new Error("FOOTBALL_PROVIDER_SUSPENDED");
    (error as any).status = 503;
    throw error;
  }
  // One global provider bucket protects the shared Edge Function egress IP.
  // Keep one request/minute of headroom below the Free plan's 10/minute cap.
  const providerRateAllowed = await persistentRateAllowed("api-football-global", 6);
  if (providerRateAllowed === null) {
    const error = new Error("FOOTBALL_PROVIDER_RATE_GUARD_UNAVAILABLE");
    (error as any).status = 503;
    throw error;
  }
  if (!providerRateAllowed) {
    const error = new Error("FOOTBALL_PROVIDER_MINUTE_LIMIT");
    (error as any).status = 429;
    throw error;
  }
  let budget: Record<string, any>;
  try { budget = await reserveFootballBudget(budgetBucket, path); }
  catch {
    const stale = await persistentCacheGet(cacheKey, true);
    if (stale && typeof stale === "object") {
      tracker.cacheHits++; tracker.staleHits++; tracker.budgetBlocked++;
      return { ...stale as Record<string, any>, cached: true, stale: true, budgetLimited: true };
    }
    const error = new Error("FOOTBALL_BUDGET_GUARD_UNAVAILABLE");
    (error as any).status = 503;
    throw error;
  }
  if (!budget?.allowed) {
    tracker.budgetBlocked++;
    const stale = await persistentCacheGet(cacheKey, true);
    if (stale && typeof stale === "object") {
      tracker.cacheHits++; tracker.staleHits++;
      return { ...stale as Record<string, any>, cached: true, stale: true, budgetLimited: true, budgetReason: budget.reason };
    }
    const error = new Error("FOOTBALL_DAILY_BUDGET_LIMIT");
    (error as any).status = 429;
    (error as any).budget = budget;
    throw error;
  }
  const started = Date.now();
  tracker.upstreamCalls++;
  let upstream: Response;
  let data: Record<string, any>;
  try {
    upstream = await fetch("https://v3.football.api-sports.io/" + path + (params.size ? "?" + params.toString() : ""), {
      headers: { "x-apisports-key": Deno.env.get("API_FOOTBALL_KEY") ?? "", "Accept": "application/json" }
    });
    data = await upstream.json().catch(() => ({}));
  } catch (error) {
    await recordProviderUsage({ endpoint: path, cacheKey, status: 0, errors: String(error).slice(0,300), durationMs: Date.now()-started });
    const stale = await persistentCacheGet(cacheKey, true);
    if (stale && typeof stale === "object") {
      tracker.cacheHits++; tracker.staleHits++;
      return { ...stale as Record<string, any>, cached: true, stale: true };
    }
    throw error;
  }
  const remainingHeader = upstream.headers.get("x-ratelimit-requests-remaining");
  const limitHeader = upstream.headers.get("x-ratelimit-requests-limit");
  const minuteRemainingHeader = upstream.headers.get("x-ratelimit-remaining");
  const minuteLimitHeader = upstream.headers.get("x-ratelimit-limit");
  const remaining = remainingHeader === null ? null : Number(remainingHeader);
  const limit = limitHeader === null ? null : Number(limitHeader);
  const minuteRemaining = minuteRemainingHeader === null ? null : Number(minuteRemainingHeader);
  const minuteLimit = minuteLimitHeader === null ? null : Number(minuteLimitHeader);
  await recordProviderUsage({
    endpoint: path, cacheKey, status: upstream.status,
    errors: hasProviderErrors(data.errors) ? data.errors : null,
    responseCount: Array.isArray(data.response) ? data.response.length : 0,
    remaining: Number.isFinite(remaining) ? remaining : null,
    limit: Number.isFinite(limit) ? limit : null,
    minuteRemaining: Number.isFinite(minuteRemaining) ? minuteRemaining : null,
    minuteLimit: Number.isFinite(minuteLimit) ? minuteLimit : null,
    durationMs: Date.now()-started
  });
  const providerErrorText = JSON.stringify(data.errors ?? {}).toLowerCase();
  if (providerErrorText.includes("suspended") && providerErrorText.includes("account")) {
    await dbRest("football_api_budget_policy?singleton=eq.true", {
      method: "PATCH",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify({
        provider_blocked: true,
        provider_blocked_at: new Date().toISOString(),
        provider_block_reason: providerErrorText.slice(0, 500)
      })
    });
    providerPolicyMemo = null;
  }
  if (!upstream.ok || hasProviderErrors(data.errors)) {
    const stale = await persistentCacheGet(cacheKey, true);
    if (stale && typeof stale === "object") {
      tracker.cacheHits++; tracker.staleHits++;
      return { ...stale as Record<string, any>, cached: true, stale: true };
    }
    const err = new Error(path + " returned " + upstream.status);
    (err as any).status = upstream.status;
    throw err;
  }
  if (path === "fixtures" && query.id) {
    const fixtureStatus = String(data.response?.[0]?.fixture?.status?.short ?? "");
    if (["1H","HT","2H","ET","BT","P","LIVE"].includes(fixtureStatus)) effectiveTtl = cacheTtls.live;
    else if (["FT","AET","PEN"].includes(fixtureStatus)) effectiveTtl = cacheTtls.finished;
    else effectiveTtl = cacheTtls.nonLive;
  }
  const result = {
    response: Array.isArray(data.response) ? data.response : [],
    results: Number(data.results ?? 0), paging: data.paging ?? null,
    provider: "API-Football", fetchedAt: new Date().toISOString(), cached: false
  };
  cache.set("provider:" + cacheKey, { until: Date.now() + Math.min(effectiveTtl, 60_000), data: result });
  await persistentCacheSet(cacheKey, path, result, effectiveTtl);
  return result;
}


async function providerFetch(path: string, query: Record<string,string>, ttl: number, tracker: FetchTracker, budgetBucket = "core") {
  const params = new URLSearchParams(query);
  const key = path + "?" + params.toString();
  const existing = providerFetchInFlight.get(key);
  if (existing) {
    tracker.cacheHits++;
    return await existing;
  }
  const pending = providerFetchFresh(path, query, ttl, tracker, budgetBucket);
  providerFetchInFlight.set(key, pending);
  try { return await pending; }
  finally { if (providerFetchInFlight.get(key) === pending) providerFetchInFlight.delete(key); }
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z"));
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin") ?? "";
  if (request.method === "OPTIONS") {
    if (origin !== ALLOWED_ORIGIN) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: cors });
  }
  if (origin !== ALLOWED_ORIGIN) return reply({ error: "Origin not allowed" }, 403);
  if (request.method !== "GET") return reply({ error: "Method not allowed" }, 405);

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!rateAllowed(ip)) return reply({ error: "تم تجاوز عدد الطلبات المؤقت. حاول بعد دقيقة." }, 429);
  const persistentRate = await persistentRateAllowed(await hashClientKey(ip), 60);
  if (persistentRate === null) return reply({ error: "تعذر التحقق من حد الطلبات حالياً؛ أوقفنا الاتصال بالمزود لحماية الحصة." }, 503);
  if (!persistentRate) return reply({ error: "تم تجاوز عدد الطلبات المؤقت. حاول بعد دقيقة." }, 429);
  const tracker: FetchTracker = { upstreamCalls: 0, cacheHits: 0, staleHits: 0, budgetBlocked: 0 };

  const apiKey = Deno.env.get("API_FOOTBALL_KEY") ?? "";
  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "status";
  if (action === "status") {
    return reply({ provider: "API-Football", configured: Boolean(apiKey), message: apiKey ? "مفتاح API مضبوط؛ تُعرض حالة الحساب من لوحة الاستهلاك." : "أضف API_FOOTBALL_KEY إلى أسرار Supabase لتفعيل البيانات." });
  }
  if (action === "usage") {
    try {
      const user = await authenticatedFootballUser(request);
      if (!user) return reply({ error: "يلزم تسجيل الدخول بصلاحية مالك المنصة." }, 401);
      const keys = await footballEntitlements(user.id);
      const metadataOwner = user.appMetadata?.role === "OWNER" && user.appMetadata?.owner === true;
      if (!metadataOwner && !keys.has("owner_access")) return reply({ error: "هذه اللوحة مخصصة لمالك المنصة." }, 403);
      let [usageResponse, budgetResponse] = await Promise.all([
        dbRest("rpc/football_api_usage_summary", { method: "POST", body: "{}" }),
        dbRest("rpc/football_api_budget_status", { method: "POST", body: "{}" })
      ]);
      if (!usageResponse.ok || !budgetResponse.ok) throw new Error("Usage or budget summary unavailable");
      let budgetSnapshot = await budgetResponse.json();
      const providerStateRead = await dbRest("football_api_budget_policy?select=provider_blocked,provider_blocked_at,provider_block_reason&singleton=eq.true&limit=1");
      if (!providerStateRead.ok) throw new Error("Provider state unavailable");
      let providerStateRows = await providerStateRead.json();
      let providerState = Array.isArray(providerStateRows) ? providerStateRows[0] : null;
      const providerHeaderAt = budgetSnapshot?.providerHeaderAt ? Date.parse(budgetSnapshot.providerHeaderAt) : 0;
      if (apiKey && providerState?.provider_blocked !== true && Date.now() - providerHeaderAt > 30 * 60_000 && Date.now() - providerStatusCheckAt > 30 * 60_000) {
        providerStatusCheckAt = Date.now();
        const statusStarted = Date.now();
        try {
          // Status refreshes are provider requests too: reserve the global minute slot and emergency budget first.
          const statusRateAllowed = await persistentRateAllowed("api-football-global", 6);
          if (statusRateAllowed !== true) throw new Error("FOOTBALL_STATUS_RATE_GUARD_BLOCKED");
          const statusBudget = await reserveFootballBudget("emergency", "status");
          if (statusBudget?.allowed === true) {
            // Only a confirmed reservation may proceed to the provider.
          } else {
            throw new Error("FOOTBALL_STATUS_BUDGET_BLOCKED");
          }
          const statusResponse = await fetch("https://v3.football.api-sports.io/status", {
            headers: { "x-apisports-key": apiKey, "Accept": "application/json" }
          });
          const statusData = await statusResponse.json().catch(() => ({}));
          const statusErrorText = JSON.stringify(statusData?.errors ?? {}).toLowerCase();
          if (statusErrorText.includes("suspended") && statusErrorText.includes("account")) {
            await dbRest("football_api_budget_policy?singleton=eq.true", {
              method: "PATCH",
              headers: { "Prefer": "return=minimal" },
              body: JSON.stringify({
                provider_blocked: true,
                provider_blocked_at: new Date().toISOString(),
                provider_block_reason: statusErrorText.slice(0, 500)
              })
            });
            providerPolicyMemo = null;
          } else if (statusResponse.ok && !hasProviderErrors(statusData?.errors)) {
            await dbRest("football_api_budget_policy?singleton=eq.true", {
              method: "PATCH",
              headers: { "Prefer": "return=minimal" },
              body: JSON.stringify({
                provider_blocked: false,
                provider_blocked_at: null,
                provider_block_reason: null
              })
            });
            providerPolicyMemo = null;
          }
          const statusAccount = statusData?.response ?? {};
          const requestStats = statusAccount?.requests ?? {};
          const dailyRemainingHeader = statusResponse.headers.get("x-ratelimit-requests-remaining");
          const dailyLimitHeader = statusResponse.headers.get("x-ratelimit-requests-limit");
          const minuteRemainingHeader = statusResponse.headers.get("x-ratelimit-remaining");
          const minuteLimitHeader = statusResponse.headers.get("x-ratelimit-limit");
          const dailyLimit = dailyLimitHeader === null ? Number(requestStats.limit_day) : Number(dailyLimitHeader);
          const dailyRemaining = dailyRemainingHeader === null
            ? (Number.isFinite(dailyLimit) && Number.isFinite(Number(requestStats.current)) ? Math.max(0, dailyLimit - Number(requestStats.current)) : null)
            : Number(dailyRemainingHeader);
          await recordProviderUsage({
            endpoint: "status", cacheKey: "provider-status", status: statusResponse.status,
            errors: hasProviderErrors(statusData?.errors) ? statusData.errors : null,
            responseCount: Number(statusData?.results ?? 0),
            remaining: Number.isFinite(dailyRemaining) ? dailyRemaining : null,
            limit: Number.isFinite(dailyLimit) ? dailyLimit : null,
            minuteRemaining: minuteRemainingHeader === null ? null : Number(minuteRemainingHeader),
            minuteLimit: minuteLimitHeader === null ? null : Number(minuteLimitHeader),
            providerPlan: typeof statusAccount?.subscription?.plan === "string" ? statusAccount.subscription.plan : null,
            durationMs: Date.now() - statusStarted
          });
        } catch (statusError) {
          console.warn("API-Football status refresh failed", String(statusError).slice(0,160));
        }
        [usageResponse, budgetResponse] = await Promise.all([
          dbRest("rpc/football_api_usage_summary", { method: "POST", body: "{}" }),
          dbRest("rpc/football_api_budget_status", { method: "POST", body: "{}" })
        ]);
        if (!usageResponse.ok || !budgetResponse.ok) throw new Error("Usage or budget summary unavailable after status refresh");
        budgetSnapshot = await budgetResponse.json();
        const refreshedProviderState = await dbRest("football_api_budget_policy?select=provider_blocked,provider_blocked_at,provider_block_reason&singleton=eq.true&limit=1");
        if (refreshedProviderState.ok) {
          const refreshedRows = await refreshedProviderState.json();
          providerState = Array.isArray(refreshedRows) ? refreshedRows[0] : providerState;
        }
      }
      return reply({ provider: "API-Football", configured: Boolean(apiKey), ...await usageResponse.json(), budget: budgetSnapshot, providerState });
    } catch {
      return reply({ error: "تعذر قراءة لوحة استهلاك المزود حالياً." }, 503);
    }
  }
  if (action === "plans") {
    try {
      const [launchResponse, plansResponse, featuresResponse, mapResponse] = await Promise.all([
        dbRest("platform_launch_config?select=launch_mode,billing_enabled,paid_features_enforced,trial_free_all_features&limit=1"),
        dbRest("platform_plan_catalog?select=plan_code,name_ar,description_ar,display_order,billing_interval,price_minor,currency,visible,future_only&order=display_order.asc"),
        dbRest("platform_feature_catalog?select=feature_code,name_ar,description_ar,category,availability&order=category.asc"),
        dbRest("platform_plan_features?select=plan_code,feature_code,access_level,usage_limit")
      ]);
      if (![launchResponse, plansResponse, featuresResponse, mapResponse].every(response => response.ok)) {
        throw new Error("Subscription catalog unavailable");
      }
      const [launchRows, plans, features, mappings] = await Promise.all([
        launchResponse.json(), plansResponse.json(), featuresResponse.json(), mapResponse.json()
      ]);
      const launch = Array.isArray(launchRows) ? launchRows[0] : null;
      const catalog = (Array.isArray(plans) ? plans : []).map((plan: Record<string, any>) => ({
        ...plan,
        features: (Array.isArray(mappings) ? mappings : [])
          .filter((mapping: Record<string, any>) => mapping.plan_code === plan.plan_code)
          .map((mapping: Record<string, any>) => {
            const feature = (Array.isArray(features) ? features : []).find((item: Record<string, any>) => item.feature_code === mapping.feature_code);
            return feature ? { ...feature, access_level: launch?.trial_free_all_features ? "included" : mapping.access_level, usage_limit: mapping.usage_limit } : null;
          }).filter(Boolean)
      }));
      return reply({
        launchMode: launch?.launch_mode ?? "trial",
        billingEnabled: launch?.billing_enabled ?? false,
        paidFeaturesEnforced: launch?.paid_features_enforced ?? false,
        trialFreeAllFeatures: launch?.trial_free_all_features ?? true,
        plans: catalog
      });
    } catch {
      return reply({ error: "تعذر تحميل باقات أُفُق حالياً." }, 503);
    }
  }
  const requiredFeature = requiredFootballFeature(action, url);
  if (requiredFeature) {
    const authorization = await authorizeFootballFeature(request, requiredFeature);
    if (!authorization.allowed) {
      const messages: Record<string,string> = {
        AUTH_REQUIRED: "سجّل الدخول واشترك في الباقة المناسبة للوصول إلى هذه الميزة.",
        PLAN_REQUIRED: "هذه الميزة متاحة ضمن باقة أعلى. يمكنك الاطلاع على باقات أُفُق.",
        FEATURE_POLICY_UNAVAILABLE: "تعذر التحقق من صلاحيات الباقات حالياً.",
        FEATURE_CATALOG_UNAVAILABLE: "تعذر قراءة دليل الميزات حالياً.",
        ENTITLEMENT_LOOKUP_FAILED: "تعذر التحقق من اشتراك الحساب حالياً."
      };
      return reply({ error: messages[authorization.code] ?? "لا تملك صلاحية الوصول إلى هذه الميزة.", code: authorization.code, feature: requiredFeature }, authorization.status);
    }
  }
  if (!apiKey) return reply({ error: "لم تتم إضافة مفتاح مزود البيانات إلى إعدادات الخادم بعد.", code: "PROVIDER_NOT_CONFIGURED" }, 503);

  const params = new URLSearchParams();
  let endpoint = "";
  let ttl = 60_000;

  if (action === "fixtures") {
    endpoint = "fixtures";
    const mode = url.searchParams.get("mode") ?? "date";
    if (mode === "live") {
      params.set("live", "all");
      ttl = 60_000;
    } else if (mode === "last") {
      const league = url.searchParams.get("league") ?? "";
      const season = url.searchParams.get("season") ?? "";
      const last = url.searchParams.get("last") ?? "10";
      if (!/^\d+$/.test(league) || !/^20\d{2}$/.test(season) || !/^([1-9]|1\d|20)$/.test(last)) {
        return reply({ error: "معرّف البطولة أو الموسم أو عدد المباريات غير صالح." }, 400);
      }
      params.set("league", league);
      params.set("season", season);
      params.set("last", last);
      ttl = 24 * 60 * 60_000;
    } else if (mode === "season") {
      const league = url.searchParams.get("league") ?? "";
      const season = url.searchParams.get("season") ?? "";
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const page = url.searchParams.get("page") ?? "1";
      if (!/^\d+$/.test(league) || !/^20\d{2}$/.test(season) || !/^\d+$/.test(page)) {
        return reply({ error: "معرّف البطولة أو الموسم أو الصفحة غير صالح." }, 400);
      }
      if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) {
        return reply({ error: "نطاق التاريخ غير صالح." }, 400);
      }
      params.set("league", league);
      params.set("season", season);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      params.set("page", page);
      ttl = 15 * 60_000;
    } else {
      const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
      if (!validDate(date)) return reply({ error: "صيغة التاريخ غير صحيحة. استخدم YYYY-MM-DD." }, 400);
      params.set("date", date);
      ttl = 10 * 60_000;
    }
    params.set("timezone", "Asia/Damascus");
  } else if (action === "teams") {
    endpoint = "teams";
    const league = url.searchParams.get("league") ?? "";
    const season = url.searchParams.get("season") ?? "";
    if (!/^\d+$/.test(league) || !/^20\d{2}$/.test(season)) {
      return reply({ error: "معرّف البطولة أو الموسم غير صالح." }, 400);
    }
    params.set("league", league);
    params.set("season", season);
    ttl = 24 * 60 * 60_000;
  } else if (action === "leagues") {
    endpoint = "leagues";
    const search = (url.searchParams.get("search") ?? "").trim().slice(0, 60);
    const country = (url.searchParams.get("country") ?? "").trim().slice(0, 40);
    if (search.length >= 3) params.set("search", search);
    else if (country) params.set("country", country);
    else return reply({ error: "اكتب اسم بطولة من 3 أحرف على الأقل أو اسم الدولة." }, 400);
    ttl = 24 * 60 * 60_000;
  } else if (action === "standings") {
    endpoint = "standings";
    const league = url.searchParams.get("league") ?? "";
    const season = url.searchParams.get("season") ?? "";
    if (!/^\d+$/.test(league) || !/^20\d{2}$/.test(season)) return reply({ error: "معرّف البطولة أو الموسم غير صالح." }, 400);
    params.set("league", league);
    params.set("season", season);
    ttl = 60 * 60_000;
  } else if (action === "leaders") {
    const league = url.searchParams.get("league") ?? "";
    const season = url.searchParams.get("season") ?? "";
    const type = url.searchParams.get("type") ?? "scorers";
    const allowed: Record<string,string> = { scorers: "players/topscorers", assists: "players/topassists", yellow: "players/topyellowcards", red: "players/topredcards", keypasses: "players" };
    if (!/^\d+$/.test(league) || !/^20\d{2}$/.test(season) || !allowed[type]) return reply({ error: "معرّف البطولة أو الموسم أو نوع الإحصاء غير صالح." }, 400);
    endpoint = allowed[type];
    params.set("league", league);
    params.set("season", season);
    if (type === "keypasses") params.set("page", "1");
    ttl = 6 * 60 * 60_000;
  } else if (action === "match") {
    const fixture = url.searchParams.get("fixture") ?? "";
    if (!/^\d+$/.test(fixture)) return reply({ error: "رقم المباراة غير صالح." }, 400);
    const cacheKey = "match:" + fixture;
    const cachedMatch = cache.get(cacheKey);
    if (cachedMatch && cachedMatch.until > Date.now()) return reply({ ...cachedMatch.data as Record<string, unknown>, cached: true });
    try {
      const fixtureData = await providerFetch("fixtures", { id: fixture, timezone: "Asia/Damascus" }, 60_000, tracker);
      const match = Array.isArray(fixtureData.response) ? fixtureData.response[0] : null;
      if (!match) return reply({ error: "لم يعثر API-Football على المباراة بهذا الرقم." }, 404);
      const details = {
        events: match.events,
        lineups: match.lineups,
        players: match.players,
        statistics: match.statistics
      };
      const unavailable = Object.entries(details).filter(([, value]) => !Array.isArray(value)).map(([name]) => name);
      const result = {
        fixture: match,
        events: Array.isArray(details.events) ? details.events : [],
        lineups: Array.isArray(details.lineups) ? details.lineups : [],
        players: Array.isArray(details.players) ? details.players : [],
        statistics: Array.isArray(details.statistics) ? details.statistics : [],
        unavailable,
        provider: "API-Football", fetchedAt: new Date().toISOString(), cached: false,
        requestsMade: tracker.upstreamCalls, cacheHits: tracker.cacheHits,
        staleHits: tracker.staleHits, staleData: tracker.staleHits > 0, usageTracked: true
      };
      const matchPolicy = await getProviderPolicy();
      if (!matchPolicy) throw new Error("FOOTBALL_PROVIDER_STATE_UNAVAILABLE");
      const matchTtls = fixtureCacheTtls(matchPolicy);
      const matchStatus = String(match.fixture?.status?.short ?? "");
      const matchTtl = ["1H","HT","2H","ET","BT","P","LIVE"].includes(matchStatus) ? matchTtls.live : (["FT","AET","PEN"].includes(matchStatus) ? matchTtls.finished : matchTtls.nonLive);
      cache.set(cacheKey, { until: Date.now() + matchTtl, data: result });
      return reply(result);
    } catch (error) {
      if ((error as any)?.message === "FOOTBALL_PROVIDER_SUSPENDED") {
        return reply({ error: "حساب API-Football معلّق لدى المزود. أوقفنا طلبات البيانات حتى إعادة التفعيل.", code: "FOOTBALL_PROVIDER_SUSPENDED" }, 503);
      }
      return reply({ error: "تعذر تحميل تفاصيل المباراة أو أن بعض إحصاءاتها غير مشمولة في تغطية البطولة." }, 502);
    }
  } else if (action === "studio") {
    const fixtureId = url.searchParams.get("fixture") ?? "";
    if (!/^\d+$/.test(fixtureId)) return reply({ error: "رقم المباراة غير صالح." }, 400);
    const studioCacheKey = "studio:" + fixtureId;
    const previous = cache.get(studioCacheKey);
    if (previous && previous.until > Date.now()) return reply({ ...previous.data as Record<string, unknown>, cached: true });
    const persistentStudio = await persistentCacheGet(studioCacheKey);
    if (persistentStudio && typeof persistentStudio === "object") return reply({ ...persistentStudio as Record<string, unknown>, cached: true });
    const ttlFor = (path: string) => path === "fixtures/events" || path === "fixtures/statistics" || path === "fixtures/players" ? 60_000 : path === "fixtures/lineups" ? 15 * 60_000 : path === "odds" ? 3 * 60 * 60_000 : path === "predictions" ? 60 * 60_000 : 6 * 60 * 60_000;
    const apiFetch = async (path: string, query: Record<string,string> = {}) => {
      const body = await providerFetch(path, query, ttlFor(path), tracker, matchIsLive ? "live" : "core");
      return body.response;
    };
    try {
      const fixtureRowsData = await providerFetch("fixtures", { id: fixtureId, timezone: "Asia/Damascus" }, 30_000, tracker);
      const fixtureRows = fixtureRowsData.response;
      const match = fixtureRows[0];
      if (!match) return reply({ error: "لم يعثر API-Football على المباراة بهذا الرقم." }, 404);
      const matchIsLive = ["1H","HT","2H","ET","BT","P","LIVE"].includes(String(match.fixture?.status?.short ?? ""));
      const fixtureStatusForTtl = String(match.fixture?.status?.short ?? "");
      const studioPolicy = await getProviderPolicy();
      if (!studioPolicy) throw new Error("FOOTBALL_PROVIDER_STATE_UNAVAILABLE");
      const studioTtls = fixtureCacheTtls(studioPolicy);
      const fixtureTtl = ["1H","HT","2H","ET","BT","P","LIVE"].includes(fixtureStatusForTtl) ? studioTtls.live : (["FT","AET","PEN"].includes(fixtureStatusForTtl) ? studioTtls.finished : studioTtls.nonLive);
      const fixtureCacheKey = "fixtures?id=" + fixtureId + "&timezone=Asia%2FDamascus";
      cache.set("provider:" + fixtureCacheKey, { until: Date.now() + Math.min(fixtureTtl, 60_000), data: fixtureRowsData });
      await persistentCacheSet(fixtureCacheKey, "fixtures", fixtureRowsData, fixtureTtl);
      const homeId = String(match.teams?.home?.id ?? "");
      const awayId = String(match.teams?.away?.id ?? "");
      const leagueId = String(match.league?.id ?? "");
      const season = String(match.league?.season ?? "");
      if (![homeId, awayId, leagueId].every(value => /^\d+$/.test(value)) || !/^\d{4}$/.test(season)) {
        return reply({ error: "بيانات الفريقين أو البطولة أو الموسم غير مكتملة لهذه المباراة." }, 422);
      }
      const pair = homeId + "-" + awayId;
      const coverageRows = await apiFetch("leagues", { id: leagueId, season });
      const coverageRecord = Array.isArray(coverageRows) ? coverageRows[0] : null;
      const seasonCoverage = Array.isArray(coverageRecord?.seasons)
        ? coverageRecord.seasons.find((item: Record<string, any>) => String(item.year) === season)
        : null;
      const coverage = seasonCoverage?.coverage ?? {};
      const specs: Record<string, [string, Record<string,string>]> = {
        headtohead: ["fixtures/headtohead", { h2h: pair, last: "10" }],
        homeTeamStats: ["teams/statistics", { league: leagueId, season, team: homeId }],
        awayTeamStats: ["teams/statistics", { league: leagueId, season, team: awayId }],
        homeRecent: ["fixtures", { team: homeId, last: "5", timezone: "Asia/Damascus" }],
        awayRecent: ["fixtures", { team: awayId, last: "5", timezone: "Asia/Damascus" }],
        homeTeam: ["teams", { id: homeId }],
        awayTeam: ["teams", { id: awayId }]
      };
      const optionalCoverage: Record<string, [string, Record<string,string>, boolean]> = {
        predictions: ["predictions", { fixture: fixtureId }, coverage.predictions === true],
        injuries: ["injuries", { fixture: fixtureId }, coverage.injuries === true],
        standings: ["standings", { league: leagueId, season }, coverage.standings === true],
        odds: ["odds", { fixture: fixtureId }, coverage.odds === true]
      };
      for (const [name, [path, query, covered]] of Object.entries(optionalCoverage)) {
        if (covered) specs[name] = [path, query];
      }
      const names = Object.keys(specs);
      const results = await Promise.allSettled(names.map(name => apiFetch(specs[name][0], specs[name][1])));
      const sections: Record<string, unknown> = {
        events: Array.isArray(match.events) ? match.events : [],
        lineups: Array.isArray(match.lineups) ? match.lineups : [],
        players: Array.isArray(match.players) ? match.players : [],
        statistics: Array.isArray(match.statistics) ? match.statistics : [],
        coverage: Array.isArray(coverageRows) ? coverageRows : []
      };
      const unavailable: string[] = ["events", "lineups", "players", "statistics"]
        .filter(name => !Array.isArray((match as Record<string, any>)[name]));
      if (!Array.isArray(coverageRows) || coverageRows.length === 0) unavailable.push("coverage");
      for (const name of Object.keys(optionalCoverage)) {
        if (optionalCoverage[name][2] !== true) {
          sections[name] = [];
          unavailable.push(name);
        }
      }
      results.forEach((result, index) => {
        const name = names[index];
        if (result.status === "fulfilled") sections[name] = result.value;
        else { sections[name] = []; unavailable.push(name); }
      });
      const status = String(match.fixture?.status?.short ?? "");
      const live = ["1H","HT","2H","ET","BT","P","LIVE"].includes(status);
      const result = {
        fixture: match,
        ...sections,
        unavailable,
        requestsMade: tracker.upstreamCalls,
        budgetLimitedRequests: tracker.budgetBlocked,
        quotaWarning: tracker.budgetBlocked > 0,
        cacheHits: tracker.cacheHits,
        staleHits: tracker.staleHits,
        staleData: tracker.staleHits > 0,
        usageTracked: true,
        provider: "API-Football",
        fetchedAt: new Date().toISOString(),
        cacheSeconds: Math.floor(fixtureTtl / 1000),
        cached: false
      };
      cache.set(studioCacheKey, { until: Date.now() + fixtureTtl, data: result });
      await persistentCacheSet(studioCacheKey, "studio", result, fixtureTtl);
      return reply(result);
    } catch (error) {
      console.error("Football studio error", String(error).slice(0, 300));
      if ((error as any)?.message === "FOOTBALL_PROVIDER_SUSPENDED") {
        return reply({ error: "حساب API-Football معلّق لدى المزود. أوقفنا طلبات البيانات حتى إعادة التفعيل.", code: "FOOTBALL_PROVIDER_SUSPENDED" }, 503);
      }
      return reply({ error: "تعذر تجهيز الاستوديو لهذه المباراة. تحقق من تغطية البطولة أو معرّف المباراة." }, 502);
    }
  } else if (action === "team") {
    endpoint = "teams";
    const id = url.searchParams.get("id") ?? "";
    if (!/^\d+$/.test(id)) return reply({ error: "معرّف النادي غير صالح." }, 400);
    params.set("id", id);
    ttl = 24 * 60 * 60_000;
  } else if (action === "trophies") {
    endpoint = "trophies";
    const player = url.searchParams.get("player") ?? "";
    const coach = url.searchParams.get("coach") ?? "";
    if (player && /^\d+$/.test(player)) params.set("player", player);
    else if (coach && /^\d+$/.test(coach)) params.set("coach", coach);
    else return reply({ error: "معرّف اللاعب أو المدرب غير صالح." }, 400);
    ttl = 24 * 60 * 60_000;

  } else if (action === "catalog") {
    const dataset = url.searchParams.get("dataset") ?? "";
    const catalog: Record<string, { path: string; keys: string[]; ttl: number }> = {
      countries: { path: "countries", keys: ["name","search"], ttl: 86400000 },
      seasons: { path: "leagues/seasons", keys: [], ttl: 86400000 },
      timezones: { path: "timezone", keys: [], ttl: 86400000 },
      rounds: { path: "fixtures/rounds", keys: ["league","season","current"], ttl: 86400000 },
      standings: { path: "standings", keys: ["league","season"], ttl: 3600000 },
      scorers: { path: "players/topscorers", keys: ["league","season"], ttl: 21600000 },
      assists: { path: "players/topassists", keys: ["league","season"], ttl: 21600000 },
      yellow_cards: { path: "players/topyellowcards", keys: ["league","season"], ttl: 21600000 },
      red_cards: { path: "players/topredcards", keys: ["league","season"], ttl: 21600000 },
      trophies: { path: "trophies", keys: ["player","coach"], ttl: 86400000 },
      headtohead: { path: "fixtures/headtohead", keys: ["h2h","date","league","season","last","next","from","to","status","venue","timezone"], ttl: 3600000 },
      venues: { path: "venues", keys: ["id","name","city","country","search"], ttl: 86400000 },
      team_stats: { path: "teams/statistics", keys: ["league","season","team","date"], ttl: 43200000 },
      team_seasons: { path: "teams/seasons", keys: ["team"], ttl: 86400000 },
      team_countries: { path: "teams/countries", keys: [], ttl: 86400000 },
      players: { path: "players", keys: ["id","team","league","season","search","page"], ttl: 21600000 },
      player_seasons: { path: "players/seasons", keys: ["player"], ttl: 86400000 },
      squads: { path: "players/squads", keys: ["team","player"], ttl: 86400000 },
      coaches: { path: "coachs", keys: ["id","team","search"], ttl: 86400000 },
      transfers: { path: "transfers", keys: ["player","team"], ttl: 21600000 },
      sidelined: { path: "sidelined", keys: ["player","players","coach","coachs"], ttl: 21600000 },
      injuries: { path: "injuries", keys: ["league","season","fixture","team","player","date","ids","timezone"], ttl: 14400000 },
      predictions: { path: "predictions", keys: ["fixture"], ttl: 3600000 },
      odds: { path: "odds", keys: ["fixture","league","season","date","timezone","page","bookmaker","bet"], ttl: 10800000 },
      odds_live: { path: "odds/live", keys: ["fixture","league","bet"], ttl: 15000 },
      odds_bets: { path: "odds/live/bets", keys: ["id","search"], ttl: 60000 },
      odds_mapping: { path: "odds/mapping", keys: ["page"], ttl: 86400000 },
      bookmakers: { path: "odds/bookmakers", keys: ["id","search"], ttl: 86400000 },
      fixture_events: { path: "fixtures/events", keys: ["fixture","team","player","type"], ttl: 60000 },
      fixture_lineups: { path: "fixtures/lineups", keys: ["fixture","team","player","type"], ttl: 900000 },
      fixture_stats: { path: "fixtures/statistics", keys: ["fixture","team","type","half"], ttl: 60000 },
      fixture_players: { path: "fixtures/players", keys: ["fixture","team"], ttl: 60000 },
      team_list: { path: "teams", keys: ["id","name","league","season","country","code","venue","search"], ttl: 86400000 },
      league_list: { path: "leagues", keys: ["id","name","country","code","season","team","type","current","search"], ttl: 86400000 },
      fixture_list: { path: "fixtures", keys: ["id","ids","live","date","league","season","team","last","next","from","to","round","status","venue","timezone"], ttl: 60000 }
    };
    const config = catalog[dataset];
    if (!config) return reply({ error: "قسم البيانات غير معروف." }, 400);
    for (const key of config.keys) {
      const value = url.searchParams.get(key);
      if (value !== null && value.trim() !== "") params.set(key, value.trim().slice(0, 120));
    }
    if (["standings","scorers","assists","yellow_cards","red_cards","rounds"].includes(dataset) && (!params.has("league") || !params.has("season"))) {
      return reply({ error: "يتطلب هذا القسم league و season، مثال league=39&season=2025." }, 400);
    }
    if (dataset === "trophies" && !((params.has("player") && /^\d+$/.test(params.get("player")!)) || (params.has("coach") && /^\d+$/.test(params.get("coach")!)))) return reply({ error: "سجل البطولات يتطلب player=رقم اللاعب أو coach=رقم المدرب." }, 400);
    if (dataset === "team_stats" && (!params.has("team") || !params.has("league") || !params.has("season"))) {
      return reply({ error: "إحصاءات الفريق تتطلب team و league و season." }, 400);
    }
    if (dataset === "team_seasons" && !params.has("team")) return reply({ error: "أدخل team لمعرف النادي." }, 400);
    if (dataset === "team_list" && !params.has("team") && !params.has("id") && !params.has("league") && !params.has("search") && !params.has("country") && !params.has("name") && !params.has("venue")) {
      return reply({ error: "أدخل مُعرّفاً أو معيار بحث صالحاً لهذا القسم." }, 400);
    }
    if (["players","player_seasons","squads","coaches","transfers","sidelined","injuries","venues","odds_bets","bookmakers","trophies"].includes(dataset) && params.size === 0) {
      return reply({ error: "أدخل معيار بحث واحداً على الأقل لهذا القسم." }, 400);
    }
    if (["fixture_events","fixture_lineups","fixture_stats","fixture_players","predictions","headtohead"].includes(dataset) && !params.has("fixture") && !params.has("h2h")) {
      return reply({ error: dataset === "headtohead" ? "أدخل h2h بصيغة teamID-teamID." : "أدخل رقم المباراة fixture." }, 400);
    }
    if (["players","team_stats","team_seasons","team_list","fixture_list","rounds","odds","injuries"].includes(dataset) && params.has("season") && !/^\d{4}$/.test(params.get("season")!)) {
      return reply({ error: "الموسم يجب أن يكون أربع خانات مثل 2025." }, 400);
    }
    endpoint = config.path;
    ttl = config.ttl;
  } else {
    return reply({ error: "نوع الطلب غير مدعوم." }, 400);
  }

  const cacheKey = endpoint + "?" + params.toString();
  const cached = cache.get(cacheKey);
  if (cached && cached.until > Date.now()) return reply({ ...cached.data as Record<string, unknown>, cached: true });

  try {
    const data = await providerFetch(endpoint, Object.fromEntries(params.entries()), ttl, tracker, (action === "fixtures" && url.searchParams.get("mode") === "live") || (action === "catalog" && ["odds_live","fixture_events","fixture_stats","fixture_players"].includes(url.searchParams.get("dataset") ?? "")) ? "live" : "core");
    return reply({ ...data, cacheHits: tracker.cacheHits, staleHits: tracker.staleHits, staleData: tracker.staleHits > 0, upstreamCalls: tracker.upstreamCalls, budgetLimitedRequests: tracker.budgetBlocked, quotaWarning: tracker.budgetBlocked > 0, usageTracked: true });
  } catch (error) {
    const status = Number((error as any)?.status ?? 502);
    const message = (error as any)?.message ?? "";
    if (status === 503 && message === "FOOTBALL_PROVIDER_SUSPENDED") {
      return reply({ error: "حساب API-Football معلّق لدى المزود. أوقفنا طلبات البيانات حتى إعادة التفعيل.", code: "FOOTBALL_PROVIDER_SUSPENDED" }, 503);
    }
    if (status === 503 && message === "FOOTBALL_PROVIDER_STATE_UNAVAILABLE") {
      return reply({ error: "تعذر قراءة حالة مزود البيانات؛ أوقفنا الاتصال لحماية الحصة.", code: "FOOTBALL_PROVIDER_STATE_UNAVAILABLE" }, 503);
    }
    if (status === 429 && message === "FOOTBALL_DAILY_BUDGET_LIMIT") {
      return reply({ error: "وصلنا إلى الحد الوقائي المسموح لاستهلاك بيانات كرة القدم حالياً. سنستأنف التحديث تلقائياً مع توفر ميزانية جديدة، وقد نعرض نسخة محفوظة إن توفرت.", code: "FOOTBALL_BUDGET_LIMIT", budget: (error as any)?.budget ?? null }, 429);
    }
    if (status === 503 && message === "FOOTBALL_BUDGET_GUARD_UNAVAILABLE") {
      return reply({ error: "حارس الحصة غير متاح مؤقتاً؛ أوقفنا الاتصال بمزود البيانات لحماية المفتاح.", code: "FOOTBALL_BUDGET_GUARD_UNAVAILABLE" }, 503);
    }
    return reply({ error: "تعذر جلب البيانات من مزود كرة القدم أو أن الخطة لا تغطي هذا الطلب.", providerStatus: status }, status === 429 ? 429 : 502);
  }
});
