function norm(s=''){return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ł/g,'l').replace(/Ł/g,'L').toLowerCase()}
function stageFromText(s=''){
  s=norm(s);
  if(s.includes('szkol')) return 'szkolny';
  if(s.includes('okreg')) return 'okręgowy';
  if(s.includes('central')) return 'centralny';
  return null;
}
function toRoman(n){const map=[[20,'XX'],[19,'XIX'],[18,'XVIII'],[17,'XVII'],[16,'XVI'],[15,'XV'],[14,'XIV'],[13,'XIII'],[12,'XII'],[11,'XI'],[10,'X'],[9,'IX'],[8,'VIII'],[7,'VII'],[6,'VI'],[5,'V'],[4,'IV'],[3,'III'],[2,'II'],[1,'I']];return map.find(x=>x[0]===n)?.[1]||''}
function romanFromText(text='',url=''){
  let m=text.match(/Olimpiada\s+Przedsi[eę]biorczo[sś]ci\s*[,\-]?\s*([IVXLCDM]+)\s+edycja/i);
  if(m) return m[1].toUpperCase();
  m=(url||'').match(/_OP(\d{1,2})\b/i); if(m) return toRoman(Number(m[1]));
  m=text.match(/\b([IVXLCDM]+)\s+edycja\b/i); return m?m[1].toUpperCase():null;
}
function fullYear(s=''){
  let m=String(s).match(/\b(20\d{2})\s*[\/-]\s*(20\d{2})\b/); if(m)return `${m[1]}/${m[2]}`;
  m=String(s).match(/\b(\d{2})\s*[\/-]\s*(\d{2})\b/); if(m){const a=2000+Number(m[1]),b=2000+Number(m[2]);return `${a}/${b}`;}
  return '';
}
function yearFromMeta(entry,text=''){return entry?.year||fullYear(entry?.edition)||fullYear(text)||''}
function normalizeAnsToken(s=''){return String(s).toUpperCase().replace(/\s+/g,'').replace(/[;/]/g,',')}
function keyId(roman,stage){return `${roman||''}|${stage||''}`}
function setIdOf(q){return keyId(q.editionCode||romanFromText(q.edition||''),q.stage||stageFromText(q.stage||''))}
function cleanTextHtml(s=''){
  s=String(s).replace(/<br\s*\/?>|<\/(?:p|div|li|tr|td|h[1-6])\s*>/gi,'\n');
  const el=document.createElement('div'); el.innerHTML=s;
  el.querySelectorAll('script,style,noscript').forEach(x=>x.remove());
  return (el.textContent||'').replace(/\u00a0/g,' ').replace(/\r/g,'').replace(/[ \t]+/g,' ').replace(/\n[ \t]+/g,'\n').trim();
}
function extractRowAnswer(line){
  line=String(line).replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
  let m=line.match(/^(\d{1,2})[\.)]?\s+([A-D](?:\s*[,/]\s*[A-D])?)(?:\s+([A-D](?:\s*[,/]\s*[A-D])?))?\s+(1|2)(?:\s|$)/i);
  if(!m)return null; const n=Number(m[1]); if(n<1||n>80)return null;
  const a=normalizeAnsToken(m[2]); if(!/^[A-D](?:,[A-D])?$/.test(a))return null;
  return {n,answer:a,points:Number(m[4])};
}
function extractKeyTable(lines,text='',force=false){
  const ans={};
  const normalized=norm(text);
  const looksLikeKey=/klucz\s+odpowiedzi/i.test(normalized)||/odpowiedz\s+poprawna/i.test(normalized)||/wersja\s+a/i.test(normalized);
  if(!force&&!looksLikeKey)return ans;

  // 1) Normal visual rows, e.g. `1 D A 1 -0,5 0 -0,5` or `1 d 1 0 0 0`.
  for(const line of lines){const r=extractRowAnswer(line.text||line);if(r)ans[r.n]={answer:r.answer,points:r.points};}

  // 2) More tolerant per-line parser. It accepts A/B-version keys and single-version keys.
  for(const line of lines){
    const s=String(line.text||line).replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
    const re=/(?:^|\s)(\d{1,2})[\.)]?\s+([A-D](?:\s*[,/]\s*[A-D])?)(?:\s+([A-D](?:\s*[,/]\s*[A-D])?))?\s+([12])(?=\s+(?:-?\d|0)|$)/ig; let m;
    while((m=re.exec(s))){
      const n=Number(m[1]),a=normalizeAnsToken(m[2]),pts=Number(m[4]);
      if(n>=1&&n<=80&&/^[A-D](?:,[A-D])?$/.test(a)&&!ans[n])ans[n]={answer:a,points:pts};
    }
  }

  // 3) PDF.js sometimes breaks table rows into odd visual lines while preserving text order.
  // Parse the complete flattened text as a fallback; the first answer after the number is WERSJA A.
  const flat=String(text).replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
  const reFlat=/(?:^|\s)(\d{1,2})[\.)]?\s+([A-D](?:\s*[,/]\s*[A-D])?)(?:\s+([A-D](?:\s*[,/]\s*[A-D])?))?\s+([12])(?=\s+(?:-?\d|0)|$)/ig; let fm;
  while((fm=reFlat.exec(flat))){
    const n=Number(fm[1]),a=normalizeAnsToken(fm[2]),pts=Number(fm[4]);
    if(n>=1&&n<=80&&/^[A-D](?:,[A-D])?$/.test(a)&&!ans[n])ans[n]={answer:a,points:pts};
  }
  return ans;
}
async function pdfDetailed(pdfjsLib,file){
  // Fetch bytes ourselves instead of letting PDF.js stream/range-load from the tiny
  // PowerShell server. This also lets us reject HTML/error pages saved as .pdf.
  const response=await fetch(file,{cache:'no-store'});
  if(!response.ok)throw new Error(`PDF_HTTP_${response.status}: ${file}`);
  const type=response.headers.get('content-type')||'';
  const buf=await response.arrayBuffer();
  const bytes=new Uint8Array(buf);
  const magic=String.fromCharCode(...bytes.slice(0,5));
  if(magic!=='%PDF-'){
    const head=new TextDecoder('utf-8',{fatal:false}).decode(bytes.slice(0,80)).replace(/\s+/g,' ').trim();
    throw new Error(`NOT_A_PDF magic=${JSON.stringify(magic)} type=${type||'unknown'} size=${bytes.length} head=${head.slice(0,60)}`);
  }
  const task=pdfjsLib.getDocument({data:bytes,disableAutoFetch:true,disableStream:true,isEvalSupported:false});
  const pdf=await task.promise; const lines=[]; const tokens=[]; let full='';
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p),tc=await page.getTextContent(),styles=tc.styles||{}; const groups=[];
    for(const item of tc.items){
      const str=(item.str||'').replace(/\u00a0/g,' ').trim(); if(!str)continue;
      const x=item.transform?.[4]??0,y=item.transform?.[5]??0,font=item.fontName||'',family=styles?.[font]?.fontFamily||'';
      tokens.push({str,x,y,page:p,font,family});
      let g=groups.find(z=>Math.abs(z.y-y)<=4.5); if(!g){g={y,items:[],page:p};groups.push(g)}
      g.items.push({x,str,font,family});
    }
    groups.sort((a,b)=>b.y-a.y);
    for(const g of groups){
      g.items.sort((a,b)=>a.x-b.x); const text=g.items.map(x=>x.str).join(' ').replace(/\s+/g,' ').trim(); if(!text)continue;
      const fm=new Map(); for(const it of g.items){const k=`${it.font}|${it.family}`;fm.set(k,(fm.get(k)||0)+it.str.length)}
      const dominant=[...fm.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||'';
      lines.push({text,font:dominant,fonts:[...fm.keys()],items:g.items.map(it=>({str:it.str,font:it.font,family:it.family,x:it.x})),page:p}); full+=' '+text;
    }
  }
  return {lines,tokens,text:full.trim()};
}

function extractKeyTokens(tokens,text='',force=false){
  const ans={};
  const evidence=force||/klucz\s+odpowiedzi/i.test(norm(text));
  if(!evidence)return ans;
  const byPage=new Map();
  for(const t of tokens||[]){if(!byPage.has(t.page))byPage.set(t.page,[]);byPage.get(t.page).push(t)}
  for(const arr of byPage.values()){
    arr.sort((a,b)=>Math.abs(a.y-b.y)>4.5?b.y-a.y:a.x-b.x);
    const vals=arr.map(t=>String(t.str).trim()).filter(Boolean);
    for(let i=0;i<vals.length;i++){
      if(!/^\d{1,2}$/.test(vals[i]))continue;
      const n=Number(vals[i]); if(n<1||n>80)continue;
      let j=i+1; const letters=[];
      while(j<vals.length&&letters.length<2&&/^[A-D]$/i.test(vals[j])){letters.push(vals[j].toUpperCase());j++}
      if(!letters.length)continue;
      let points=null;
      for(let k=j;k<Math.min(vals.length,j+5);k++){if(/^[12]$/.test(vals[k])){points=Number(vals[k]);break}}
      if(!ans[n])ans[n]={answer:letters[0],points};
    }
  }
  return ans;
}
function optionStart(line){const m=String(line?.text||line||'').match(/^\s*([a-dA-D])\s*[\.)]\s*(.*)$/);return m?{letter:m[1].toUpperCase(),rest:m[2].trim()}:null}
function qMarker(line){
  const s=String(line?.text||line||'').trim();
  let m=s.match(/^Pytanie\s+nr\s+(\d{1,2})\b/i);
  if(m)return Number(m[1]);
  // Official tests often start questions with quotes, numbers, symbols or lowercase words.
  // Requiring an uppercase first character dropped many legitimate questions.
  m=s.match(/^(\d{1,2})\.\s+(?:\(?\s*[12]\s*pkt\s*\)?\s*)?/i);
  if(m)return Number(m[1]);
  m=s.match(/^(\d{1,2})\)\s+(?=\(?\s*[12]\s*pkt\s*\)?)/i);
  return m?Number(m[1]):null;
}
function stripQuestionPrefix(s=''){return s.replace(/^Pytanie\s+nr\s+\d{1,2}\s*/i,'').replace(/^\d{1,2}[\.)]\s*/,'').replace(/^\(?[12]\s*pkt\)?\s*/i,'').trim()}
function inferPoints(block,n){const head=block.slice(0,4).map(x=>x.text).join(' ');let m=head.match(/\(?\s*([12])\s*pkt\s*\)?/i);if(m)return Number(m[1]);return n<=25?1:n<=50?2:null}
function answerFontSignature(lines){
  const counts=new Map(); for(const l of lines){if(!l.font)continue;counts.set(l.font,(counts.get(l.font)||0)+(l.text||'').length)}
  return [...counts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||'';
}
function fontLooksBold(v=''){return /bold|semibold|semi-bold|demi|black|heavy|extrabold|extra-bold/i.test(String(v))}
function optionStyle(line){
  const items=line?.items||[];
  const joined=items.map(i=>`${i.font||''} ${i.family||''}`).join(' ');
  const boldChars=items.filter(i=>fontLooksBold(`${i.font||''} ${i.family||''}`)).reduce((n,i)=>n+String(i.str||'').length,0);
  const total=Math.max(1,items.reduce((n,i)=>n+String(i.str||'').length,0));
  return {boldRatio:boldChars/total,explicitBold:fontLooksBold(joined)};
}
function parsePdfQuestions(lines,entry={}){
  // Keep a monotonically increasing sequence of question numbers. This filters out most
  // numbered lists embedded inside a question while accepting quoted/numeric stems.
  const starts=[]; let last=0;
  for(let i=0;i<lines.length;i++){
    const n=qMarker(lines[i]);
    if(!n||n>80)continue;
    if(n<=last)continue;
    // Normal tests are sequential. Allow a small jump for damaged PDF extraction.
    if(last&&n>last+4)continue;
    starts.push({i,n}); last=n;
  }
  const candidates=[];
  for(let si=0;si<starts.length;si++){
    const {i:start,n}=starts[si],end=si+1<starts.length?starts[si+1].i:lines.length,block=lines.slice(start,end);
    if(block.length<4)continue;
    const opt=[];
    for(let j=0;j<block.length;j++){
      const o=optionStart(block[j]); if(o)opt.push({j,...o});
    }
    const byLetter={}; for(const o of opt)if(!byLetter[o.letter])byLetter[o.letter]=o;
    if(!['A','B','C','D'].every(k=>byLetter[k]))continue;
    const ordered=['A','B','C','D'].map(k=>byLetter[k]).sort((a,b)=>a.j-b.j),firstOpt=ordered[0].j;
    let qText=block.slice(0,firstOpt).map(x=>x.text).join(' ');
    qText=stripQuestionPrefix(qText).replace(/\(?\s*[12]\s*pkt\s*\)?/ig,'').replace(/\s+/g,' ').trim();
    if(qText.length<4)continue;
    const answers={},sigs={},styles={};
    for(let oi=0;oi<ordered.length;oi++){
      const o=ordered[oi],next=oi+1<ordered.length?ordered[oi+1].j:block.length;
      let seg=block.slice(o.j,next);
      // Do not let the expert comment dominate the font signature of option D.
      const ci=seg.findIndex(x=>/^\s*Komentarz\b/i.test(String(x.text||'')));
      if(ci>=0)seg=seg.slice(0,ci);
      let txt=[o.rest,...seg.slice(1).map(x=>x.text)].join(' ').replace(/\s+/g,' ').trim();
      txt=txt.replace(/\s+(Komentarz|Pytanie\s+nr)\b.*$/i,'').trim();
      answers[o.letter]=txt;
      sigs[o.letter]=answerFontSignature(seg);
      styles[o.letter]=optionStyle(block[o.j]);
    }
    // First preference: an explicitly bold answer line while the other three are not bold.
    const explicitBold=Object.entries(styles).filter(([,v])=>v.explicitBold&&v.boldRatio>=0.15).map(([k])=>k);
    let candidateCorrect=explicitBold.length===1?explicitBold[0]:null,oddFont=null,baseFont=null;
    if(!candidateCorrect){
      const freq={}; Object.values(sigs).forEach(f=>{if(f)freq[f]=(freq[f]||0)+1});
      const freqEntries=Object.entries(freq).sort((a,b)=>b[1]-a[1]);
      if(freqEntries[0]?.[1]>=2){
        baseFont=freqEntries[0][0];
        const odds=Object.entries(sigs).filter(([,f])=>f&&f!==baseFont);
        if(odds.length===1){candidateCorrect=odds[0][0];oddFont=odds[0][1];}
      }
    }
    candidates.push({n,question:qText,answers,points:inferPoints(block,n),candidateCorrect,oddFont,baseFont,explicitBold:explicitBold.length===1,block});
  }
  const oddCounts={}; for(const q of candidates)if(q.oddFont)oddCounts[q.oddFont]=(oddCounts[q.oddFont]||0)+1;
  return candidates.map(q=>{
    const reliable=q.explicitBold||(!q.explicitBold&&q.candidateCorrect&&q.oddFont&&oddCounts[q.oddFont]>=2);
    let comment=''; const joined=q.block.map(x=>x.text).join('\n'); const cm=joined.match(/Komentarz\s*:?[\s\S]*$/i); if(cm)comment=cm[0].replace(/^Komentarz\s*:?/i,'').trim();
    return {number:q.n,question:q.question,answers:q.answers,points:q.points,correct:reliable?q.candidateCorrect:null,comment};
  });
}

function htmlCorrect(raw='',answers={}){
  const hits=[];
  const markedTexts=[];
  const patterns=[
    /<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>/ig,
    /<[^>]+(?:class|style)=["'][^"']*(?:bold|klucz|correct|popraw|font-weight\s*:\s*(?:bold|[6-9]00))[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/ig
  ];
  for(const re of patterns){let m;while((m=re.exec(raw))){const t=cleanTextHtml(m[1]);if(t)markedTexts.push(t);const a=t.match(/^\s*([a-dA-D])\s*[\.)]/);if(a)hits.push(a[1].toUpperCase())}}
  // Some official HTML tests bold only the answer text, not the 'a)' label.
  for(const t of markedTexts){
    const nt=norm(t).replace(/[^a-z0-9ąćęłńóśźż]+/gi,' ').trim();
    for(const [letter,val] of Object.entries(answers||{})){
      const nv=norm(val).replace(/[^a-z0-9ąćęłńóśźż]+/gi,' ').trim();
      if(nv.length>=4&&(nt===nv||nt.includes(nv)||nv.includes(nt)))hits.push(letter);
    }
  }
  // Static HTML can also mark the selected/correct radio input.
  let cm; const checked=/<input\b[^>]*(?:checked(?:=["'][^"']*["'])?|class=["'][^"']*(?:correct|popraw)[^"']*["'])[^>]*>/ig;
  while((cm=checked.exec(raw))){const tag=cm[0];const vm=tag.match(/value=["']?([a-dA-D])["']?/i);if(vm)hits.push(vm[1].toUpperCase())}
  const u=[...new Set(hits)]; return u.length===1?u[0]:null;
}

function parseHtmlQuestions(html,entry={}){
  const markerRe=/Pytanie\s+nr\s+(\d{1,2})/ig,markers=[];let m;while((m=markerRe.exec(html)))markers.push({i:m.index,len:m[0].length,n:Number(m[1])});
  const out=[];
  for(let z=0;z<markers.length;z++){
    const mk=markers[z],end=z+1<markers.length?markers[z+1].i:html.length,raw=html.slice(mk.i+mk.len,end),text=cleanTextHtml(raw);
    const re=/^\s*([a-dA-D])\s*[\.)]\s*(.+)$/gim,opts=[];let am;while((am=re.exec(text)))opts.push({letter:am[1].toUpperCase(),text:am[2].trim(),idx:am.index});
    const by={};for(const o of opts)if(!by[o.letter])by[o.letter]=o;if(!['A','B','C','D'].every(k=>by[k]))continue;
    const first=Math.min(...Object.values(by).map(x=>x.idx));let question=text.slice(0,first).replace(/^\(?[12]\s*pkt\)?\s*/i,'').trim();
    const answers={};for(const k of ['A','B','C','D'])answers[k]=by[k].text.replace(/\s+(Komentarz)\s*:.*$/i,'').trim();
    let comment='';const cm=text.match(/Komentarz\s*:?\s*([\s\S]*)$/i);if(cm)comment=cm[1].trim();
    const pm=text.match(/\(?\s*([12])\s*pkt\s*\)?/i);out.push({number:mk.n,question,answers,points:pm?Number(pm[1]):(mk.n<=25?1:mk.n<=50?2:null),correct:htmlCorrect(raw,answers),comment});
  }
  return out;
}
function archiveQuestion(meta,p,source,answerSource){
  const roman=meta.editionCode||romanFromText(meta.edition||'',meta.url||''),stage=meta.stage||stageFromText(meta.stage||''),year=yearFromMeta(meta,meta.edition||'');
  return {id:`op-${roman}-${stage}-${p.number}`,setId:`${roman}-${stage}`,edition:meta.edition||`${roman} edycja${year?` (${year})`:''}`,editionCode:roman,year,stage,category:'OP - archiwum',difficulty:p.points===1?'easy':p.points===2?'hard':null,points:p.points,question:p.question,answers:p.answers,correct:p.correct||null,comment:p.comment||'',source:source||meta.url||'',sourceQuestionNumber:p.number,answerSource};
}
function mergeArchive(map,q){
  const k=`${q.editionCode}|${q.stage}|${q.sourceQuestionNumber}`;const prev=map.get(k);
  if(!prev){map.set(k,q);return}
  const score=x=>(x.correct?100:0)+(x.comment?.length||0)/100+(x.question?.length||0)/1000;
  const best=score(q)>score(prev)?q:prev,other=best===q?prev:q;
  if(!best.correct&&other.correct){best.correct=other.correct;best.answerSource=other.answerSource}
  if((other.comment?.length||0)>(best.comment?.length||0))best.comment=other.comment;
  if(!best.year)best.year=other.year; map.set(k,best);
}
const COMMENT_STOP=new Set('a aby albo ale ani bo by byl byla bylo byly co czy dla do gdy i ich jak jako jest jezeli juz ktora ktore ktory lub ma na nad nie o od oraz po pod przez przy sa sie tak ten to w we z za ze'.split(' '));
function commentTokens(v=''){
  return norm(v).replace(/[^a-z0-9ąćęłńóśźż]+/gi,' ').split(/\s+/).filter(t=>t&&t.length>1&&!COMMENT_STOP.has(t));
}
function simpleStem(t=''){
  t=String(t);
  // Conservative Polish suffix trimming for lexical comparison only.
  for(const suf of ['owego','owej','owych','ami','ach','owie','enia','aniu','ego','emu','cie','cji','cja','cje','ow','om','em','ie','y','a','u','i','e']){
    if(t.endsWith(suf)&&t.length-suf.length>=3)return t.slice(0,-suf.length);
  }
  return t;
}
function inferFromComment(q){
  const comment=String(q?.comment||'').trim(); if(comment.length<12)return null;
  const nc=norm(comment);
  const positives=[];
  // Official comments often contain lines like "Odpowiedź D) spełnia wszystkie kryteria...".
  const lr=/(?:odpowiedz|wariant)\s*([a-d])\)?\s*([^.!?\n]{0,180})/gi; let lm;
  while((lm=lr.exec(nc))){
    const tail=lm[2]||'';
    if(/\b(?:prawidl\w*|poprawn\w*|wlasciw\w*|spelnia\w*|stanowi\w*|oznacza\w*|jest\s+to\b)/i.test(tail))positives.push(lm[1].toUpperCase());
  }
  const pu=[...new Set(positives)]; if(pu.length===1)return {answer:pu[0],source:'comment-explicit'};
  let m=nc.match(/(?:prawidl\w*|poprawn\w*|wlasciw\w*)\s+(?:jest\s+)?(?:odpowiedz\s+)?([a-d])\b/i);
  if(m)return {answer:m[1].toUpperCase(),source:'comment-explicit'};
  const answers=q?.answers||{}, phraseHits=[];
  const cleanComment=nc.replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
  for(const [letter,val] of Object.entries(answers)){
    const nv=norm(val).replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
    if(nv.length>=5&&cleanComment.includes(nv))phraseHits.push(letter);
  }
  if(phraseHits.length===1)return {answer:phraseHits[0],source:'comment-exact'};
  const cset=new Set(commentTokens(comment).map(simpleStem)); const scored=[];
  for(const [letter,val] of Object.entries(answers)){
    const toks=[...new Set(commentTokens(val).map(simpleStem).filter(t=>t.length>1))];
    if(toks.length<1){scored.push([letter,0,toks.length]);continue;}
    const hit=toks.filter(t=>cset.has(t)).length; scored.push([letter,hit/toks.length,toks.length]);
  }
  scored.sort((a,b)=>b[1]-a[1]); const [best,second]=scored;
  if(best&&best[1]>=0.82&&best[2]>=1&&(best[1]-(second?.[1]||0)>=0.34))return {answer:best[0],source:'comment-overlap'};
  return null;
}


export async function resolveOfficialKeys(rawQuestions,onProgress=null){
  const index=[]; const seenEntries=new Set();
  for(const path of ['./archive-index.json','./key-index.json']){
    try{
      const r=await fetch(path,{cache:'no-store'}); if(!r.ok)continue;
      const j=await r.json(), arr=Array.isArray(j)?j:(j&&typeof j==='object'?[j]:[]);
      for(const e of arr){
        const sig=String(e?.url||e?.file||''); if(!sig||seenEntries.has(sig))continue;
        seenEntries.add(sig); index.push(e);
      }
    }catch{}
  }
  let pdfjsLib=null,pdfJsError='';try{pdfjsLib=await import('./vendor/pdf.min.mjs?v=192');pdfjsLib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.min.mjs',import.meta.url).href;}catch(e){pdfJsError=String(e?.message||e);console.warn('PDF.js niedostepny',e)}
  const explicitKeys=new Map(),archiveMap=new Map();
  let parsedPdfs=0,keyPdfs=0,parsedHtml=0,pdfAdded=0,htmlAdded=0,boldResolved=0,htmlResolved=0,multi=0,tokenRows=0,lineRows=0,pdfErrors=0,pdfEntries=0; const pdfErrorSamples=[];
  let done=0;
  for(const entry of index){
    try{
      const fmt=(entry.format||String(entry.file||'').split('.').pop()||'').toLowerCase();
      const entryRoman=entry.editionCode||romanFromText(entry.edition||'',entry.url||'');
      const entryStage=entry.stage||stageFromText((entry.edition||'')+' '+(entry.url||''));
      const meta={...entry,editionCode:entryRoman,stage:entryStage};
      if(fmt==='pdf')pdfEntries++;
      if(fmt==='html'){
        const r=await fetch('./'+String(entry.file).replace(/^\.\//,''),{cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);const html=await r.text();parsedHtml++;
        const htmlText=cleanTextHtml(html);
        const roman=romanFromText(htmlText,entry.url)||entryRoman,stage=stageFromText(htmlText+' '+(entry.url||''))||entryStage;
        if(roman)meta.editionCode=roman;if(stage)meta.stage=stage;
        const allowMarkedKey=meta.variant==='key'||meta.variant==='key-comments'||/klucz|key/i.test(entry.url||'')||/klucz\s+odpowiedzi/i.test(norm(htmlText));
        const parsed=parseHtmlQuestions(html,meta);
        const markedCount=parsed.filter(p=>p.correct).length;
        const trustMarks=allowMarkedKey||markedCount>=5;
        for(const p0 of parsed){const p=trustMarks?p0:{...p0,correct:null};const q=archiveQuestion(meta,p,entry.url,p.correct?'archive-html-key':'archive-html');if(q.correct){htmlResolved++;htmlAdded++;}mergeArchive(archiveMap,q)}
      } else if(fmt==='pdf'&&pdfjsLib){
        const d=await pdfDetailed(pdfjsLib,'./'+String(entry.file).replace(/^\.\//,''));parsedPdfs++;
        const roman=romanFromText(d.text,entry.url)||entryRoman,stage=stageFromText(d.text+' '+(entry.url||''))||entryStage;
        if(roman)meta.editionCode=roman;if(stage)meta.stage=stage;
        const hasKeyText=/klucz\s+odpowiedzi/i.test(norm(d.text));
        const allowMarkedKey=meta.variant==='key'||meta.variant==='key-comments'||/klucz|key/i.test(entry.url||'')||hasKeyText;
        const tableLine=extractKeyTable(d.lines,d.text,allowMarkedKey);
        const tableTok=extractKeyTokens(d.tokens,d.text,allowMarkedKey);
        const table={...tableTok,...tableLine};
        lineRows+=Object.keys(tableLine).length;tokenRows+=Object.keys(tableTok).length;
        const count=Object.keys(table).length;
        if(count>=5&&meta.editionCode&&meta.stage){
          keyPdfs++;const id=keyId(meta.editionCode,meta.stage),prev=explicitKeys.get(id);
          if(!prev||count>prev.count)explicitKeys.set(id,{answers:table,count,source:entry.url,file:entry.file});
        }
        const parsed=parsePdfQuestions(d.lines,meta);
        const markedCount=parsed.filter(p=>p.correct).length;
        const trustMarks=allowMarkedKey||markedCount>=5;
        for(const p0 of parsed){const p=trustMarks?p0:{...p0,correct:null};const q=archiveQuestion(meta,p,entry.url,p.correct?'archive-pdf-bold':'archive-pdf');if(q.correct){boldResolved++;pdfAdded++;}mergeArchive(archiveMap,q)}
      }
    }catch(e){
      if(((entry.format||String(entry.file||'').split('.').pop()||'').toLowerCase())==='pdf'){
        pdfErrors++;
        if(pdfErrorSamples.length<6)pdfErrorSamples.push(`${entry?.file||'(brak pliku)'} :: ${e?.name||'Error'} :: ${e?.message||e}`);
      }
      console.warn('Nie udalo sie odczytac materialu archiwalnego',entry?.file,e)
    }
    finally{done++;if(onProgress)try{onProgress({done,total:index.length,label:entry.file||'Arkusz'});}catch{}}
  }
  const rawMap=new Map();for(const q of rawQuestions){const roman=q.editionCode||romanFromText(q.edition||'',q.source||''),stage=stageFromText(q.stage||'')||q.stage||stageFromText(q.source||''),k=`${roman}|${stage}|${Number(q.sourceQuestionNumber)}`;rawMap.set(k,{...q,editionCode:roman,stage,year:q.year||fullYear(q.edition||'')})}
  const keys=new Set([...rawMap.keys(),...archiveMap.keys()]);const out=[];let fromPdf=0,fromArchive=0,fromHint=0,fromComment=0,missing=0,addedFromArchive=0;
  for(const k of keys){
    const raw=rawMap.get(k),arc=archiveMap.get(k),base=raw||arc;if(!base)continue;const roman=base.editionCode,stage=base.stage,n=Number(base.sourceQuestionNumber);const map=explicitKeys.get(keyId(roman,stage));const keyEntry=map?.answers?.[n]||null;
    let correct=keyEntry?.answer||arc?.correct||null,points=keyEntry?.points||arc?.points||raw?.points||null,answerSource=keyEntry?'pdf-key-table':(arc?.correct?arc.answerSource:null);
    if(correct&&correct.includes(',')){multi++;correct=null}
    if(correct){if(keyEntry)fromPdf++;else fromArchive++;}
    else if(raw?.correctHint&&/^[A-D]$/.test(raw.correctHint)){correct=raw.correctHint;answerSource='html-hint';fromHint++;}
    else {
      const inf=inferFromComment(raw||arc);
      if(inf){correct=inf.answer;answerSource=inf.source;fromComment++;}
      else{missing++;continue}
    }
    const question=(raw?.question||arc?.question||'').trim(),answers=raw?.answers||arc?.answers;if(!question||!answers||!['A','B','C','D'].every(x=>answers[x])){missing++;continue}
    const comment=((raw?.comment?.length||0)>=(arc?.comment?.length||0)?raw?.comment:arc?.comment)||''; const year=raw?.year||arc?.year||fullYear(raw?.edition||arc?.edition||'');
    if(!raw)addedFromArchive++;
    out.push({...base,id:raw?.id||arc?.id,edition:raw?.edition||arc?.edition,editionCode:roman,year,stage,question,answers,correct,points,difficulty:points===1?'easy':points===2?'hard':base.difficulty,comment,answerSource,keySource:map?.source||arc?.source||null});
  }
  return {questions:out,stats:{raw:rawQuestions.length,ready:out.length,fromPdf,fromArchive,fromHint,fromComment,missing,multi,parsedPdfs,keyPdfs,parsedHtml,keySets:explicitKeys.size,pdfAdded,htmlAdded,boldResolved,htmlResolved,addedFromArchive,archiveSets:new Set(out.map(q=>`${q.editionCode}|${q.stage}`)).size,indexEntries:index.length,lineRows,tokenRows,pdfEntries,pdfErrors,pdfJsLoaded:!!pdfjsLib,pdfJsError,pdfErrorSamples}};
}

export const __test={extractKeyTable,extractKeyTokens,qMarker,inferFromComment,normalizeAnsToken,parsePdfQuestions};
