const DB_NAME='op-trainer-db';
const DB_VERSION=1;
const STORE_Q='questions',STORE_H='history',STORE_M='meta';
let db;
let state={view:'home',questions:[],xxiiQuestions:[],history:[],favorites:new Set(),session:null,examTimer:null,importStats:null,officialLoading:false,officialProgress:null,rawOfficialCount:0,keyPdfCount:0,officialLoadError:null,stageMode:null};

function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{const d=r.result;if(!d.objectStoreNames.contains(STORE_Q))d.createObjectStore(STORE_Q,{keyPath:'id'});if(!d.objectStoreNames.contains(STORE_H))d.createObjectStore(STORE_H,{keyPath:'id',autoIncrement:true});if(!d.objectStoreNames.contains(STORE_M))d.createObjectStore(STORE_M,{keyPath:'key'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function tx(store,mode='readonly'){return db.transaction(store,mode).objectStore(store)}
function getAll(store){return new Promise((res,rej)=>{const r=tx(store).getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)})}
function put(store,val){return new Promise((res,rej)=>{const r=tx(store,'readwrite').put(val);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function del(store,key){return new Promise((res,rej)=>{const r=tx(store,'readwrite').delete(key);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function add(store,val){return new Promise((res,rej)=>{const r=tx(store,'readwrite').add(val);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function clearStore(store){return new Promise((res,rej)=>{const r=tx(store,'readwrite').clear();r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
async function getMeta(key,def){return new Promise(res=>{const r=tx(STORE_M).get(key);r.onsuccess=()=>res(r.result?r.result.value:def);r.onerror=()=>res(def)})}
async function setMeta(key,value){return put(STORE_M,{key,value})}

const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const uniq=a=>[...new Set(a)];
const shuffle=a=>a.map(v=>[Math.random(),v]).sort((x,y)=>x[0]-y[0]).map(x=>x[1]);
const pct=(a,b)=>b?Math.round(a/b*100):0;
const allQuestions=()=>state.questions;
const isOfficialQuestion=q=>String(q?.id||'').startsWith('op-');
const officialQuestions=()=>state.questions.filter(isOfficialQuestion);
const primaryQuestions=()=>officialQuestions().length?officialQuestions():state.questions;
const STAGE_MODES={school:{label:'Szkolna',key:'school'},district:{label:'Okręgowa',key:'district'},central:{label:'Centralna',key:'central'}};
function stageKey(v){const n=topicNorm(v);if(n.includes('szkol'))return'school';if(n.includes('okreg'))return'district';if(n.includes('central'))return'central';return'';}
function questionsForStage(key){return officialQuestions().filter(q=>stageKey(q.stage)===key);}
const isIOS=()=>/iPad|iPhone|iPod/.test(navigator.userAgent)||(/Macintosh/.test(navigator.userAgent)&&navigator.maxTouchPoints>1);
const isStandalone=()=>window.matchMedia?.('(display-mode: standalone)').matches||navigator.standalone===true;

// XXII OP: deterministic archive filter. No AI and no generated questions.
// The official scope is: building/operation of project teams, team engagement,
// and managing project challenges. We search the already imported official archive.
const XXII_RULES=[
  {id:'team',label:'Budowanie i funkcjonowanie zespołu',terms:[
    'zespol','zespolow','przywod','lider','kierownik','styl kierowania','style kierowania',
    'delegow','belbin','rola zespol','role zespol','grupa roboc','praca grup','praca zespol',
    'konflikt','komunikacj','wspolprac','koordynacj','relacje w zespole'
  ]},
  {id:'engagement',label:'Zaangażowanie zespołu',terms:[
    'zaangaz','motywac','motywow','satysfakc','partycyp','empower','autonom','nagradz',
    'system motywacyj','teoria x','teoria y','maslow','herzberg','mcclelland','ocena pracown',
    'identyfikacj z organizac','lojalnosc pracown','rotacja pracown'
  ]},
  {id:'challenges',label:'Zarządzanie wyzwaniami projektowymi',terms:[
    'projekt','projektow','harmonogram','kamien milow','sciezka krytycz','pert','cpm','gantt',
    'scrum','agile','interesarius','ryzyko projekt','zakres projektu','budzet projektu',
    'zarzadzanie zmiana','zarzadzanie zmian','opoznienie projektu','zasoby projektu','cykl zycia projektu'
  ]}
];
function topicNorm(v){return String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}
function xxiiText(q){return topicNorm([q.question,q.comment,...Object.values(q.answers||{})].join(' '));}
function classifyXXII(q){
  if(!isOfficialQuestion(q))return null;
  const text=xxiiText(q),matches=[];
  for(const rule of XXII_RULES){
    const hit=rule.terms.filter(t=>text.includes(t));
    if(hit.length)matches.push({id:rule.id,label:rule.label,terms:hit});
  }
  if(!matches.length)return null;
  // Prefer the group with the most matching signals; project-specific signals win ties.
  matches.sort((a,b)=>b.terms.length-a.terms.length||(a.id==='challenges'?-1:1));
  return {primary:matches[0],all:matches};
}
function refreshXXIIQuestions(){
  state.xxiiQuestions=officialQuestions().map(q=>{
    const m=classifyXXII(q); if(!m)return null;
    return {...q,themeCategory:m.primary.label,themeMatches:m.all.map(x=>x.label)};
  }).filter(Boolean);
}

async function tryLoadBundledQuestions(){
  try{
    const r=await fetch('./op-data.json',{cache:'no-store'});
    if(!r.ok)return 0;
    const data=await r.json();
    const arr=Array.isArray(data)?data:(Array.isArray(data?.questions)?data.questions:[]);
    if(!arr.length)return 0;
    validateQuestions(arr);
    for(const q of state.questions.filter(q=>isOfficialQuestion(q)||String(q.id||'').startsWith('demo-')))await del(STORE_Q,q.id);
    for(const q of arr)await put(STORE_Q,q);
    state.questions=await getAll(STORE_Q);
    state.rawOfficialCount=arr.filter(isOfficialQuestion).length;
    await setMeta('bundledImportCount',arr.length);
    return arr.length;
  }catch(e){console.warn('Nie udało się wczytać op-data.json',e);return 0;}
}

async function tryLoadOfficialData(force=false,onProgress=null){
  try{
    state.officialLoadError=null;
    const r=await fetch('./op-raw.json',{cache:'no-store'});
    if(!r.ok){if(r.status!==404)state.officialLoadError=`Nie mogę odczytać op-raw.json (HTTP ${r.status}).`;return 0;}
    const rawJson=await r.json();
    const raw=Array.isArray(rawJson)?rawJson:(rawJson&&typeof rawJson==='object'?[rawJson]:[]);
    state.rawOfficialCount=raw.length;
    if(!raw.length){state.officialLoadError='op-raw.json jest pusty albo ma nieprawidłowy format.';return 0;}
    let keyIndex=[];
    try{
      const kr=await fetch('./key-index.json',{cache:'no-store'});
      if(kr.ok){const ki=await kr.json();keyIndex=Array.isArray(ki)?ki:(ki&&typeof ki==='object'?[ki]:[]);}
    }catch(e){console.warn('Nie udało się wczytać key-index.json',e)}
    state.keyPdfCount=keyIndex.length;
    if(onProgress)onProgress({done:0,total:keyIndex.length,label:`Wczytano ${raw.length} pytań surowych i ${keyIndex.length} arkuszy PDF. Rozpoznaję klucze...`});
    const fingerprint=`v162|${raw.length}|${keyIndex.length}`;
    const prev=await getMeta('officialFingerprint','');
    const currentOfficial=state.questions.filter(q=>String(q.id||'').startsWith('op-')).length;
    if(!force&&prev===fingerprint&&currentOfficial>0)return currentOfficial;
    const resolver=await import('./key-resolver.mjs');
    const {questions,stats}=await resolver.resolveOfficialKeys(raw,onProgress);
    validateQuestions(questions);
    if(!questions.length)return 0;
    for(const q of state.questions.filter(q=>String(q.id||'').startsWith('op-')||String(q.id||'').startsWith('demo-')))await del(STORE_Q,q.id);
    for(const q of questions)await put(STORE_Q,q);
    state.questions=await getAll(STORE_Q);
    refreshXXIIQuestions();
    await setMeta('officialFingerprint',fingerprint);
    await setMeta('officialImportStats',stats);
    state.importStats=stats;
    await setMeta('officialImportCount',questions.length);
    return questions.length;
  }catch(e){state.officialLoadError=`Błąd ładowania bazy: ${e?.message||e}`;console.warn('Import OP nie udal sie',e);return 0;}
}
async function init(){
  db=await openDB();state.questions=await getAll(STORE_Q);state.history=await getAll(STORE_H);state.favorites=new Set(await getMeta('favorites',[]));state.importStats=await getMeta('officialImportStats',null);
  let bundled=0;
  if(!officialQuestions().length)bundled=await tryLoadBundledQuestions();
  if(!state.questions.length){const demo=await fetch('demo-data.json').then(r=>r.json());for(const q of demo)await put(STORE_Q,q);state.questions=demo;}
  refreshXXIIQuestions();
  if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).catch(()=>{});
  $('#file-import').addEventListener('change',importQuestionsFile);
  render();
  if(!bundled&&!officialQuestions().length)syncOfficialDataInBackground();
}

async function syncOfficialDataInBackground(force=false){
  if(state.officialLoading)return;
  state.officialLoading=true;state.officialProgress={done:0,total:0,label:'Sprawdzanie bazy OP...'};render();
  let lastPaint=0;
  const onProgress=p=>{
    state.officialProgress=p;
    const now=Date.now();
    if(now-lastPaint>180){lastPaint=now;render();}
  };
  const officialCount=await tryLoadOfficialData(force,onProgress);
  state.officialLoading=false;state.officialProgress=null;
  state.questions=await getAll(STORE_Q);state.importStats=await getMeta('officialImportStats',state.importStats);refreshXXIIQuestions();
  render();
  if(officialCount) console.log(`Załadowano ${officialCount} pytań OP z oficjalnych arkuszy.`);
}

function nav(active){return `<nav class="nav"><button data-nav="home" class="${active==='home'?'active':''}">Start</button><button data-nav="learn" class="${active==='learn'?'active':''}">Nauka</button><button data-nav="xxii" class="${active==='xxii'?'active':''}">XXII</button><button data-nav="stats" class="${active==='stats'?'active':''}">Statystyki</button><button data-nav="settings" class="${active==='settings'?'active':''}">Dane</button></nav>`}
function shell(content,active=state.view){const ready=officialQuestions().length;const raw=state.rawOfficialCount||ready;const load=state.officialLoading?`<div class="syncbar"><div class="syncrow"><strong>Analiza oficjalnych kluczy OP</strong><span>${state.officialProgress?.done||0}/${state.officialProgress?.total??state.keyPdfCount??'?'} PDF</span></div><div class="bar"><span style="width:${state.officialProgress?.total?Math.round((state.officialProgress.done/state.officialProgress.total)*100):4}%"></span></div><div class="sub">${esc(state.officialProgress?.label||'Przetwarzanie w tle...')} — gotowe pytania pojawią się po dopasowaniu kluczy.</div></div>`:'';const err=state.officialLoadError?`<div class="notice"><strong>Błąd bazy OP:</strong> ${esc(state.officialLoadError)}</div>`:'';return `<div class="shell"><div class="topbar"><div><div class="brand">OP Trainer <span class="version">v1.7</span></div><div class="sub">prywatna PWA • offline • bez AI</div></div><span class="badge">${ready} gotowych / ${raw} surowych • ${state.xxiiQuestions.length} pod XXII</span></div>${load}${err}${content}</div>${nav(active)}`}
function render(){
  if(state.view==='home')renderHome();else if(state.view==='learn')renderLearnSetup();else if(state.view==='xxii')renderXXII();else if(state.view==='stats')renderStats();else if(state.view==='settings')renderSettings();else if(state.view==='stage')renderStageMode();else if(state.view==='session')renderSession();else if(state.view==='summary')renderSummary();
  document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{stopExamTimer();state.view=b.dataset.nav;state.session=null;render()});
}

function iosInstallNotice(){return isIOS()&&!isStandalone()?`<div class="notice ios-notice"><strong>iPhone/iPad:</strong> ta wersja jest już PWA. Po opublikowaniu jej przez HTTPS w Safari wybierz <strong>Udostępnij → Dodaj do ekranu początkowego</strong>. Otworzy się później jak osobna aplikacja.</div>`:'';}
function renderHome(){const due=countDue(),wrongIds=getWrongIds();$('#app').innerHTML=shell(`<div class="stack">
<div class="notice">Po uruchomieniu POBIERZ-PYTANIA-WINDOWS.bat aplikacja pobiera pytania i komentarze z bazy OP oraz dopasowuje prawidłowe odpowiedzi z oficjalnych arkuszy PDF z kluczem.</div>
${!officialQuestions().length?(state.rawOfficialCount?`<div class="notice"><strong>Baza znaleziona:</strong> wykryto ${state.rawOfficialCount} surowych pytań OP i ${state.keyPdfCount} arkuszy PDF. Trwa dopasowywanie oficjalnych kluczy; po zakończeniu pojawią się pytania gotowe do rozwiązywania.</div>`:`<div class="notice"><strong>Tryb demo:</strong> nie ma jeszcze załadowanych oficjalnych pytań OP. Pełna symulacja będzie dostępna po przeniesieniu/pobraniu bazy i zakończeniu analizy kluczy.</div>`):''}
${iosInstallNotice()}
<div class="stats-grid"><div class="card"><div class="kpi">${state.history.length}</div><div class="kpi-label">odpowiedzi</div></div><div class="card"><div class="kpi">${overallAccuracy()}%</div><div class="kpi-label">skuteczność</div></div><div class="card"><div class="kpi">${due}</div><div class="kpi-label">do powtórki</div></div></div>
<div class="grid">
${tile('XXII: Przywództwo w projektach',`${state.xxiiQuestions.length} archiwalnych pytań OP pasujących do aktualnego hasła.`,'xxii')}
${tile('Ucz się adaptacyjnie','Błędy, słabe działy i zaległe powtórki.','adaptive')}
${tile('Losowy trening','Filtry: etap, edycja i kategoria.','learn')}
${tile('Tryb szkolny','Tylko archiwalne pytania z eliminacji szkolnych.','stage:school')}
${tile('Tryb okręgowy','Tylko archiwalne pytania z eliminacji okręgowych.','stage:district')}
${tile('Tryb centralny','Tylko archiwalne pytania z eliminacji centralnych.','stage:central')}
${tile('Tryb połowy OP','20 pytań: 10 × 1 pkt + 10 × 2 pkt. Maks. 30 pkt.','half')}
${tile('Pełna symulacja OP','50 pytań: 25 łatwiejszych + 25 trudniejszych. Maks. 75 pkt. Wynik ukryty do końca.','official')}
${tile('Powtórz błędy',`${wrongIds.size} pytań wymagających poprawy.`,'mistakes')}
${tile('Powtórki dziś',`${due} pytań zaplanowanych.`,'due')}
${tile('Własna symulacja','Dowolna liczba pytań i czas.','exam')}
${tile('Ulubione',`${state.favorites.size} zapisanych pytań.`,'favorites')}
</div></div>`);document.querySelectorAll('[data-action]').forEach(el=>el.onclick=()=>quickAction(el.dataset.action));}
function tile(title,desc,action){return `<div class="card tile" data-action="${action}"><div><h3>${title}</h3><p>${desc}</p></div><span class="badge">Otwórz →</span></div>`}

function renderLearnSetup(){const base=primaryQuestions(),ed=uniq(base.map(q=>q.edition)).sort(),st=uniq(base.map(q=>q.stage)).sort(),cat=uniq(base.map(q=>q.category)).sort();$('#app').innerHTML=shell(`<div class="card stack"><h2 style="margin:0">Trening</h2><div class="filters">${selectField('Edycja','f-edition',['Wszystkie',...ed])}${selectField('Etap','f-stage',['Wszystkie',...st])}${selectField('Kategoria','f-category',['Wszystkie',...cat])}</div><div class="field"><label>Liczba pytań</label><input id="f-count" type="number" min="1" max="200" value="20"></div><div class="row"><button class="btn blue" id="start-learn">Start</button><button class="btn secondary" id="start-adaptive">Adaptacyjnie</button></div></div>`,'learn');$('#start-learn').onclick=()=>startFiltered(false);$('#start-adaptive').onclick=()=>startAdaptive(20);}
function selectField(label,id,vals){return `<div class="field"><label>${label}</label><select id="${id}">${vals.map(v=>`<option>${esc(v)}</option>`).join('')}</select></div>`}
function filterQuestions(){const e=$('#f-edition').value,s=$('#f-stage').value,c=$('#f-category').value;return primaryQuestions().filter(q=>(e==='Wszystkie'||q.edition===e)&&(s==='Wszystkie'||q.stage===s)&&(c==='Wszystkie'||q.category===c));}
function startFiltered(exam){const pool=shuffle(filterQuestions()),n=Math.min(parseInt($('#f-count').value||20),pool.length);startSession(pool.slice(0,n),exam?'exam':'learn',exam);}

function quickAction(a){
 if(a.startsWith('stage:')){state.stageMode=a.slice(6);state.view='stage';render();return}
 if(a==='learn'){state.view='learn';render();return} if(a==='xxii'){state.view='xxii';render();return} if(a==='adaptive'){startAdaptive(20);return}
 if(a==='half'){startOfficialMode(10,10,'half');return} if(a==='official'){startOfficialMode(25,25,'official');return}
 if(a==='mistakes'){const ids=getWrongIds();startSession(shuffle(allQuestions().filter(q=>ids.has(q.id))),'mistakes',false);return}
 if(a==='due'){const now=Date.now();startSession(shuffle(allQuestions().filter(q=>getSR(q.id).due<=now)),'due',false);return}
 if(a==='favorites'){startSession(shuffle(allQuestions().filter(q=>state.favorites.has(q.id))),'favorites',false);return}
 if(a==='exam'){startExamSetup();return}
}

function renderStageMode(){
 const cfg=STAGE_MODES[state.stageMode]||STAGE_MODES.school;
 const pool=questionsForStage(cfg.key);
 const parts=splitByDifficulty(pool);
 const editions=uniq(pool.map(q=>q.edition)).sort();
 const loading=state.officialLoading?'<div class="notice"><strong>Baza OP jest jeszcze analizowana.</strong> Liczby mogą się jeszcze zwiększyć po rozpoznaniu kolejnych kluczy.</div>':'';
 const noData=!pool.length&&!state.officialLoading?'<div class="notice"><strong>Brak gotowych pytań dla tego etapu.</strong> Wejdź w Dane i sprawdź wynik analizy kluczy PDF.</div>':'';
 $('#app').innerHTML=shell(`<div class="stack">
 <div class="card xxii-hero"><div class="eyebrow">TRYB ETAPOWY</div><h2>${cfg.label}</h2><p>Wyłącznie archiwalne pytania OP z eliminacji ${cfg.label.toLowerCase().replace('okręgowa','okręgowych').replace('szkolna','szkolnych').replace('centralna','centralnych')}.</p><div class="meta"><span>${pool.length} pytań</span><span>${parts.easy.length} × 1 pkt</span><span>${parts.hard.length} × 2 pkt</span></div></div>
 ${loading}${noData}
 <div class="card stack"><div class="filters">${selectField('Edycja','stage-edition',['Wszystkie',...editions])}</div>
 <div class="grid">
 ${tile('Trening 20','20 losowych pytań z wybranego etapu. Odpowiedź i komentarz po każdym pytaniu.','stage-train')}
 ${tile('Połowa 20','10 pytań za 1 pkt + 10 za 2 pkt. Bieżący wynik widoczny.','stage-half')}
 ${tile('Pełny test 50','25 pytań za 1 pkt + 25 za 2 pkt. Wynik ukryty do końca.','stage-full')}
 ${tile('Wszystkie pytania','Przejdź cały dostępny bank dla wybranego etapu i edycji.','stage-all')}
 </div></div></div>`,'home');
 document.querySelectorAll('[data-action]').forEach(el=>el.onclick=()=>stageAction(el.dataset.action));
}
function selectedStagePool(){
 const cfg=STAGE_MODES[state.stageMode]||STAGE_MODES.school;
 const edition=$('#stage-edition')?.value||'Wszystkie';
 return questionsForStage(cfg.key).filter(q=>edition==='Wszystkie'||q.edition===edition);
}
function stageAction(a){
 if(state.officialLoading){alert('Baza OP jest jeszcze analizowana. Możesz zaczekać do końca analizy, żeby zestaw był pełniejszy.');}
 const pool=selectedStagePool();
 if(!pool.length){alert('Brak pytań dla wybranego etapu/edycji.');return}
 if(a==='stage-train'){startSession(shuffle(pool).slice(0,Math.min(20,pool.length)),`stage-${state.stageMode}-train`,false);return}
 if(a==='stage-all'){startSession(shuffle(pool),`stage-${state.stageMode}-all`,false);return}
 const p=splitByDifficulty(pool);
 if(a==='stage-half'){
   if(p.easy.length<10||p.hard.length<10){alert(`Do połowy potrzeba 10 pytań łatwiejszych i 10 trudniejszych. Dla tego wyboru masz ${p.easy.length} łatwiejszych i ${p.hard.length} trudniejszych.`);return}
   const list=[...shuffle(p.easy).slice(0,10),...shuffle(p.hard).slice(0,10)];
   startSession(shuffle(list),`stage-${state.stageMode}-half`,true,30,true);return
 }
 if(a==='stage-full'){
   if(p.easy.length<25||p.hard.length<25){alert(`Do pełnego testu potrzeba 25 pytań łatwiejszych i 25 trudniejszych. Dla tego wyboru masz ${p.easy.length} łatwiejszych i ${p.hard.length} trudniejszych.`);return}
   const list=[...shuffle(p.easy).slice(0,25),...shuffle(p.hard).slice(0,25)];
   startSession(shuffle(list),'official',true,60,true);return
 }
}

function renderXXII(){
 const groups=XXII_RULES.map(r=>r.label);
 const officialCount=officialQuestions().length;
 const parts=splitByDifficulty(state.xxiiQuestions);
 const loading=state.officialLoading?'<div class="notice"><strong>Baza OP jest jeszcze analizowana.</strong> Lista pytań XXII będzie się uzupełniać automatycznie wraz z odczytywaniem kluczy.</div>':'';
 const noData=!officialCount?'<div class="notice"><strong>Brak załadowanej oficjalnej bazy OP.</strong> Uruchom POBIERZ-PYTANIA-WINDOWS.bat albo przenieś dane z poprzedniej wersji. Ta zakładka nie używa pytań demo.</div>':'';
 $('#app').innerHTML=shell(`<div class="stack">
 <div class="card xxii-hero"><div class="eyebrow">XXII OLIMPIADA PRZEDSIĘBIORCZOŚCI — BiZ</div><h2>Przywództwo w projektach</h2><p>Ta zakładka zawiera <strong>wyłącznie archiwalne pytania z oficjalnej bazy OP</strong>, które tematycznie pasują do zakresu XXII edycji. Nie ma tu pytań generowanych ani przewidywanych.</p><div class="meta"><span>${state.xxiiQuestions.length} pytań archiwalnych</span><span>${parts.easy.length} × 1 pkt</span><span>${parts.hard.length} × 2 pkt</span></div><a class="source-link" href="https://www.olimpiada.edu.pl/aktualnosci/index/id/472" target="_blank" rel="noopener">Oficjalne ogłoszenie hasła ↗</a></div>
 ${loading}${noData}
 <div class="grid">
 ${groups.map(c=>tile(c,`${state.xxiiQuestions.filter(q=>q.themeCategory===c).length} pytań z archiwum`, `xxii-cat:${c}`)).join('')}
 ${tile('Losowy trening XXII',`${Math.min(20,state.xxiiQuestions.length)} pytań z całego dopasowanego archiwum.`,'xxii-random')}
 ${tile('Test XXII — połowa','Do 20 pytań z dopasowanego archiwum, z podziałem 1/2 pkt.','xxii-half')}
 ${tile('Wszystkie pasujące pytania',`Przejdź wszystkie ${state.xxiiQuestions.length} znalezionych pytań.`,'xxii-all')}
 </div>
 <div class="notice"><strong>Zakres oficjalny:</strong> budowanie i funkcjonowanie zespołu projektowego • zaangażowanie zespołu projektowego • zarządzanie wyzwaniami projektowymi. Dopasowanie jest lokalne i deterministyczne, na podstawie słów i pojęć z tych obszarów.</div>
 </div>`,'xxii');
 document.querySelectorAll('[data-action]').forEach(el=>el.onclick=()=>xxiiAction(el.dataset.action));
}
function xxiiAction(a){
 if(!state.xxiiQuestions.length){alert(state.officialLoading?'Baza OP jest jeszcze analizowana. Poczekaj na zakończenie paska postępu.':'Nie ma jeszcze oficjalnych pytań do tej zakładki. Najpierw pobierz lub przenieś bazę OP.');return}
 if(a.startsWith('xxii-cat:')){const c=a.slice('xxii-cat:'.length);startSession(shuffle(state.xxiiQuestions.filter(q=>q.themeCategory===c)),'xxii-topic',false);return}
 if(a==='xxii-random'){startSession(shuffle(state.xxiiQuestions).slice(0,20),'xxii-random',false);return}
 if(a==='xxii-half'){
   const p=splitByDifficulty(state.xxiiQuestions),easyN=Math.min(10,p.easy.length),hardN=Math.min(10,p.hard.length);
   const list=[...shuffle(p.easy).slice(0,easyN),...shuffle(p.hard).slice(0,hardN)];
   if(!list.length){alert('Brak pytań z rozpoznaną punktacją 1/2 pkt.');return}
   startSession(shuffle(list),'xxii-half',true,30,true);return
 }
 if(a==='xxii-all'){startSession(shuffle(state.xxiiQuestions),'xxii-all',false);return}
}

function normalizedDifficulty(q){const d=String(q.difficulty||'').toLowerCase();if(['easy','łatwe','latwe','łatwiejsze','latwiejsze','1'].includes(d))return'easy';if(['hard','trudne','trudniejsze','2'].includes(d))return'hard';if(Number(q.points)===1)return'easy';if(Number(q.points)===2)return'hard';return null;}
function splitByDifficulty(pool){return {easy:pool.filter(q=>normalizedDifficulty(q)==='easy'),hard:pool.filter(q=>normalizedDifficulty(q)==='hard')};}
function startOfficialMode(easyN,hardN,mode){
 if(state.officialLoading){alert('Oficjalna baza OP jest jeszcze analizowana. Poczekaj, aż zniknie pasek „Analiza oficjalnych kluczy OP”, i uruchom tryb ponownie.');return}
 const official=officialQuestions();
 const parts=splitByDifficulty(official);
 if(parts.easy.length<easyN||parts.hard.length<hardN){
   if(!official.length){alert('Aplikacja ma teraz tylko pytania demo. W folderze tej wersji nie ma załadowanej bazy OP. Uruchom PRZENIES-DANE-Z-POPRZEDNIEJ-WERSJI.bat albo POBIERZ-PYTANIA-WINDOWS.bat, a potem START-WINDOWS.bat.');return}
   alert(`Do tego trybu potrzeba co najmniej ${easyN} pytań łatwiejszych i ${hardN} trudniejszych z oficjalnej bazy. Gotowych masz obecnie ${parts.easy.length} łatwiejszych i ${parts.hard.length} trudniejszych. Wejdź w Dane i sprawdź wynik analizy kluczy PDF.`);return
 }
 const list=[...shuffle(parts.easy).slice(0,easyN),...shuffle(parts.hard).slice(0,hardN)];startSession(shuffle(list),mode,true,mode==='half'?30:60,true);
}

function startExamSetup(){const base=primaryQuestions(),ed=uniq(base.map(q=>q.edition)).sort(),st=uniq(base.map(q=>q.stage)).sort();$('#app').innerHTML=shell(`<div class="card stack"><h2 style="margin:0">Własna symulacja</h2><div class="filters">${selectField('Edycja','x-edition',['Wszystkie',...ed])}${selectField('Etap','x-stage',['Wszystkie',...st])}<div class="field"><label>Liczba pytań</label><input id="x-count" type="number" min="1" max="200" value="50"></div></div><div class="field"><label>Czas (minuty)</label><input id="x-time" type="number" min="1" max="240" value="60"></div><button class="btn danger" id="x-start">Rozpocznij egzamin</button></div>`,'home');$('#x-start').onclick=()=>{const e=$('#x-edition').value,s=$('#x-stage').value;let p=primaryQuestions().filter(q=>(e==='Wszystkie'||q.edition===e)&&(s==='Wszystkie'||q.stage===s));const n=Math.min(parseInt($('#x-count').value||50),p.length),mins=parseInt($('#x-time').value||60);startSession(shuffle(p).slice(0,n),'exam',true,mins,false)}}

function startAdaptive(n){const base=primaryQuestions(),scored=base.map(q=>({q,w:adaptiveWeight(q)})).sort((a,b)=>b.w-a.w),head=scored.slice(0,Math.max(n*3,n)),pool=[];head.forEach(x=>{const copies=Math.max(1,Math.min(8,Math.round(x.w)));for(let i=0;i<copies;i++)pool.push(x.q)});const selected=[];for(const q of shuffle(pool)){if(!selected.some(x=>x.id===q.id))selected.push(q);if(selected.length>=Math.min(n,base.length))break}startSession(selected,'adaptive',false);}
function adaptiveWeight(q){let w=1;const h=state.history.filter(x=>x.questionId===q.id);if(!h.length)w+=2;w+=h.filter(x=>!x.correct).length*1.5;if(getSR(q.id).due<=Date.now())w+=3;const cat=categoryAccuracy(q.category);if(cat.total>=3)w+=(100-cat.pct)/25;return w;}

function startSession(list,mode,exam=false,minutes=60,officialScoring=false){if(!list.length){alert('Brak pytań dla tego trybu.');return}stopExamTimer();state.session={mode,questions:list,index:0,answers:{},revealed:false,started:Date.now(),exam,endAt:exam?Date.now()+minutes*60000:null,officialScoring};state.view='session';if(exam)startExamTimer();render();}
function startExamTimer(){stopExamTimer();state.examTimer=setInterval(()=>{if(!state.session)return;const left=state.session.endAt-Date.now();if(left<=0){finishSession();return}const el=$('#timer');if(el)el.textContent=formatTime(left)},1000)}
function stopExamTimer(){if(state.examTimer){clearInterval(state.examTimer);state.examTimer=null}}
const formatTime=ms=>{const s=Math.max(0,Math.floor(ms/1000));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`}

function scoreBreakdown(s){
 const easy=s.questions.filter(q=>normalizedDifficulty(q)==='easy');
 const hard=s.questions.filter(q=>normalizedDifficulty(q)==='hard');
 const easyPts=easy.reduce((t,q)=>t+officialPoints(q,s.answers[q.id]),0);
 const hardPts=hard.reduce((t,q)=>t+officialPoints(q,s.answers[q.id]),0);
 return {easy,hard,easyPts,hardPts,total:easyPts+hardPts,max:easy.length+hard.length*2,scoreable:easy.length+hard.length};
}
function liveScoreHtml(s){
 if(s.mode==='official')return '';
 const b=scoreBreakdown(s);if(!b.scoreable)return '';
 return `<div class="live-score"><strong>${fmtPts(b.total)} pkt</strong><span>łatwe ${fmtPts(b.easyPts)} • trudne ${fmtPts(b.hardPts)}</span></div>`;
}

function renderSession(){const s=state.session,q=s.questions[s.index];if(!q){finishSession();return}const chosen=s.answers[q.id],exam=s.exam,reveal=!exam&&s.revealed,diff=normalizedDifficulty(q);$('#app').innerHTML=shell(`<div class="stack"><div class="card stack"><div class="row session-head" style="justify-content:space-between"><div class="meta"><span>${s.index+1}/${s.questions.length}</span><span>${esc(q.edition)}</span><span>${esc(q.stage)}</span><span>${esc(q.category)}</span>${diff?`<span class="difficulty ${diff}">${diff==='easy'?'1 pkt':'2 pkt'}</span>`:''}</div><div class="session-status">${liveScoreHtml(s)}${exam?`<div class="timer" id="timer">${formatTime(s.endAt-Date.now())}</div>`:''}</div></div><div class="question">${esc(q.question)}</div><div class="stack">${['A','B','C','D'].map(k=>answerButton(q,k,chosen,reveal)).join('')}<button class="answer abstain ${chosen==='E'?'selected':''}" data-k="E"><strong>E</strong><span>Nie udzielam odpowiedzi <small>— 0 pkt</small></span></button></div>${reveal?`<div class="comment"><strong>${chosen==='E'?'Brak odpowiedzi — 0 pkt':chosen===q.correct?'Poprawnie':'Błędnie'}.</strong> Prawidłowa odpowiedź: <strong>${esc(q.correct)}</strong>.<br>${esc(q.comment||'Brak komentarza.')}</div>`:''}<div class="row"><button class="btn secondary" id="fav">${state.favorites.has(q.id)?'★ Ulubione':'☆ Dodaj do ulubionych'}</button><button class="btn secondary" id="prev" ${s.index===0?'disabled':''}>← Wstecz</button><button class="btn" id="next">${s.index===s.questions.length-1?'Zakończ':'Dalej →'}</button></div></div></div>`,'learn');document.querySelectorAll('.answer').forEach(b=>b.onclick=()=>chooseAnswer(q,b.dataset.k));$('#fav').onclick=()=>toggleFavorite(q.id);$('#prev').onclick=()=>{s.index--;s.revealed=false;render()};$('#next').onclick=()=>{if(!chosen){alert('Wybierz odpowiedź A-D albo E — nie udzielam odpowiedzi.');return}if(!exam&&!s.revealed){s.revealed=true;render();return}if(s.index===s.questions.length-1)finishSession();else{s.index++;s.revealed=false;render()}};}
function answerButton(q,k,chosen,reveal){let cls='answer';if(chosen===k)cls+=' selected';if(reveal&&k===q.correct)cls+=' correct';if(reveal&&chosen===k&&k!==q.correct)cls+=' wrong';return `<button class="${cls}" data-k="${k}"><strong>${k}</strong><span>${esc(q.answers[k])}</span></button>`}
function chooseAnswer(q,k){const s=state.session;if(s.exam){s.answers[q.id]=k;render();return}if(s.revealed)return;s.answers[q.id]=k;s.revealed=true;recordAnswer(q,k,s.mode);render();}
async function recordAnswer(q,k,mode){const correct=k===q.correct,rec={questionId:q.id,answer:k,correct,ts:Date.now(),category:q.category,edition:q.edition,stage:q.stage,mode};await add(STORE_H,rec);state.history.push(rec);if(k!=='E')updateSR(q.id,correct);}
async function finishSession(){stopExamTimer();const s=state.session;if(s.exam){for(const q of s.questions){const k=s.answers[q.id];if(k)await recordAnswer(q,k,s.mode)}}s.finished=Date.now();state.view='summary';render();}
function officialPoints(q,a){if(a==='E'||!a)return 0;const hard=normalizedDifficulty(q)==='hard';if(a===q.correct)return hard?2:1;return hard?-1:-0.5;}
function renderSummary(){const s=state.session,answered=s.questions.filter(q=>s.answers[q.id]&&s.answers[q.id]!=='E'),correct=answered.filter(q=>s.answers[q.id]===q.correct).length,b=scoreBreakdown(s);let scoreBlock='';
 if(b.scoreable){const main=s.officialScoring?`<div class="result">${fmtPts(b.total)} / ${b.max} pkt</div><h2>${pct(Math.max(0,b.total),b.max)}% maksymalnej punktacji</h2>`:`<div class="result">${correct}/${s.questions.length}</div><h2>${pct(correct,s.questions.length)}% poprawnych</h2>`;scoreBlock=`<div class="card official-score">${main}<div class="score-split"><span>Łatwiejsze: <strong>${fmtPts(b.easyPts)} / ${b.easy.length}</strong></span><span>Trudniejsze: <strong>${fmtPts(b.hardPts)} / ${b.hard.length*2}</strong></span><span>Łącznie: <strong>${fmtPts(b.total)} / ${b.max} pkt</strong></span></div><p class="sub">Poprawna: +1/+2 • błędna: −0,5/−1 • E / brak odpowiedzi: 0 pkt</p></div>`;
 }else scoreBlock=`<div class="card"><div class="result">${correct}/${s.questions.length}</div><h2>${pct(correct,s.questions.length)}%</h2><p class="sub">Odpowiedziano: ${answered.length}/${s.questions.length}</p></div>`;
 $('#app').innerHTML=shell(`<div class="stack">${scoreBlock}<div class="card stack"><h3 style="margin:0">Analiza</h3>${s.questions.map(q=>{const a=s.answers[q.id],ok=a===q.correct,pts=normalizedDifficulty(q)?` • ${fmtPts(officialPoints(q,a))} pkt`:'';return `<div class="list-item"><div><strong>${esc(q.category)}</strong><div class="sub">${esc(q.question)}</div></div><div style="text-align:right"><strong>${a||'—'} / ${q.correct}</strong><div class="sub">${a==='E'||!a?'0 pkt':ok?'✓':'✗'}${pts}</div></div></div>`}).join('')}</div><button class="btn" id="done">Wróć na start</button></div>`,'home');$('#done').onclick=()=>{state.session=null;state.view='home';render()};}
function fmtPts(n){return Number.isInteger(n)?String(n):n.toFixed(1).replace('.',',')}

function renderStats(){const cats=uniq([...allQuestions().map(q=>q.category),...state.history.map(h=>h.category)]).filter(Boolean),total=state.history.length,correct=state.history.filter(x=>x.correct).length;$('#app').innerHTML=shell(`<div class="stack"><div class="stats-grid"><div class="card"><div class="kpi">${total}</div><div class="kpi-label">odpowiedzi</div></div><div class="card"><div class="kpi">${pct(correct,total)}%</div><div class="kpi-label">poprawnych</div></div><div class="card"><div class="kpi">${getWrongIds().size}</div><div class="kpi-label">pytania z błędem</div></div></div><div class="card stack"><h3 style="margin:0">Kategorie</h3>${cats.map(c=>{const a=categoryAccuracy(c);return `<div><div class="row" style="justify-content:space-between"><strong>${esc(c)}</strong><span>${a.pct}% (${a.correct}/${a.total})</span></div><div class="bar"><span style="width:${a.pct}%"></span></div></div>`}).join('')}</div><div class="card stack"><h3 style="margin:0">Najsłabsze działy</h3>${weakCategories().map(x=>`<div class="list-item"><span>${esc(x.category)}</span><strong>${x.pct}%</strong></div>`).join('')||'<div class="empty">Za mało danych.</div>'}</div></div>`,'stats');}
function overallAccuracy(){return pct(state.history.filter(x=>x.correct).length,state.history.filter(x=>x.answer!=='E').length)}
function categoryAccuracy(c){const h=state.history.filter(x=>x.category===c&&x.answer!=='E');return{total:h.length,correct:h.filter(x=>x.correct).length,pct:pct(h.filter(x=>x.correct).length,h.length)}}
function weakCategories(){return uniq([...allQuestions().map(q=>q.category),...state.history.map(h=>h.category)]).filter(Boolean).map(c=>({category:c,...categoryAccuracy(c)})).filter(x=>x.total>=2).sort((a,b)=>a.pct-b.pct).slice(0,5)}
function getWrongIds(){const m=new Map();for(const h of state.history){if(h.answer!=='E')m.set(h.questionId,h.correct)}return new Set([...m.entries()].filter(([,ok])=>!ok).map(([id])=>id))}
function getSR(id){const all=JSON.parse(localStorage.getItem('op-sr')||'{}');return all[id]||{level:0,due:0}}
function updateSR(id,correct){const all=JSON.parse(localStorage.getItem('op-sr')||'{}');let s=all[id]||{level:0,due:0};s.level=correct?Math.min(5,s.level+1):0;const days=[0,1,3,7,14,30][s.level];s.due=Date.now()+days*86400000;all[id]=s;localStorage.setItem('op-sr',JSON.stringify(all))}
function countDue(){const now=Date.now();return allQuestions().filter(q=>getSR(q.id).due<=now).length}
async function toggleFavorite(id){if(state.favorites.has(id))state.favorites.delete(id);else state.favorites.add(id);await setMeta('favorites',[...state.favorites]);render()}

function renderSettings(){const off=officialQuestions(),parts=splitByDifficulty(off),official=off.length,stats=state.importStats;$('#app').innerHTML=shell(`<div class="stack"><div class="card stack"><h2 style="margin:0">Baza pytań</h2><div class="meta"><span>Oficjalne OP: ${official}</span><span>Archiwalne pod XXII: ${state.xxiiQuestions.length}</span><span>Łatwiejsze: ${parts.easy.length}</span><span>Trudniejsze: ${parts.hard.length}</span></div>${stats?`<div class="notice">Klucze PDF: <strong>${stats.fromPdf}</strong> pytań • awaryjnie z komentarza: <strong>${stats.fromHint}</strong> • bez pewnego klucza: <strong>${stats.missing}</strong> • odczytane arkusze z kluczem: <strong>${stats.keyPdfs}</strong>.</div>`:''}<p class="sub">Importer tworzy <code>op-raw.json</code> i pobiera oficjalne arkusze PDF. Przy uruchomieniu PDF.js lokalnie odczytuje klucze i paruje je z pytaniami.</p><div class="row"><button class="btn blue" id="reload-op">Przelicz klucze ponownie</button><button class="btn secondary" id="import">Importuj własny JSON</button><button class="btn secondary" id="exportq">Eksportuj bazę</button><button class="btn secondary" id="exportp">Eksportuj postęp</button></div></div><div class="card stack"><h3 style="margin:0">Zarządzanie</h3><button class="btn secondary" id="demo">Przywróć 20 pytań demo</button><button class="btn danger" id="reset">Usuń postęp i statystyki</button></div><div class="notice">Bez Pythona i Node.js: uruchom <strong>POBIERZ-PYTANIA-WINDOWS.bat</strong>, potem <strong>START-WINDOWS.bat</strong>. Analiza arkuszy PDF odbywa się w tle. Zakładka XXII jest tworzona lokalnie z załadowanego archiwum OP i działa offline po zapisaniu bazy.</div></div>`,'settings');$('#reload-op').onclick=async()=>{syncOfficialDataInBackground(true)};$('#import').onclick=()=>$('#file-import').click();$('#exportq').onclick=exportQuestions;$('#exportp').onclick=exportProgress;$('#demo').onclick=restoreDemo;$('#reset').onclick=resetProgress;}
async function importQuestionsFile(ev){const f=ev.target.files[0];if(!f)return;try{const data=JSON.parse(await f.text()),arr=Array.isArray(data)?data:data.questions;validateQuestions(arr);for(const q of arr)await put(STORE_Q,q);state.questions=await getAll(STORE_Q);refreshXXIIQuestions();alert(`Zaimportowano ${arr.length} pytań.`);state.view='home';render()}catch(e){alert('Błąd importu: '+e.message)}ev.target.value='';}
function validateQuestions(arr){if(!Array.isArray(arr))throw new Error('JSON musi zawierać tablicę pytań.');for(const q of arr){if(!q.id||!q.question||!q.answers||!q.correct)throw new Error('Brakuje wymaganych pól.');for(const k of ['A','B','C','D'])if(!(k in q.answers))throw new Error('Każde pytanie musi mieć odpowiedzi A-D.');if(!['A','B','C','D'].includes(q.correct))throw new Error('correct musi być A/B/C/D.');q.edition=q.edition||'Nieznana';q.stage=q.stage||'nieznany';q.category=q.category||'Inne';q.comment=q.comment||'';if(q.difficulty)q.difficulty=normalizedDifficulty(q)||q.difficulty;}}
function download(name,obj){const b=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
function exportQuestions(){download('op-trainer-pytania.json',state.questions)}
function exportProgress(){download('op-trainer-postep.json',{history:state.history,favorites:[...state.favorites],sr:JSON.parse(localStorage.getItem('op-sr')||'{}')})}
async function restoreDemo(){if(!confirm('Zastąpić bazę 20 pytaniami demonstracyjnymi?'))return;await clearStore(STORE_Q);const demo=await fetch('demo-data.json').then(r=>r.json());for(const q of demo)await put(STORE_Q,q);state.questions=demo;refreshXXIIQuestions();renderSettings()}
async function resetProgress(){if(!confirm('Usunąć historię, ulubione i harmonogram powtórek?'))return;await clearStore(STORE_H);await setMeta('favorites',[]);localStorage.removeItem('op-sr');state.history=[];state.favorites=new Set();renderSettings()}
init().catch(e=>{document.body.innerHTML='<pre style="padding:20px">Błąd uruchomienia: '+esc(e.message)+'</pre>'});
