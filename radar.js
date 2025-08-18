<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/satellite.js@5.0.2/dist/satellite.min.js"></script>
<script>
(() => {
  // ===== Config =====
  const USE_LOCAL_TLE = false; // 같은 폴더의 tle_merged.json 사용 시 true
  const ENABLE_DEMO_ON_FAIL = true; // 원격/로컬 모두 실패하면 데모 가동
  const TLE_SOURCES = USE_LOCAL_TLE ? null : {
    STARLINK: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json',
    WEATHER:  'https://celestrak.org/NORAD/elements/gp.php?GROUP=weather&FORMAT=json',
    ACTIVE:   'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json'
  };
  const LOCAL_SNAPSHOT = './tle_merged.json'; // 로컬 스냅샷 경로
  const FETCH_TIMEOUT_MS = 6000;

  const UPDATE_MS = 2500;
  const MAX_DRAW = 300;
  const DOT_RADIUS = 2.6;
  const TRAIL_MINUTES = 20;
  const TRAIL_STEP_MIN = 1;
  const EARTH_RADIUS_KM = 6371;

  const REGIONS = {
    "Korea":    { bounds: [[33.0,124.5],[38.9,131.2]], view:[36.3,127.9,6] },
    "Japan":    { bounds: [[30.0,129.0],[45.8,146.0]], view:[36.5,138.0,5] },
    "SE Asia":  { bounds: [[-11.0,95.0],[22.0,135.0]], view:[10.0,115.0,4] },
    "Europe":   { bounds: [[35.0,-10.0],[60.0,30.0]],  view:[50.0,10.0,4] },
    "US West":  { bounds: [[32.0,-125.0],[49.5,-112.0]], view:[39.0,-119.0,5] },
    "US East":  { bounds: [[25.0,-85.0],[47.5,-66.0]], view:[38.0,-79.0,5] },
    "Global":   { bounds: [[-85,-180],[85,180]], view:[20,0,2] },
  };
  const DEFAULT_REGION = "Korea";

  // ===== UI refs =====
  const regionList = document.getElementById('regionList');
  const toggleTrails = document.getElementById('toggleTrails');
  const toggleFoot   = document.getElementById('toggleFoot');
  const searchInput  = document.getElementById('satSearch');
  const datalistEl   = document.getElementById('satList');
  const statusBox    = document.getElementById('status');

  const groupFilters = { STARLINK:true, WEATHER:true, OTHER:true };
  document.querySelectorAll('#groupFilters input[type="checkbox"]').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      groupFilters[cb.dataset.group] = cb.checked;
      lastTick = 0;
    });
  });

  let currentRegion = DEFAULT_REGION;
  Object.keys(REGIONS).forEach(name => {
    const li = document.createElement('li');
    li.textContent = name;
    if (name === currentRegion) li.classList.add('active');
    li.addEventListener('click', () => selectRegion(name, li));
    regionList.appendChild(li);
  });

  // ===== Map init =====
  const map = L.map('map', { zoomControl:true, preferCanvas:true, worldCopyJump:false });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    { attribution:'', subdomains:'abcd', maxZoom:19 }).addTo(map);
  const drawLayer = L.layerGroup().addTo(map);
  let maskLayer = null, borderLayer = null;

  // ===== State =====
  let records = [];     // {id, name, group, satrec} 혹은 DEMO 레코드
  let nameIndex = [];   // [{name, id, group}]
  let lastTick = 0;
  let isDemo = false;

  const statsEl = {
    region: document.getElementById('stat-region'),
    count: document.getElementById('stat-count'),
    upd:   document.getElementById('stat-upd'),
  };
  const fmtTime = d => d.toLocaleTimeString([], { hour12:false });

  function setStatus(html){ statusBox.innerHTML = 'STATUS: ' + html; }

  function updateStats(shown=0){
    statsEl.region.textContent = currentRegion;
    statsEl.count.textContent = shown.toString();
    statsEl.upd.textContent = fmtTime(new Date());
  }

  function setMapView(viewArr){ map.setView([viewArr[0], viewArr[1]], viewArr[2], { animate:true }); }
  function setBoundsConstraint(bounds, enable){
    if (enable){ map.setMaxBounds(bounds); map.panInsideBounds(bounds, { animate:true }); }
    else { map.setMaxBounds(null); }
  }
  function applyRegionMask(regionKey){
    if (maskLayer) { map.removeLayer(maskLayer); maskLayer = null; }
    if (borderLayer){ map.removeLayer(borderLayer); borderLayer = null; }
    if (regionKey === 'Global') return;
    const b = REGIONS[regionKey].bounds;
    const south=b[0][0], west=b[0][1], north=b[1][0], east=b[1][1];
    const outer = [[90,-180],[90,180],[-90,180],[-90,-180]];
    const inner = [[south,west],[south,east],[north,east],[north,west]].reverse();
    maskLayer = L.polygon([outer, inner], { stroke:false, fillColor:'#000', fillOpacity:0.78, interactive:false }).addTo(map);
    borderLayer = L.rectangle([[south,west],[north,east]], { color:'#ff2b2b', weight:2, fill:false, opacity:0.9, dashArray:'6 6' }).addTo(map);
  }

  const inBounds = (lat, lon, regionKey) => {
    const b = REGIONS[regionKey].bounds;
    const south=b[0][0], west=b[0][1], north=b[1][0], east=b[1][1];
    if (lat < south || lat > north) return false;
    if (west <= east) return lon >= west && lon <= east;
    return (lon >= west && lon <= 180) || (lon >= -180 && lon <= east);
  };

  // ===== Satellite maths helpers =====
  function projectLatLon(rec, date){
    if (isDemo){
      // DEMO: 단순 타원 궤적 생성
      const t = date.getTime()/1000 + rec.phase;
      const lat = rec.baseLat + Math.sin(t/60)*rec.latAmp;
      let lon = rec.baseLon + Math.cos(t/45)*rec.lonAmp;
      if (lon>180) lon-=360; if (lon<-180) lon+=360;
      return { lat, lon, altKm: 550 };
    }
    const gmst = satellite.gstime(date);
    const pv = satellite.propagate(rec, date);
    if (!pv.position) return null;
    const gd = satellite.eciToGeodetic(pv.position, gmst);
    return {
      lat: satellite.degreesLat(gd.latitude),
      lon: satellite.degreesLong(gd.longitude),
      altKm: gd.height
    };
  }
  function footprintRadiusMeters(altKm){
    const central = Math.acos(6371 / (6371 + Math.max(0, altKm)));
    return 6371 * central * 1000;
  }

  // ===== Draw tick =====
  function drawTick(){
    if (!records.length) return;
    drawLayer.clearLayers();
    const now = new Date();
    let drawn = 0;
    const region = currentRegion;

    for (let i=0;i<records.length;i++){
      if (drawn >= MAX_DRAW) break;
      const r = records[i];
      if (!groupFilters[r.group]) continue;

      const curr = projectLatLon(r.satrec, now);
      if (!curr) continue;
      const {lat, lon, altKm} = curr;
      if (!inBounds(lat, lon, region)) continue;

      if (toggleTrails.checked){
        const pts = [];
        for (let t = TRAIL_MINUTES; t >= 1; t -= TRAIL_STEP_MIN){
          const d = new Date(now.getTime() - t*60000);
          const p = projectLatLon(r.satrec, d);
          if (p && inBounds(p.lat, p.lon, region)) pts.push([p.lat, p.lon]);
        }
        if (pts.length>=2){
          L.polyline(pts,{color:'rgba(255,43,43,0.55)',weight:1,opacity:0.9,interactive:false}).addTo(drawLayer);
        }
      }

      if (toggleFoot.checked){
        const radiusM = Math.min(footprintRadiusMeters(altKm), 3500000);
        L.circle([lat, lon], { radius: radiusM, color:'rgba(255,43,43,0.35)', weight:1, fill:false, opacity:0.7 }).addTo(drawLayer);
      }

      const m = L.circleMarker([lat, lon], {
        radius: DOT_RADIUS,
        renderer: map.options.preferCanvas ? map._renderer : undefined,
        color:'rgba(255,43,43,0.95)', weight:1, fillColor:'rgba(255,43,43,0.95)', fillOpacity:0.95
      }).addTo(drawLayer);

      const title = r.name || ('SAT-'+r.id);
      m.bindTooltip(`${title}<br><b>${r.group}</b><br>lat ${lat.toFixed(2)}, lon ${lon.toFixed(2)}<br>alt ${altKm.toFixed(1)} km`,
        {direction:'top',opacity:0.95,offset:[0,-4]});

      drawn++;
    }
    updateStats(drawn);
  }

  // ===== Scheduler =====
  function loop(ts){
    if (!lastTick || ts-lastTick >= UPDATE_MS){ lastTick = ts; drawTick(); }
    requestAnimationFrame(loop);
  }

  // ===== Region selection =====
  function selectRegion(name, liEl){
    document.querySelectorAll('.regions li').forEach(n => n.classList.remove('active'));
    if (liEl) liEl.classList.add('active');
    currentRegion = name;
    const {view, bounds} = REGIONS[name];
    setMapView(view);
    if (name === 'Global'){ setBoundsConstraint(null,false); applyRegionMask('Global'); }
    else { setBoundsConstraint(bounds,true); applyRegionMask(name); }
    lastTick = 0; updateStats();
  }

  // ===== Search =====
  function buildNameIndex() {
    nameIndex = records.map(r => ({ name: r.name || String(r.id), id: r.id, group: r.group }));
    nameIndex.sort((a,b)=> a.name.localeCompare(b.name));
    const frag = document.createDocumentFragment();
    const limit = Math.min(200, nameIndex.length);
    for (let i=0;i<limit;i++){ const opt = document.createElement('option'); opt.value = nameIndex[i].name; frag.appendChild(opt); }
    datalistEl.innerHTML = ''; datalistEl.appendChild(frag);
  }
  function findRecordByName(query){
    if (!query) return null;
    const q = query.toLowerCase().trim();
    let r = records.find(x => (x.name||'').toLowerCase() === q);
    if (r) return r;
    return records.find(x => (x.name||'').toLowerCase().includes(q));
  }
  function focusSatelliteByName(name){
    const rec = findRecordByName(name);
    if (!rec) return false;
    const pos = projectLatLon(rec.satrec, new Date());
    if (!pos) return false;
    if (!inBounds(pos.lat, pos.lon, currentRegion)){
      const globalLi = Array.from(document.querySelectorAll('.regions li')).find(li=>li.textContent==='Global');
      selectRegion('Global', globalLi);
    }
    map.flyTo([pos.lat, pos.lon], Math.max(map.getZoom(), 5), { animate:true, duration:0.8 });
    L.circleMarker([pos.lat, pos.lon], { radius:6, color:'#fff', weight:1, fillColor:'#fff', fillOpacity:0.6, opacity:0.9 }).addTo(drawLayer);
    return true;
  }
  searchInput.addEventListener('keydown', (e)=>{ if (e.key==='Enter'){ focusSatelliteByName(searchInput.value); } });
  searchInput.addEventListener('change', ()=>{ focusSatelliteByName(searchInput.value); });

  // ===== Fetch helpers =====
  function withTimeout(promise, ms){
    return Promise.race([
      promise,
      new Promise((_,rej)=> setTimeout(()=> rej(new Error('timeout')), ms))
    ]);
  }
  async function fetchJson(url){
    const res = await withTimeout(fetch(url, { cache:'no-store', mode:'cors' }), FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(res.status + ' ' + url);
    return res.json();
  }
  function normalizeList(list, groupTag){
    return list
      .filter(d => d.TLE_LINE1 && d.TLE_LINE2)
      .map(d => ({
        id: d.NORAD_CAT_ID || d.OBJECT_ID || '',
        name: d.OBJECT_NAME,
        group: groupTag,
        satrec: satellite.twoline2satrec(d.TLE_LINE1.trim(), d.TLE_LINE2.trim())
      }));
  }
  function dedupeById(list){
    const seen = new Map();
    for (const r of list){
      if (!r.id) continue;
      if (!seen.has(r.id)) seen.set(r.id, r);
      else {
        const prev = seen.get(r.id);
        const priority = {STARLINK:2, WEATHER:2, OTHER:1};
        if (priority[r.group] > priority[prev.group]) seen.set(r.id, r);
      }
    }
    return Array.from(seen.values());
  }

  // ===== DEMO generator =====
  function startDemo(){
    isDemo = true;
    setStatus('<b>DEMO MODE</b>: using synthetic tracks. <span class="err">(TLE fetch failed)</span>');
    // 지역에 상관없이 120개 가짜 위성 생성
    const demo = [];
    for (let i=0;i<120;i++){
      demo.push({
        id: 'D'+i, name: 'DEMO-'+(i+1),
        group: (i%3===0 ? 'STARLINK' : i%3===1 ? 'WEATHER' : 'OTHER'),
        satrec: { /* dummy carrier for demo */ },
        // demo params
        phase: Math.random()*1000,
        baseLat: (Math.random()*140)-70,  // -70..70
        baseLon: (Math.random()*360)-180,
        latAmp:  10+Math.random()*30,
        lonAmp:  15+Math.random()*60
      });
    }
    records = demo;
    buildNameIndex();
    requestAnimationFrame(loop);
  }

  // ===== Load TLE (remote -> local snapshot -> demo) =====
  async function loadAllTLE(){
    try{
      setStatus('Fetching TLE from <b>CelesTrak</b>…');
      if (!USE_LOCAL_TLE){
        const [star, weather, active] = await Promise.all([
          fetchJson(TLE_SOURCES.STARLINK),
          fetchJson(TLE_SOURCES.WEATHER),
          fetchJson(TLE_SOURCES.ACTIVE)
        ]);
        const a = normalizeList(star,    'STARLINK');
        const b = normalizeList(weather, 'WEATHER');
        const c = normalizeList(active,  'OTHER');
        const merged = dedupeById([...a, ...b, ...c]);
        records = merged;
        setStatus(`Loaded <b>${records.length}</b> satellites from CelesTrak.`);
      } else {
        setStatus('Loading local snapshot <b>tle_merged.json</b>…');
        const local = await fetchJson(LOCAL_SNAPSHOT);
        const merged = local
          .filter(d => d.TLE_LINE1 && d.TLE_LINE2)
          .map(d => ({
            id: d.NORAD_CAT_ID || d.OBJECT_ID || '',
            name: d.OBJECT_NAME,
            group: d.group || 'OTHER',
            satrec: satellite.twoline2satrec(d.TLE_LINE1.trim(), d.TLE_LINE2.trim())
          }));
        records = dedupeById(merged);
        setStatus(`Loaded <b>${records.length}</b> satellites from local snapshot.`);
      }
      if (!records.length) throw new Error('empty dataset');
      buildNameIndex();
      requestAnimationFrame(loop);
    } catch(err){
      console.error(err);
      setStatus(`<span class="err">ERROR:</span> ${err.message}<br/>` +
        `• 네트워크/방화벽/CORS로 CelesTrak 접근이 막혔을 수 있어요.<br/>` +
        `• 아래 안내에 따라 <b>로컬 스냅샷</b>을 쓰거나, 임시로 <b>DEMO</b>로 실행합니다.`);
      if (ENABLE_DEMO_ON_FAIL) startDemo();
    }
  }

  // ===== init =====
  (function init(){
    setMapView(REGIONS[currentRegion].view);
    setBoundsConstraint(REGIONS[currentRegion].bounds, true);
    applyRegionMask(currentRegion);
    updateStats(0);
  })();

  loadAllTLE();
})();
</script>
