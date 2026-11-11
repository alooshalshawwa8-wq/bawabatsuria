
(function () {
  "use strict";
  const API_BASE = "https://elzquyehghuxhswogsch.supabase.co/functions/v1/football-data";
  const PUBLIC_KEY = "sb_publishable_dX9q10Gk28xV97-5TTAi_g_irG2G96D";
  const $ = (id) => document.getElementById(id);
  const state = { view: "live", date: damascusDate(), league: null, fixture: null, lastRequest: null };
  const views = [
    ["live","المباشر والمباريات"],["competitions","الدوريات والكؤوس"],["leaders","الهدافون والصناعة"],
    ["clubs","الأندية والملاعب"],["players","اللاعبون والكشاف"],["match","مركز المباراة"],
    ["predict","PREDICT"],["tactics","TAKTIK"],["dna","DNA الأندية"],["moments","MOMENTS"],
    ["passport","FAN PASSPORT"],["academy","الأكاديمية"],["derby","الديربيات"]
  ];
  function damascusDate() {
    return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Damascus",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }
  function arr(value) { return Array.isArray(value) ? value : []; }
  function content(html) { const box=$("football-content"); if(box) box.innerHTML=html; }
  function note(text) { const el=$("football-update-note"); if(el) el.textContent=text; }
  function status(text) { const el=$("football-provider-status"); if(el) el.textContent=text; }
  function empty(text) { return '<div class="football-empty">'+esc(text)+'</div>'; }
  function errorBox(text) { return '<div class="football-error">'+esc(text)+'</div>'; }
  function button(label,action,extra) { return '<button type="button" data-action="'+esc(action)+'" '+(extra||"")+'>'+esc(label)+'</button>'; }
  async function api(params) {
    const url = new URL(API_BASE);
    Object.entries(params).forEach(([k,v]) => { if(v !== undefined && v !== null && v !== "") url.searchParams.set(k,String(v)); });
    const response = await fetch(url.toString(), {method:"GET",headers:{apikey:PUBLIC_KEY,Accept:"application/json"}});
    const data = await response.json().catch(()=>({}));
    if (!response.ok) {
      if (data.code === "FOOTBALL_PROVIDER_SUSPENDED" || response.status === 503) {
        status("المزود متوقف مؤقتاً");
        throw new Error(data.error || "حساب API-Football معلّق مؤقتاً. أوقفنا الطلبات لحماية الحصة.");
      }
      throw new Error(data.error || "تعذر جلب البيانات حالياً.");
    }
    state.lastRequest = data;
    status(data.staleData ? "بيانات محفوظة قديمة" : (data.cached ? "من الذاكرة المؤقتة" : "تم جلب البيانات"));
    note(data.cached ? "البيانات من التخزين المؤقت — لا طلب جديد للمزود" : "آخر تحديث: "+new Date().toLocaleTimeString("ar-SY"));
    return data;
  }
  function logo(url,name) {
    return url ? '<img src="'+esc(url)+'" alt="'+esc(name||"")+'" loading="lazy" onerror="this.style.display=\'none\'">' : '<span class="football-logo">⚽</span>';
  }
  function matchCard(item) {
    const f=item.fixture||{}, t=item.teams||{}, l=item.league||{}, g=item.goals||{};
    const statusText=f.status?.short==="NS" ? new Date(f.date).toLocaleTimeString("ar-SY",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Damascus"}) : (f.status?.long||f.status?.short||"");
    return '<article class="football-card"><div class="football-match">'+
      '<div class="football-team">'+logo(t.home?.logo,t.home?.name)+'<span class="football-team-name">'+esc(t.home?.name||"الفريق المضيف")+'</span></div>'+
      '<div class="football-score">'+(g.home==null?"–":esc(g.home))+' : '+(g.away==null?"–":esc(g.away))+'</div>'+
      '<div class="football-team away"><span class="football-team-name">'+esc(t.away?.name||"الفريق الضيف")+'</span>'+logo(t.away?.logo,t.away?.name)+'</div></div>'+
      '<div class="football-match-meta"><span>'+esc(l.name||"")+' · '+esc(l.round||"")+'</span><span class="football-status">'+esc(statusText)+'</span></div>'+
      '<div style="margin-top:12px;text-align:left">'+button("تفاصيل المباراة","match-detail",'data-fixture="'+esc(f.id)+'"')+'</div></article>';
  }
  function setView(view) {
    state.view=view;
    document.querySelectorAll(".football-nav button").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
    loadView(view);
  }
  function renderHome() {
    content('<div class="football-section-heading"><h3>⚽ مركز المباريات</h3><div class="football-form" style="margin:0"><input id="football-date" class="football-date" type="date" value="'+esc(state.date)+'">'+button("مباريات هذا اليوم","load-date")+' '+button("المباريات المباشرة","load-live")+'</div></div><div id="football-results">'+empty("جارٍ تجهيز المباريات…")+'</div>');
    loadFixtures("date",state.date);
  }
  async function loadFixtures(mode,date) {
    const target=$("football-results"); if(target) target.innerHTML=empty("جارٍ تحميل المباريات…");
    try {
      const data=await api(mode==="live"?{action:"fixtures",mode:"live"}:{action:"fixtures",date:date||state.date});
      const rows=arr(data.response);
      if(target) target.innerHTML=rows.length?'<div class="football-grid">'+rows.map(matchCard).join("")+'</div>':empty(mode==="live"?"لا توجد مباريات مباشرة في هذه اللحظة. اختر مباريات اليوم لعرض الجدول.":"لا توجد مباريات مدرجة لهذا التاريخ.");
    } catch(e) { if(target) target.innerHTML=errorBox(e.message); }
  }
  function leagueSearchUI(title,desc) {
    content('<h3>'+esc(title)+'</h3><p>'+esc(desc||"ابحث عن البطولة ثم اختر الموسم لتفعيل الجداول والبيانات المرتبطة بها.")+'</p><form class="football-form" id="league-search-form"><input id="league-search" minlength="3" placeholder="اسم البطولة مثل Premier League أو دوري أبطال أوروبا" required><button type="submit">بحث عن بطولة</button></form><div id="league-results"></div>');
    $("league-search-form").addEventListener("submit",async e=>{
      e.preventDefault(); const term=$("league-search").value.trim(); const box=$("league-results"); box.innerHTML=empty("جارٍ البحث…");
      try {
        const data=await api({action:"leagues",search:term});
        const rows=arr(data.response);
        box.innerHTML=rows.length?'<div class="football-grid">'+rows.map(row=>{
          const l=row.league||{}, seasons=arr(row.seasons);
          const year=(seasons.find(s=>s.current)||seasons[seasons.length-1]||{}).year||"";
          return '<article class="football-card">'+
            '<div class="football-row-main">'+logo(l.logo,l.name)+'<div><div class="football-card-title">'+esc(l.name)+'</div><div class="football-muted">'+esc(row.country?.name||"")+' · '+esc(l.type||"")+'</div></div></div>'+
            '<div class="football-form"><select data-season="'+esc(l.id)+'">'+seasons.slice().reverse().map(s=>'<option value="'+esc(s.year)+'" '+(String(s.year)===String(year)?"selected":"")+'>'+esc(s.year)+(s.current?" · الحالي":"")+'</option>').join("")+'</select>'+button("اعتماد البطولة","choose-league",'data-league="'+esc(l.id)+'" data-name="'+esc(l.name)+'" data-logo="'+esc(l.logo||"")+'" data-country="'+esc(row.country?.name||"")+'"')+'</div></article>';
        }).join("")+'</div>':empty("لم نعثر على بطولة مطابقة. جرّب الاسم بالإنجليزية أو اكتب اسم الدولة.");
      } catch(err) { box.innerHTML=errorBox(err.message); }
    });
  }
  function chooseLeague(btn) {
    const select=document.querySelector('select[data-season="'+btn.dataset.league+'"]');
    state.league={id:btn.dataset.league,name:btn.dataset.name,logo:btn.dataset.logo,country:btn.dataset.country,season:select?.value||""};
    content('<div class="football-success">تم اختيار '+esc(state.league.name)+' — موسم '+esc(state.league.season)+'</div><div class="football-feature-grid" style="margin-top:14px">'+
      '<button class="football-feature" data-action="league-standings"><span>🏆</span><strong>جدول الترتيب</strong><small>النقاط والمراكز وفارق الأهداف</small></button>'+
      '<button class="football-feature" data-action="league-leaders"><span>🥇</span><strong>الهدافون والصناعة</strong><small>الأهداف والتمريرات الحاسمة والبطاقات</small></button>'+
      '<button class="football-feature" data-action="league-clubs"><span>🛡️</span><strong>الأندية والملاعب</strong><small>قائمة الفرق وملعب كل نادٍ</small></button>'+
      '<button class="football-feature" data-action="league-scout"><span>🔎</span><strong>كشاف المواهب</strong><small>تصفية اللاعبين حسب تقييم الموسم</small></button></div>');
  }
  async function loadStandings() {
    if(!state.league) return leagueSearchUI("جدول ترتيب الدوريات","اختر البطولة والموسم أولاً.");
    content('<h3>🏆 ترتيب '+esc(state.league.name)+'</h3><div id="football-table">'+empty("جارٍ تحميل الترتيب…")+'</div>');
    try {
      const data=await api({action:"standings",league:state.league.id,season:state.league.season});
      const groups=arr(data.response).flatMap(r=>arr(r.league?.standings));
      const rows=groups.flat();
      $("football-table").innerHTML=rows.length?'<div class="football-table-wrap"><table class="football-table"><thead><tr><th>#</th><th>النادي</th><th>لعب</th><th>فاز</th><th>تعادل</th><th>خسر</th><th>له</th><th>عليه</th><th>فارق</th><th>نقاط</th></tr></thead><tbody>'+
        rows.map(x=>'<tr><td>'+esc(x.rank)+'</td><td>'+logo(x.team?.logo,x.team?.name)+' '+esc(x.team?.name)+'</td><td>'+esc(x.all?.played)+'</td><td>'+esc(x.all?.win)+'</td><td>'+esc(x.all?.draw)+'</td><td>'+esc(x.all?.lose)+'</td><td>'+esc(x.all?.goals?.for)+'</td><td>'+esc(x.all?.goals?.against)+'</td><td>'+esc(x.goalsDiff)+'</td><td><strong>'+esc(x.points)+'</strong></td></tr>').join("")+'</tbody></table></div>':empty("بيانات الترتيب غير متاحة لهذه البطولة أو الموسم.");
    } catch(e){ $("football-table").innerHTML=errorBox(e.message); }
  }
  async function loadLeaders(type) {
    if(!state.league) return leagueSearchUI("الهدافون وصنّاع اللعب","اختر البطولة والموسم أولاً، ثم اختر نوع القائمة.");
    const names={scorers:"الهدافون",assists:"صنّاع الأهداف",yellow:"البطاقات الصفراء",red:"البطاقات الحمراء"};
    content('<div class="football-section-heading"><h3>🥇 '+esc(names[type]||"قائمة الإحصاءات")+' · '+esc(state.league.name)+'</h3><div class="football-form">'+
      button("الأهداف","leader-scorers")+' '+button("الصناعة","leader-assists")+' '+button("صفراء","leader-yellow")+' '+button("حمراء","leader-red")+'</div></div><div id="football-leaders">'+empty("جارٍ التحميل…")+'</div>');
    try{
      const data=await api({action:"leaders",league:state.league.id,season:state.league.season,type:type});
      const rows=arr(data.response);
      $("football-leaders").innerHTML=rows.length?'<div class="football-list">'+rows.map((r,i)=>{
        const p=r.player||{}, st=arr(r.statistics)[0]||{}, g=st.goals||{}, c=st.cards||{};
        const val=type==="scorers"?g.total:(type==="assists"?g.assists:(type==="yellow"?c.yellow:c.red));
        return '<div class="football-row"><div class="football-row-main">'+logo(p.photo,p.name)+'<div><strong>'+esc(i+1)+'. '+esc(p.name)+'</strong><div class="football-muted">'+esc(st.team?.name||"")+' · '+esc(st.games?.appearences||0)+' مشاركة</div></div></div><strong class="football-rating">'+esc(val??0)+'</strong></div>';
      }).join("")+'</div>':empty("لا توجد بيانات لهذه القائمة في الموسم المختار.");
    }catch(e){$("football-leaders").innerHTML=errorBox(e.message);}
  }
  async function loadClubs() {
    if(!state.league) return leagueSearchUI("الأندية والملاعب","اختر البطولة والموسم أولاً.");
    content('<h3>🛡️ أندية '+esc(state.league.name)+'</h3><div id="football-clubs">'+empty("جارٍ تحميل الأندية…")+'</div>');
    try{
      const data=await api({action:"teams",league:state.league.id,season:state.league.season});
      const rows=arr(data.response);
      $("football-clubs").innerHTML=rows.length?'<div class="football-grid">'+rows.map(r=>{
        const t=r.team||{},v=r.venue||{};
        return '<article class="football-card"><div class="football-row-main">'+logo(t.logo,t.name)+'<div><div class="football-card-title">'+esc(t.name)+'</div><div class="football-muted">'+esc(t.country||"")+'</div></div></div><p class="football-muted">🏟️ '+esc(v.name||"ملعب غير مسجل")+'<br>📍 '+esc(v.city||"")+' · السعة '+esc(v.capacity||"غير متاحة")+'</p>'+button("ملف النادي","team-detail",'data-team="'+esc(t.id)+'"')+'</article>';
      }).join("")+'</div>':empty("لا توجد قائمة أندية متاحة.");
    }catch(e){$("football-clubs").innerHTML=errorBox(e.message);}
  }
  async function loadTeam(teamId) {
    content('<h3>ملف النادي</h3><div id="football-team-detail">'+empty("جارٍ تحميل ملف النادي…")+'</div>');
    try{
      const data=await api({action:"team",id:teamId}); const row=arr(data.response)[0]||{},t=row.team||{},v=row.venue||{};
      $("football-team-detail").innerHTML='<article class="football-card"><div class="football-row-main">'+logo(t.logo,t.name)+'<div><h3>'+esc(t.name||"النادي")+'</h3><div class="football-muted">'+esc(t.country||"")+' · '+esc(t.founded||"")+'</div></div></div><div class="football-two-col"><div><strong>الملعب</strong><p class="football-muted">'+esc(v.name||"غير متاح")+'<br>'+esc(v.city||"")+'</p></div><div><strong>معلومات الملعب</strong><p class="football-muted">السعة: '+esc(v.capacity||"غير متاحة")+'<br>الأرضية: '+esc(v.surface||"غير متاحة")+'</p></div></div></article>';
    }catch(e){$("football-team-detail").innerHTML=errorBox(e.message);}
  }
  function playerSearchUI() {
    content('<h3>👤 اللاعبون وكشاف المواهب SCOUT</h3><p>ابحث باسم لاعب، أو استخدم كشاف الموسم بعد اختيار بطولة. تظهر التقييمات والإحصاءات التي يوفرها المزود فقط.</p><form id="player-search-form" class="football-form"><input id="player-search" minlength="3" placeholder="اسم اللاعب — 3 أحرف على الأقل" required><button>بحث عن لاعب</button></form><div class="football-form">'+button("كشاف البطولة المختارة","scout-load")+'</div><div id="football-players"></div>');
    $("player-search-form").addEventListener("submit",async e=>{
      e.preventDefault();const name=$("player-search").value.trim();const box=$("football-players");box.innerHTML=empty("جارٍ البحث…");
      try{const data=await api({action:"catalog",dataset:"players",search:name});renderPlayers(arr(data.response),box);}
      catch(err){box.innerHTML=errorBox(err.message);}
    });
  }
  function renderPlayers(rows,box) {
    box.innerHTML=rows.length?'<div class="football-grid">'+rows.map(r=>{
      const p=r.player||{},st=arr(r.statistics)[0]||{},g=st.goals||{},games=st.games||{};
      return '<article class="football-card"><div class="football-row-main">'+logo(p.photo,p.name)+'<div><div class="football-card-title">'+esc(p.name)+'</div><div class="football-muted">'+esc(p.nationality||"")+' · '+esc(games.position||"")+'</div></div></div><p class="football-muted">'+esc(st.team?.name||"")+'<br>المشاركات: '+esc(games.appearences||0)+' · الأهداف: '+esc(g.total||0)+' · الصناعة: '+esc(g.assists||0)+'</p><strong class="football-rating">التقييم: '+esc(games.rating||"غير متاح")+'</strong></article>';
    }).join("")+'</div>':empty("لم تتوفر نتائج لهذا اللاعب أو أن تغطية الموسم محدودة.");
  }
  async function loadScout() {
    if(!state.league) return leagueSearchUI("كشاف المواهب SCOUT","اختر البطولة والموسم أولاً.");
    content('<h3>🔎 كشاف المواهب · '+esc(state.league.name)+'</h3><div id="football-players">'+empty("جارٍ تحميل بيانات اللاعبين…")+'</div>');
    try{const data=await api({action:"catalog",dataset:"players",league:state.league.id,season:state.league.season,page:1});renderPlayers(arr(data.response),$("football-players"));}
    catch(e){$("football-players").innerHTML=errorBox(e.message);}
  }
  function idForm(title,desc,placeholder,actionLabel,action,pattern) {
    content('<h3>'+esc(title)+'</h3><p>'+esc(desc)+'</p><form id="football-id-form" class="football-form"><input id="football-id-input" inputmode="numeric" pattern="[0-9]+" placeholder="'+esc(placeholder)+'" required><button type="submit">'+esc(actionLabel)+'</button></form><div id="football-id-result"></div>');
    $("football-id-form").addEventListener("submit",e=>{e.preventDefault();const value=$("football-id-input").value.trim();if(pattern ? pattern.test(value) : /^\d+$/.test(value)) action(value);});
  }
  async function loadMatch(fixtureId,mode) {
    content('<h3>⚽ مركز المباراة · '+esc(fixtureId)+'</h3><div id="football-match-detail">'+empty("جارٍ تحميل التفاصيل…")+'</div>');
    try{
      const data=await api(mode==="studio"?{action:"studio",fixture:fixtureId}:{action:"match",fixture:fixtureId});
      const fixture=data.fixture||{},home=fixture.teams?.home||{},away=fixture.teams?.away||{};
      let html='<article class="football-card"><div class="football-match"><div class="football-team">'+logo(home.logo,home.name)+'<span class="football-team-name">'+esc(home.name)+'</span></div><div class="football-score">'+esc(fixture.goals?.home??"–")+' : '+esc(fixture.goals?.away??"–")+'</div><div class="football-team away"><span class="football-team-name">'+esc(away.name)+'</span>'+logo(away.logo,away.name)+'</div></div><div class="football-match-meta"><span>'+esc(fixture.league?.name||"")+'</span><span>'+esc(fixture.fixture?.status?.long||"")+'</span></div></article>';
      const events=arr(data.events);
      html+='<div class="football-two-col" style="margin-top:12px"><section class="football-card"><h3>⏱️ أحداث المباراة</h3>'+ (events.length?events.map(ev=>'<div class="football-event"><time>'+esc(ev.time?.elapsed??"")+'’</time><div><strong>'+esc(ev.type||"")+' · '+esc(ev.detail||"")+'</strong><div class="football-muted">'+esc(ev.player?.name||"")+' '+(ev.assist?.name?"— "+esc(ev.assist.name):"")+'</div></div></div>').join(""):empty("لا توجد أحداث متاحة أو لم تغطِّ البطولة هذه البيانات."))+'</section>';
      html+='<section class="football-card"><h3>📊 إحصاءات الفريقين</h3>'+renderStats(arr(data.statistics))+'</section></div>';
      html+='<div class="football-two-col" style="margin-top:12px">'+renderLineups(arr(data.lineups))+'</div>';
      html+='<section class="football-card" style="margin-top:12px"><h3>⭐ تقييمات اللاعبين</h3>'+renderPlayerRatings(arr(data.players))+'</section>';
      if(mode!=="studio") html+='<div style="margin-top:12px">'+button("فتح الاستوديو المتقدم (قد يستخدم طلبات إضافية)","studio-load",'data-fixture="'+esc(fixtureId)+'"')+'</div>';
      else html+='<p class="football-footnote">عدد الطلبات الفعلية لهذه العملية: '+esc(data.requestsMade??"غير متاح")+' · الأقسام غير المتاحة: '+esc(arr(data.unavailable).join("، ")||"لا يوجد")+'</p>';
      $("football-match-detail").innerHTML=html;
    }catch(e){$("football-match-detail").innerHTML=errorBox(e.message);}
  }
  function renderStats(rows) {
    if(!rows.length) return empty("الإحصاءات غير متاحة.");
    return rows.map(r=>'<div class="football-card-title">'+esc(r.team?.name||"")+'</div>'+arr(r.statistics).map(s=>'<div class="football-player"><span>'+esc(s.type)+'</span><strong>'+esc(s.value??"—")+'</strong></div>').join("")).join("");
  }
  function renderLineups(rows) {
    if(!rows.length) return '<section class="football-card">'+empty("التشكيلات غير متاحة لهذه المباراة.")+'</section>';
    return rows.map(r=>'<section class="football-lineup"><h4>'+esc(r.team?.name||"")+' · '+esc(r.formation||"")+'</h4><div class="football-muted">المدرب: '+esc(r.coach?.name||"غير متاح")+'</div>'+arr(r.startXI).map(p=>'<div class="football-player"><span>'+esc(p.player?.number||"")+' · '+esc(p.player?.name||"")+'</span><strong>'+esc(p.player?.pos||"")+'</strong></div>').join("")+'<div class="football-muted" style="margin-top:8px">البدلاء: '+esc(arr(r.substitutes).map(p=>p.player?.name).filter(Boolean).join("، ")||"غير متاح")+'</div></section>').join("");
  }
  function renderPlayerRatings(rows) {
    if(!rows.length) return empty("تقييمات اللاعبين غير متاحة.");
    return rows.map(team=>'<div class="football-card-title">'+esc(team.team?.name||"")+'</div>'+arr(team.players).map(item=>'<div class="football-player"><span>'+esc(item.player?.name||"")+'</span><strong class="football-rating">'+esc(arr(item.statistics)[0]?.games?.rating||"—")+'</strong></div>').join("")).join("");
  }
  async function loadPrediction(id) {
    content('<h3>🧠 PREDICT · قراءة مؤشرات المباراة</h3><div id="football-prediction">'+empty("جارٍ تحليل المؤشرات…")+'</div>');
    try{const data=await api({action:"catalog",dataset:"predictions",fixture:id});const row=arr(data.response)[0]||{};const p=row.predictions||{},c=row.comparison||{};
      $("football-prediction").innerHTML='<article class="football-card"><h3>'+esc(p.winner?.name||"الفائز غير محدد")+'</h3><p class="football-muted">'+esc(p.advice||"لا توجد نصيحة متاحة.")+'</p><div class="football-grid"><div class="football-card">الفوز: '+esc(p.winner?.comment||"—")+'</div><div class="football-card">الأهداف: '+esc(p.under_over||"—")+'</div><div class="football-card">ثقة: '+esc(p.percent?.home||"—")+' / '+esc(p.percent?.draw||"—")+' / '+esc(p.percent?.away||"—")+'</div></div><p class="football-footnote">هذه مؤشرات إحصائية من المزود وليست ضماناً للنتيجة أو نصيحة للمراهنة.</p></article>';
    }catch(e){$("football-prediction").innerHTML=errorBox(e.message);}
  }
  async function loadDNA(teamId) {
    if(!state.league) return leagueSearchUI("DNA الأندية","اختر البطولة والموسم أولاً ثم أدخل معرّف النادي.");
    content('<h3>🧬 DNA النادي · مؤشرات الأداء</h3><div id="football-dna">'+empty("جارٍ تحليل الإحصاءات…")+'</div>');
    try{const data=await api({action:"catalog",dataset:"team_stats",league:state.league.id,season:state.league.season,team:teamId});const row=arr(data.response)[0]||{},form=row.form||"—",fixtures=row.fixtures||{},goals=row.goals||{};
      $("football-dna").innerHTML='<article class="football-card"><h3>'+esc(row.team?.name||"النادي")+'</h3><p>الفورمة الأخيرة: <strong class="football-rating">'+esc(form)+'</strong></p><div class="football-grid"><div class="football-card">مباريات: '+esc(fixtures.played?.total??"—")+'</div><div class="football-card">انتصارات: '+esc(fixtures.wins?.total??"—")+'</div><div class="football-card">تعادلات: '+esc(fixtures.draws?.total??"—")+'</div><div class="football-card">خسارات: '+esc(fixtures.loses?.total??"—")+'</div><div class="football-card">أهداف مسجلة: '+esc(goals.for?.total??"—")+'</div><div class="football-card">أهداف مستقبلة: '+esc(goals.against?.total??"—")+'</div></div></article>';
    }catch(e){$("football-dna").innerHTML=errorBox(e.message);}
  }
  async function loadDerby(value) {
    const ids=value.split("-").map(x=>x.trim());if(ids.length!==2||!ids.every(x=>/^\d+$/.test(x)))return;
    content('<h3>🔥 سجل المواجهات المباشرة</h3><div id="football-derby">'+empty("جارٍ تحميل سجل المواجهات…")+'</div>');
    try{const data=await api({action:"catalog",dataset:"headtohead",h2h:ids.join("-"),last:10});const rows=arr(data.response);
      $("football-derby").innerHTML=rows.length?'<div class="football-grid">'+rows.map(matchCard).join("")+'</div>':empty("لا توجد مواجهات متاحة.");
    }catch(e){$("football-derby").innerHTML=errorBox(e.message);}
  }
  function showPassport() {
    const key="afaq_football_favorites";
    let favorites=[];try{favorites=JSON.parse(localStorage.getItem(key)||"[]");}catch(_){}
    content('<h3>🎟️ FAN PASSPORT · جواز المشجع</h3><p>احفظ أنديتك المفضلة على هذا الجهاز لمتابعتها بسرعة. هذه قائمة محلية ولا تتطلب حساباً.</p><form id="favorite-form" class="football-form"><input id="favorite-name" placeholder="اسم النادي"><input id="favorite-id" inputmode="numeric" placeholder="معرّف النادي من API-Football"><button>إضافة إلى جوازي</button></form><div id="favorite-list">'+(favorites.length?'<div class="football-list">'+favorites.map((f,i)=>'<div class="football-row"><strong>'+esc(f.name)+'</strong><span>'+button("فتح الملف","favorite-open",'data-team="'+esc(f.id)+'"')+' '+button("حذف","favorite-delete",'data-index="'+i+'"')+'</span></div>').join("")+'</div>':empty("لم تضف أندية بعد."))+'</div>');
    $("favorite-form").addEventListener("submit",e=>{e.preventDefault();const name=$("favorite-name").value.trim(),id=$("favorite-id").value.trim();if(!name||!/^\d+$/.test(id))return;favorites.push({name,id});localStorage.setItem(key,JSON.stringify(favorites));showPassport();});
  }
  function showAcademy() {
    content('<h3>🎓 أكاديمية أُفُق لكرة القدم</h3><p>محتوى تعليمي مبسط لقراءة المباراة وفهم الإحصاءات، دون ادعاء أنها بيانات مباشرة.</p><div class="football-grid">'+[
      ["قراءة التشكيل","كيف نفهم 4-3-3 و4-2-3-1 ومواقع اللاعبين؟"],
      ["إحصاءات المباراة","الاستحواذ والتسديدات والتمريرات والفرص الخطرة."],
      ["فهم التقييم","لماذا يتغير تقييم اللاعب وما الذي تعنيه الدقائق والمساهمات؟"],
      ["قواعد التحكيم","البطاقات والتسلل وركلات الجزاء وتقنية VAR."],
      ["تحليل المدرب","الضغط العالي والتحولات والبناء من الخلف."],
      ["كشاف المواهب","قراءة العمر والدقائق والتقييمات والمساهمات قبل الحكم على اللاعب."]
    ].map(x=>'<article class="football-card"><div class="football-card-title">'+esc(x[0])+'</div><p class="football-muted">'+esc(x[1])+'</p></article>').join("")+'</div>');
  }
  function renderFeatures() {
    content('<div class="football-feature-grid">'+[
      ["⚡","المباشر والمباريات","نتائج وجدول اليوم وتحديث يدوي","live"],
      ["🏆","الدوريات والكؤوس","بحث البطولة والمواسم والتغطية","competitions"],
      ["🥇","الهدافون والصناعة","أهداف وتمريرات حاسمة وبطاقات","leaders"],
      ["🛡️","الأندية والملاعب","الأندية والمدن وسعة الملاعب","clubs"],
      ["🔎","اللاعبون والكشاف","ملفات اللاعبين وتقييمات الموسم","players"],
      ["🎥","مركز المباراة","التشكيلات والأحداث والإحصاءات والتقييمات","match"],
      ["🧠","PREDICT","مؤشرات توقعات المزود دون ضمانات","predict"],
      ["📐","TAKTIK","قراءة التشكيل وخطط المدربين","tactics"],
      ["🧬","DNA الأندية","الفورمة والأداء الهجومي والدفاعي","dna"],
      ["✨","MOMENTS","أهداف وبطاقات وتبديلات وVAR","moments"],
      ["🎟️","FAN PASSPORT","أنديتك المفضلة على جهازك","passport"],
      ["🎓","الأكاديمية","دروس قراءة المباراة والإحصاءات","academy"],
      ["🔥","الديربيات","تاريخ المواجهات المباشرة","derby"]
    ].map(x=>'<button class="football-feature" data-view="'+x[3]+'"><span>'+x[0]+'</span><strong>'+x[1]+'</strong><small>'+x[2]+'</small></button>').join("")+'</div>');
  }
  function loadView(view) {
    if(view==="live") return renderHome();
    if(view==="competitions") return leagueSearchUI("🏆 الدوريات والكؤوس","ابحث عن أي بطولة أو كأس، ثم اختر الموسم المتاح وتصفح الترتيب والأندية والإحصاءات.");
    if(view==="leaders") return state.league?loadLeaders("scorers"):leagueSearchUI("🥇 الهدافون وصنّاع اللعب","اختر البطولة والموسم أولاً.");
    if(view==="clubs") return state.league?loadClubs():leagueSearchUI("🛡️ الأندية والملاعب","اختر البطولة والموسم لعرض الأندية وملاعبها.");
    if(view==="players") return playerSearchUI();
    if(view==="match") return idForm("🎥 مركز المباراة","أدخل رقم المباراة لعرض الأحداث والتشكيلات وإحصاءات الفريقين وتقييمات اللاعبين.","رقم المباراة fixture","فتح مركز المباراة",id=>loadMatch(id));
    if(view==="predict") return idForm("🧠 PREDICT","أدخل رقم المباراة لعرض المؤشرات والتوقعات المتاحة من المزود.","رقم المباراة fixture","تحليل المؤشرات",loadPrediction);
    if(view==="tactics") return idForm("📐 TAKTIK","أدخل رقم المباراة لعرض تشكيل المدربين والخطة الأساسية والبدلاء.","رقم المباراة fixture","عرض الخطط",id=>loadMatch(id));
    if(view==="dna") return state.league?idForm("🧬 DNA الأندية","أدخل معرّف النادي لتحليل فورمته وإحصاءاته ضمن البطولة المختارة.","معرّف النادي team","تحليل DNA",loadDNA):leagueSearchUI("🧬 DNA الأندية","اختر البطولة والموسم أولاً.");
    if(view==="moments") return idForm("✨ MOMENTS","أدخل رقم المباراة لاستخراج الأهداف والبطاقات والتبديلات وأحداث VAR المتاحة.","رقم المباراة fixture","عرض اللحظات",id=>loadMatch(id));
    if(view==="passport") return showPassport();
    if(view==="academy") return showAcademy();
    if(view==="derby") return idForm("🔥 الديربيات والمواجهات","أدخل معرّفي الفريقين بهذا الشكل: 33-40 لعرض آخر المواجهات.","homeID-awayID مثل 33-40","عرض المواجهات",loadDerby,/^\d+-\d+$/);
    renderFeatures();
  }
  function openFootballWorld() {
    const el=$("football-world");if(!el)return;el.hidden=false;document.body.style.overflow="hidden";
    if(!el.dataset.ready){el.dataset.ready="1";const nav=$("football-nav");nav.innerHTML=views.map(v=>'<button type="button" data-view="'+v[0]+'">'+v[1]+'</button>').join("");nav.addEventListener("click",e=>{const b=e.target.closest("[data-view]");if(b)setView(b.dataset.view);});$("football-content").addEventListener("click",handleActions);}
    setView(state.view);
  }
  function closeFootballWorld(){const el=$("football-world");if(el)el.hidden=true;document.body.style.overflow="";}
  async function handleActions(e) {
    const b=e.target.closest("[data-action]");if(!b)return;const a=b.dataset.action;
    if(a==="load-live")return loadFixtures("live");
    if(a==="load-date"){const d=$("football-date")?.value||state.date;state.date=d;return loadFixtures("date",d);}
    if(a==="match-detail")return loadMatch(b.dataset.fixture);
    if(a==="studio-load")return loadMatch(b.dataset.fixture,"studio");
    if(a==="choose-league")return chooseLeague(b);
    if(a==="league-standings")return loadStandings();
    if(a==="league-leaders")return loadLeaders("scorers");
    if(a==="league-clubs")return loadClubs();
    if(a==="league-scout")return loadScout();
    if(a==="leader-scorers")return loadLeaders("scorers");
    if(a==="leader-assists")return loadLeaders("assists");
    if(a==="leader-yellow")return loadLeaders("yellow");
    if(a==="leader-red")return loadLeaders("red");
    if(a==="team-detail"||a==="favorite-open")return loadTeam(b.dataset.team);
    if(a==="scout-load")return loadScout();
    if(a==="favorite-delete"){const key="afaq_football_favorites";let rows=[];try{rows=JSON.parse(localStorage.getItem(key)||"[]");}catch(_){}rows.splice(Number(b.dataset.index),1);localStorage.setItem(key,JSON.stringify(rows));return showPassport();}
  }
  window.openFootballWorld=openFootballWorld;
  window.closeFootballWorld=closeFootballWorld;
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&$("football-world")&&!$("football-world").hidden)closeFootballWorld();});
  document.addEventListener("DOMContentLoaded",()=>{
    const refresh=$("football-refresh");if(refresh)refresh.addEventListener("click",()=>loadView(state.view));
    const close=$("football-close");if(close)close.addEventListener("click",closeFootballWorld);
  });
})();
