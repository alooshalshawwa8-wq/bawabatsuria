-- Enforce a conservative internal cap regardless of provider headers.
-- Applied to the production Supabase project after explicit owner authorization.
-- Provider blocking remains enabled until API-SPORTS confirms account reactivation.

update public.football_api_budget_policy
set daily_limit_override = 70,
    core_budget_percent = 57.15,
    live_budget_percent = 28.58,
    emergency_budget_percent = 14.27,
    warning_percent = 50,
    critical_percent = 85,
    updated_at = now()
where singleton = true;

create or replace function public.football_api_budget_reserve(
  p_bucket text,
  p_endpoint text default 'unknown'
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_policy public.football_api_budget_policy%rowtype;
  v_today date := (now() at time zone 'utc')::date;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_minute_start timestamptz := now() - interval '60 seconds';
  v_limit integer;
  v_limit_source text;
  v_header_remaining integer;
  v_header_limit integer;
  v_header_at timestamptz;
  v_reserved_total integer;
  v_reserved_bucket integer;
  v_reserved_after_header integer;
  v_bucket_limit integer;
  v_critical_at integer;
  v_pace_fraction numeric;
  v_paced_total integer;
  v_paced_bucket integer;
  v_provider_remaining integer;
  v_safe_remaining integer;
  v_elapsed numeric;
  v_minute_limit integer;
  v_minute_remaining integer;
  v_minute_header_at timestamptz;
  v_minute_used integer;
  v_minute_after_header integer;
  v_minute_safe_remaining integer;
  v_reset_at timestamptz := v_day_start + interval '1 day';
begin
  if p_bucket not in ('core', 'live', 'emergency') then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_bucket');
  end if;

  -- One global lock serializes all upstream reservations, including across UTC midnight.
  perform pg_advisory_xact_lock(hashtext('football-api-provider-minute'));
  perform pg_advisory_xact_lock(hashtext('football-api-budget:' || v_today::text));

  select * into v_policy
  from public.football_api_budget_policy
  where singleton = true;

  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'policy_missing');
  end if;

  -- The database, not a cached Edge Function flag, is authoritative for suspension.
  if v_policy.provider_blocked = true then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'provider_blocked',
      'providerBlocked', true,
      'dailyLimit', 70,
      'usedToday', 0
    );
  end if;

  select requests_limit, requests_remaining, created_at
    into v_header_limit, v_header_remaining, v_header_at
  from public.football_api_usage
  where created_at >= v_day_start
    and requests_limit is not null
    and requests_remaining is not null
  order by created_at desc
  limit 1;

  -- Never allow more than 70/day, even if provider headers or policy are higher.
  v_limit := least(
    70,
    coalesce(nullif(v_policy.daily_limit_override, 0), 70),
    coalesce(nullif(v_header_limit, 0), 100)
  );
  v_limit_source := case
    when v_limit < 70 then 'provider_or_policy_lower_limit'
    else 'internal_70_cap'
  end;

  select minute_limit into v_minute_limit
  from public.football_api_usage
  where minute_limit is not null
  order by created_at desc
  limit 1;

  select minute_remaining, created_at
    into v_minute_remaining, v_minute_header_at
  from public.football_api_usage
  where created_at >= v_minute_start
    and minute_remaining is not null
  order by created_at desc
  limit 1;

  -- Six is the hard internal rolling-window cap; honor a lower provider limit.
  v_minute_limit := least(6, coalesce(nullif(v_minute_limit, 0), 10));

  select count(*)::integer into v_minute_used
  from public.football_api_budget_reservations
  where reserved_at >= v_minute_start;

  if v_minute_header_at is not null then
    select count(*)::integer into v_minute_after_header
    from public.football_api_budget_reservations
    where reserved_at >= v_minute_start
      and reserved_at > v_minute_header_at;

    v_minute_safe_remaining := least(
      greatest(0, v_minute_limit - v_minute_used),
      greatest(0, coalesce(v_minute_remaining, 0) - v_minute_after_header)
    );
  else
    v_minute_safe_remaining := greatest(0, v_minute_limit - v_minute_used);
  end if;

  if v_minute_safe_remaining <= 0 then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'minute_rate_limit',
      'minuteLimit', v_minute_limit,
      'minuteUsed', v_minute_used,
      'minuteRemaining', 0,
      'retryAt', now() + interval '60 seconds'
    );
  end if;

  select count(*)::integer into v_reserved_total
  from public.football_api_budget_reservations
  where usage_date = v_today;

  select count(*)::integer into v_reserved_bucket
  from public.football_api_budget_reservations
  where usage_date = v_today and bucket = p_bucket;

  if v_header_at is not null then
    select count(*)::integer into v_reserved_after_header
    from public.football_api_budget_reservations
    where usage_date = v_today and reserved_at > v_header_at;
    v_provider_remaining := greatest(0, coalesce(v_header_remaining, 0) - v_reserved_after_header);
  else
    v_provider_remaining := v_limit;
  end if;

  v_safe_remaining := least(greatest(0, v_limit - v_reserved_total), v_provider_remaining);

  v_elapsed := greatest(0, least(86400, extract(epoch from (now() - v_day_start))));
  v_pace_fraction := (v_policy.pacing_buffer_percent / 100.0)
    + ((1 - v_policy.pacing_buffer_percent / 100.0) * (v_elapsed / 86400.0));
  v_paced_total := greatest(1, floor(v_limit * v_pace_fraction)::integer);
  v_critical_at := ceil(v_limit * coalesce(v_policy.critical_percent, 85) / 100.0)::integer;

  -- Freeze secondary traffic at the critical threshold; preserve core requests until the hard daily cap.
  if p_bucket in ('live', 'emergency') and v_reserved_total >= v_critical_at then
    return jsonb_build_object(
      'allowed', false, 'reason', 'secondary_frozen',
      'criticalAt', v_critical_at, 'dailyLimit', v_limit,
      'usedToday', v_reserved_total, 'remaining', v_safe_remaining
    );
  end if;

  -- Fixed 40:20:10 split at the 70-call cap, scaled down if provider quota is lower.
  v_bucket_limit := case p_bucket
    when 'core' then floor(v_limit * 40.0 / 70.0)::integer
    when 'live' then floor(v_limit * 20.0 / 70.0)::integer
    else v_limit - floor(v_limit * 40.0 / 70.0)::integer - floor(v_limit * 20.0 / 70.0)::integer
  end;
  v_paced_bucket := floor(v_bucket_limit * v_pace_fraction)::integer;

  if v_safe_remaining <= 0 or v_reserved_total >= v_limit then
    return jsonb_build_object(
      'allowed', false, 'reason', 'daily_limit',
      'dailyLimit', v_limit, 'usedToday', v_reserved_total,
      'remaining', greatest(0, v_safe_remaining),
      'limitSource', v_limit_source, 'resetAt', v_reset_at
    );
  end if;

  if v_reserved_total >= v_paced_total then
    return jsonb_build_object(
      'allowed', false, 'reason', 'daily_pacing',
      'dailyLimit', v_limit, 'usedToday', v_reserved_total,
      'allowedSoFar', v_paced_total, 'remaining', v_safe_remaining,
      'limitSource', v_limit_source, 'resetAt', v_reset_at
    );
  end if;

  if v_bucket_limit <= 0 or v_reserved_bucket >= least(v_bucket_limit, v_paced_bucket) then
    return jsonb_build_object(
      'allowed', false, 'reason', 'bucket_budget', 'bucket', p_bucket,
      'bucketLimit', v_bucket_limit, 'bucketUsed', v_reserved_bucket,
      'dailyLimit', v_limit, 'usedToday', v_reserved_total,
      'remaining', v_safe_remaining, 'limitSource', v_limit_source
    );
  end if;

  insert into public.football_api_budget_reservations(usage_date, bucket, endpoint)
  values (v_today, p_bucket, left(coalesce(p_endpoint, 'unknown'), 120));

  return jsonb_build_object(
    'allowed', true,
    'bucket', p_bucket,
    'bucketLimit', v_bucket_limit,
    'bucketUsed', v_reserved_bucket + 1,
    'dailyLimit', v_limit,
    'usedToday', v_reserved_total + 1,
    'allowedSoFar', v_paced_total,
    'remaining', greatest(0, v_safe_remaining - 1),
    'minuteLimit', v_minute_limit,
    'minuteRemaining', greatest(0, v_minute_safe_remaining - 1),
    'limitSource', v_limit_source,
    'resetAt', v_reset_at
  );
end;
$function$;

create or replace function public.football_api_budget_status()
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_policy public.football_api_budget_policy%rowtype;
  v_today date := (now() at time zone 'utc')::date;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_minute_start timestamptz := now() - interval '60 seconds';
  v_header_limit integer;
  v_header_remaining integer;
  v_header_at timestamptz;
  v_limit integer;
  v_used integer;
  v_after_header integer;
  v_remaining integer;
  v_elapsed numeric;
  v_pace_fraction numeric;
  v_allowed_so_far integer;
  v_core integer;
  v_live integer;
  v_emergency integer;
  v_provider_minute_limit integer;
  v_minute_header_remaining integer;
  v_minute_header_at timestamptz;
  v_minute_used integer;
  v_minute_after_header integer;
  v_minute_remaining integer;
  v_minute_limit integer;
  v_warning_at integer;
  v_critical_at integer;
begin
  select * into v_policy from public.football_api_budget_policy where singleton = true;

  select requests_limit, requests_remaining, created_at
    into v_header_limit, v_header_remaining, v_header_at
  from public.football_api_usage
  where created_at >= v_day_start and requests_limit is not null and requests_remaining is not null
  order by created_at desc limit 1;

  v_limit := least(70, coalesce(nullif(v_policy.daily_limit_override, 0), 70), coalesce(nullif(v_header_limit, 0), 100));

  select minute_limit into v_provider_minute_limit
  from public.football_api_usage where minute_limit is not null order by created_at desc limit 1;
  select minute_remaining, created_at into v_minute_header_remaining, v_minute_header_at
  from public.football_api_usage
  where created_at >= v_minute_start and minute_remaining is not null
  order by created_at desc limit 1;

  v_minute_limit := least(6, coalesce(nullif(v_provider_minute_limit, 0), 10));
  select count(*)::integer into v_minute_used
  from public.football_api_budget_reservations where reserved_at >= v_minute_start;

  if v_minute_header_at is not null then
    select count(*)::integer into v_minute_after_header
    from public.football_api_budget_reservations
    where reserved_at >= v_minute_start and reserved_at > v_minute_header_at;
    v_minute_remaining := least(
      greatest(0, v_minute_limit - v_minute_used),
      greatest(0, coalesce(v_minute_header_remaining, 0) - v_minute_after_header)
    );
  else
    v_minute_remaining := greatest(0, v_minute_limit - v_minute_used);
  end if;

  select count(*)::integer into v_used
  from public.football_api_budget_reservations where usage_date = v_today;

  if v_header_at is not null then
    select count(*)::integer into v_after_header
    from public.football_api_budget_reservations
    where usage_date = v_today and reserved_at > v_header_at;
    v_remaining := least(greatest(0, v_limit - v_used), greatest(0, coalesce(v_header_remaining, 0) - v_after_header));
  else
    v_remaining := greatest(0, v_limit - v_used);
  end if;

  v_elapsed := greatest(0, least(86400, extract(epoch from (now() - v_day_start))));
  v_pace_fraction := (v_policy.pacing_buffer_percent / 100.0)
    + ((1 - v_policy.pacing_buffer_percent / 100.0) * (v_elapsed / 86400.0));
  v_allowed_so_far := greatest(1, floor(v_limit * v_pace_fraction)::integer);
  v_warning_at := ceil(v_limit * coalesce(v_policy.warning_percent, 50) / 100.0)::integer;
  v_critical_at := ceil(v_limit * coalesce(v_policy.critical_percent, 85) / 100.0)::integer;

  select
    count(*) filter (where bucket = 'core')::integer,
    count(*) filter (where bucket = 'live')::integer,
    count(*) filter (where bucket = 'emergency')::integer
  into v_core, v_live, v_emergency
  from public.football_api_budget_reservations where usage_date = v_today;

  return jsonb_build_object(
    'dailyLimit', v_limit,
    'limitSource', case when v_limit < 70 then 'provider_or_policy_lower_limit' else 'internal_70_cap' end,
    'usedToday', v_used,
    'remaining', v_remaining,
    'allowedSoFar', v_allowed_so_far,
    'warningAt', v_warning_at,
    'criticalAt', v_critical_at,
    'warningReached', v_used >= v_warning_at,
    'secondaryFrozen', v_used >= v_critical_at,
    'pacingBufferPercent', v_policy.pacing_buffer_percent,
    'minuteLimit', v_minute_limit,
    'minuteRemaining', v_minute_remaining,
    'providerBlocked', coalesce(v_policy.provider_blocked, false),
    'buckets', jsonb_build_object('core', v_core, 'live', v_live, 'emergency', v_emergency),
    'bucketTargets', jsonb_build_object(
      'core', floor(v_limit * 40.0 / 70.0)::integer,
      'live', floor(v_limit * 20.0 / 70.0)::integer,
      'emergency', v_limit - floor(v_limit * 40.0 / 70.0)::integer - floor(v_limit * 20.0 / 70.0)::integer
    ),
    'providerRemaining', v_header_remaining,
    'providerMinuteRemaining', v_minute_header_remaining,
    'providerHeaderAt', v_header_at,
    'providerMinuteHeaderAt', v_minute_header_at,
    'resetAt', v_day_start + interval '1 day'
  );
end;
$function$;
