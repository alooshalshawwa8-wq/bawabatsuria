CREATE OR REPLACE FUNCTION public.football_api_budget_reserve(p_bucket text, p_endpoint text DEFAULT 'unknown'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
 v_policy public.football_api_budget_policy%rowtype;
 v_today date := (now() at time zone 'utc')::date;
 v_day_start timestamptz := date_trunc('day',now() at time zone 'utc') at time zone 'utc';
 v_minute_start timestamptz := now()-interval '60 seconds';
 v_limit integer; v_limit_source text; v_header_remaining integer; v_header_limit integer; v_header_at timestamptz;
 v_reserved_total integer; v_reserved_bucket integer; v_reserved_after_header integer;
 v_bucket_percent numeric; v_bucket_limit integer; v_pace_fraction numeric; v_paced_total integer; v_paced_bucket integer;
 v_provider_remaining integer; v_safe_remaining integer; v_elapsed numeric;
 v_minute_limit integer; v_minute_remaining integer; v_minute_header_at timestamptz;
 v_minute_used integer; v_minute_after_header integer; v_minute_safe_remaining integer;
 v_reset_at timestamptz := v_day_start+interval '1 day';
begin
 if p_bucket not in ('core','live','emergency') then return jsonb_build_object('allowed',false,'reason','invalid_bucket'); end if;
 perform pg_advisory_xact_lock(hashtext('football-api-budget:'||v_today::text));
 select * into v_policy from public.football_api_budget_policy where singleton=true;
 if not found then return jsonb_build_object('allowed',false,'reason','policy_missing'); end if;
 if v_policy.provider_blocked is true then return jsonb_build_object('allowed',false,'reason','provider_blocked','providerBlocked',true); end if;
 select requests_limit,requests_remaining,created_at into v_header_limit,v_header_remaining,v_header_at
 from public.football_api_usage where created_at>=v_day_start and requests_limit is not null and requests_remaining is not null order by created_at desc limit 1;
 if v_policy.daily_limit_override is not null then v_limit:=v_policy.daily_limit_override; v_limit_source:='manual_override';
 elsif v_header_limit is not null and v_header_limit>0 then v_limit:=v_header_limit; v_limit_source:='provider_header';
 else v_limit:=100; v_limit_source:='conservative_100_fallback'; end if;
 v_limit:=least(v_limit,70);
 select minute_limit into v_minute_limit from public.football_api_usage where minute_limit is not null order by created_at desc limit 1;
 select minute_remaining,created_at into v_minute_remaining,v_minute_header_at
 from public.football_api_usage where created_at>=v_minute_start and minute_remaining is not null order by created_at desc limit 1;
 if v_minute_limit is null or v_minute_limit<=0 then v_minute_limit:=10; end if;
 v_minute_limit:=least(v_minute_limit,6);
 select count(*)::integer into v_minute_used from public.football_api_budget_reservations where reserved_at>=v_minute_start;
 if v_minute_header_at is not null then
   select count(*)::integer into v_minute_after_header from public.football_api_budget_reservations where reserved_at>=v_minute_start and reserved_at>v_minute_header_at;
   v_minute_safe_remaining:=least(greatest(0,v_minute_limit-v_minute_used),greatest(0,coalesce(v_minute_remaining,0)-v_minute_after_header));
 else v_minute_safe_remaining:=greatest(0,v_minute_limit-v_minute_used); end if;
 if v_minute_safe_remaining<=0 then return jsonb_build_object('allowed',false,'reason','minute_rate_limit','minuteLimit',v_minute_limit,'minuteUsed',v_minute_used,'minuteRemaining',0,'retryAt',now()+interval '60 seconds'); end if;
 select count(*)::integer into v_reserved_total from public.football_api_budget_reservations where usage_date=v_today;
 select count(*)::integer into v_reserved_bucket from public.football_api_budget_reservations where usage_date=v_today and bucket=p_bucket;
 if v_reserved_total>=60 and p_bucket in ('live','emergency') then return jsonb_build_object('allowed',false,'reason','secondary_frozen','dailyLimit',70,'usedToday',v_reserved_total,'remaining',greatest(0,70-v_reserved_total)); end if;
 if v_header_at is not null then
   select count(*)::integer into v_reserved_after_header from public.football_api_budget_reservations where usage_date=v_today and reserved_at>v_header_at;
   v_provider_remaining:=greatest(0,coalesce(v_header_remaining,0)-v_reserved_after_header);
 else v_provider_remaining:=v_limit; end if;
 v_safe_remaining:=least(greatest(0,v_limit-v_reserved_total),v_provider_remaining);
 v_elapsed:=greatest(0,least(86400,extract(epoch from(now()-v_day_start))));
 v_pace_fraction:=(v_policy.pacing_buffer_percent/100.0)+((1-v_policy.pacing_buffer_percent/100.0)*(v_elapsed/86400.0));
 v_paced_total:=greatest(1,floor(v_limit*v_pace_fraction)::integer);
 v_bucket_percent:=case p_bucket when 'core' then v_policy.core_budget_percent when 'live' then v_policy.live_budget_percent else v_policy.emergency_budget_percent end;
 v_bucket_limit:=floor(v_limit*v_bucket_percent/100.0)::integer;
 if p_bucket='emergency' then v_bucket_limit:=greatest(0,v_limit-floor(v_limit*v_policy.core_budget_percent/100.0)::integer-floor(v_limit*v_policy.live_budget_percent/100.0)::integer); end if;
 v_paced_bucket:=floor(v_bucket_limit*v_pace_fraction)::integer;
 if v_safe_remaining<=0 or v_reserved_total>=v_limit then return jsonb_build_object('allowed',false,'reason','daily_limit','dailyLimit',v_limit,'usedToday',v_reserved_total,'remaining',greatest(0,v_safe_remaining),'limitSource',v_limit_source,'resetAt',v_reset_at); end if;
 if v_reserved_total>=v_paced_total then return jsonb_build_object('allowed',false,'reason','daily_pacing','dailyLimit',v_limit,'usedToday',v_reserved_total,'allowedSoFar',v_paced_total,'remaining',v_safe_remaining,'limitSource',v_limit_source,'resetAt',v_reset_at); end if;
 if v_bucket_limit<=0 or v_reserved_bucket>=least(v_bucket_limit,v_paced_bucket) then return jsonb_build_object('allowed',false,'reason','bucket_budget','bucket',p_bucket,'bucketLimit',v_bucket_limit,'bucketUsed',v_reserved_bucket,'dailyLimit',v_limit,'usedToday',v_reserved_total,'remaining',v_safe_remaining,'limitSource',v_limit_source,'resetAt',v_reset_at); end if;
 insert into public.football_api_budget_reservations(usage_date,bucket,endpoint) values(v_today,p_bucket,left(coalesce(p_endpoint,'unknown'),120));
 return jsonb_build_object('allowed',true,'bucket',p_bucket,'bucketLimit',v_bucket_limit,'bucketUsed',v_reserved_bucket+1,'dailyLimit',v_limit,'usedToday',v_reserved_total+1,'allowedSoFar',v_paced_total,'remaining',greatest(0,v_safe_remaining-1),'minuteLimit',v_minute_limit,'minuteRemaining',greatest(0,v_minute_safe_remaining-1),'limitSource',v_limit_source,'resetAt',v_reset_at);
end; $function$;

CREATE OR REPLACE FUNCTION public.football_api_budget_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
 v_policy public.football_api_budget_policy%rowtype;
 v_today date := (now() at time zone 'utc')::date;
 v_day_start timestamptz := date_trunc('day',now() at time zone 'utc') at time zone 'utc';
 v_minute_start timestamptz := now()-interval '60 seconds';
 v_limit integer; v_limit_source text; v_header_limit integer; v_header_remaining integer; v_header_at timestamptz;
 v_used integer; v_after_header integer; v_remaining integer; v_elapsed numeric; v_pace_fraction numeric; v_allowed_so_far integer;
 v_core integer; v_live integer; v_emergency integer;
 v_minute_limit integer; v_minute_header_remaining integer; v_minute_header_at timestamptz; v_minute_used integer; v_minute_after_header integer; v_minute_remaining integer;
begin
 select * into v_policy from public.football_api_budget_policy where singleton=true;
 select requests_limit,requests_remaining,created_at into v_header_limit,v_header_remaining,v_header_at
 from public.football_api_usage where created_at>=v_day_start and requests_limit is not null and requests_remaining is not null order by created_at desc limit 1;
 if v_policy.daily_limit_override is not null then v_limit:=v_policy.daily_limit_override; v_limit_source:='manual_override';
 elsif v_header_limit is not null and v_header_limit>0 then v_limit:=v_header_limit; v_limit_source:='provider_header';
 else v_limit:=100; v_limit_source:='conservative_100_fallback'; end if;
 v_limit:=least(v_limit,70);
 select minute_limit into v_minute_limit from public.football_api_usage where minute_limit is not null order by created_at desc limit 1;
 select minute_remaining,created_at into v_minute_header_remaining,v_minute_header_at
 from public.football_api_usage where created_at>=v_minute_start and minute_remaining is not null order by created_at desc limit 1;
 if v_minute_limit is null or v_minute_limit<=0 then v_minute_limit:=10; end if;
 v_minute_limit:=least(v_minute_limit,6);
 select count(*)::integer into v_minute_used from public.football_api_budget_reservations where reserved_at>=v_minute_start;
 if v_minute_header_at is not null then
   select count(*)::integer into v_minute_after_header from public.football_api_budget_reservations where reserved_at>=v_minute_start and reserved_at>v_minute_header_at;
   v_minute_remaining:=least(greatest(0,v_minute_limit-v_minute_used),greatest(0,coalesce(v_minute_header_remaining,0)-v_minute_after_header));
 else v_minute_remaining:=greatest(0,v_minute_limit-v_minute_used); end if;
 select count(*)::integer into v_used from public.football_api_budget_reservations where usage_date=v_today;
 if v_header_at is not null then
   select count(*)::integer into v_after_header from public.football_api_budget_reservations where usage_date=v_today and reserved_at>v_header_at;
   v_remaining:=least(greatest(0,v_limit-v_used),greatest(0,coalesce(v_header_remaining,0)-v_after_header));
 else v_remaining:=greatest(0,v_limit-v_used); end if;
 v_elapsed:=greatest(0,least(86400,extract(epoch from(now()-v_day_start))));
 v_pace_fraction:=(v_policy.pacing_buffer_percent/100.0)+((1-v_policy.pacing_buffer_percent/100.0)*(v_elapsed/86400.0));
 v_allowed_so_far:=greatest(1,floor(v_limit*v_pace_fraction)::integer);
 select count(*) filter(where bucket='core')::integer,count(*) filter(where bucket='live')::integer,count(*) filter(where bucket='emergency')::integer into v_core,v_live,v_emergency from public.football_api_budget_reservations where usage_date=v_today;
 return jsonb_build_object('dailyLimit',v_limit,'limitSource',v_limit_source,'usedToday',v_used,'remaining',v_remaining,'allowedSoFar',v_allowed_so_far,
 'pacingBufferPercent',v_policy.pacing_buffer_percent,'minuteLimit',v_minute_limit,'minuteRemaining',v_minute_remaining,
 'buckets',jsonb_build_object('core',v_core,'live',v_live,'emergency',v_emergency),
 'bucketTargets',jsonb_build_object('core',floor(v_limit*v_policy.core_budget_percent/100.0)::integer,'live',floor(v_limit*v_policy.live_budget_percent/100.0)::integer,
 'emergency',greatest(0,v_limit-floor(v_limit*v_policy.core_budget_percent/100.0)::integer-floor(v_limit*v_policy.live_budget_percent/100.0)::integer)),
 'providerRemaining',v_header_remaining,'providerMinuteRemaining',v_minute_header_remaining,'providerHeaderAt',v_header_at,'providerMinuteHeaderAt',v_minute_header_at,'resetAt',v_day_start+interval '1 day',
 'warningAt',ceil(v_limit*v_policy.warning_percent/100.0)::integer,'criticalAt',ceil(v_limit*v_policy.critical_percent/100.0)::integer,
 'warningReached',v_used>=ceil(v_limit*v_policy.warning_percent/100.0)::integer,
 'criticalReached',v_used>=ceil(v_limit*v_policy.critical_percent/100.0)::integer,
 'secondaryFrozen',v_used>=60,'providerBlocked',coalesce(v_policy.provider_blocked,true));
end; $function$;

update public.football_api_budget_policy set daily_limit_override=70,core_budget_percent=57.14,live_budget_percent=28.57,emergency_budget_percent=14.29,warning_percent=50,critical_percent=85,provider_blocked=true,provider_blocked_at=coalesce(provider_blocked_at,now()),provider_block_reason=coalesce(provider_block_reason,'Provider remains suspended; outbound calls are disabled until explicit provider reactivation.'),pacing_buffer_percent=30,updated_at=now() where singleton=true;
