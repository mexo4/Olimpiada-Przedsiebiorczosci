function stageFromText(s=''){
  s=s.toLowerCase();
  if(s.includes('szkol')) return 'szkolny';
  if(/okr[eę]g/.test(s)) return 'okręgowy';
  if(s.includes('central')) return 'centralny';
  return null;
}
function romanFromText(text='',url=''){
  let m=text.match(/Olimpiada\s+Przedsi[eę]biorczo[sś]ci\s*[,\-]?\s*([IVXLCDM]+)\s+edycja/i);
  if(m) return m[1].toUpperCase();
  m=(url||'').match(/_OP(\d{1,2})\b/i);
  if(m) return toRoman(Number(m[1]));
  m=text.match(/\b([IVXLCDM]+)\s+edycja\b/i);
  return m?m[1].toUpperCase():null;
}
function toRoman(n){
  const map=[[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']]; let out='';
  for(const [v,r] of map) while(n>=v){out+=r;n-=v}
  return out;
}
function normalizeAnsToken(s=''){
  return s.toUpperCase().replace(/\s+/g,'').replace(/[;/]/g,',');
}
function extractRowAnswer(line){
  line=line.replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
  let m=line.match(/^(\d{1,2})\s+([A-D](?:\s*,\s*[A-D])?)(?:\s+([A-D](?:\s*,\s*[A-D])?))?\s+(1|2)(?:\s|$)/i);
  if(!m) return null;
  const n=Number(m[1]); if(n<1||n>50) return null;
  const a=normalizeAnsToken(m[2]);
  if(!/^[A-D](?:,[A-D])?$/.test(a)) return null;
  return {n,answer:a,points:Number(m[4])}; // przy A/B bierzemy pierwsza kolumne = wersja A
}
async function pdfLines(pdfjsLib,file){
  const pdf=await pdfjsLib.getDocument(file).promise;
  const lines=[]; const all=[];
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p); const tc=await page.getTextContent();
    const groups=[];
    for(const item of tc.items){
      const str=(item.str||'').trim(); if(!str) continue;
      const x=item.transform?.[4]??0, y=item.transform?.[5]??0;
      let g=groups.find(z=>Math.abs(z.y-y)<=2.2);
      if(!g){g={y,items:[]};groups.push(g)}
      g.items.push({x,str}); all.push(str);
    }
    groups.sort((a,b)=>b.y-a.y);
    for(const g of groups){g.items.sort((a,b)=>a.x-b.x); lines.push(g.items.map(x=>x.str).join(' '));}
  }
  return {lines,text:all.join(' ')};
}
function keyId(roman,stage){return `${roman||''}|${stage||''}`}

export async function resolveOfficialKeys(rawQuestions,onProgress=null){
  let index=[];
  try{const r=await fetch('./key-index.json',{cache:'no-store'});if(r.ok){const j=await r.json();index=Array.isArray(j)?j:(j&&typeof j==='object'?[j]:[]);}}catch{}
  let pdfjsLib=null;
  try{
    pdfjsLib=await import('./vendor/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc='./vendor/pdf.worker.min.mjs';
  }catch(e){console.warn('PDF.js niedostepny',e)}

  const best=new Map(); let parsedPdfs=0, keyPdfs=0, multi=0;
  if(pdfjsLib){
    let done=0;
    for(const entry of index){
      try{
        const {lines,text}=await pdfLines(pdfjsLib,'./'+entry.file.replace(/^\.\//,'')); parsedPdfs++;
        if(!/KLUCZ\s+ODPOWIEDZI/i.test(text)) continue;
        const roman=romanFromText(text,entry.url), stage=stageFromText(text+' '+entry.url);
        if(!roman||!stage) continue;
        const ans={};
        for(const line of lines){const r=extractRowAnswer(line);if(r)ans[r.n]={answer:r.answer,points:r.points};}
        const count=Object.keys(ans).length;
        if(count<5) continue;
        keyPdfs++;
        const id=keyId(roman,stage),prev=best.get(id);
        if(!prev||count>prev.count) best.set(id,{answers:ans,count,source:entry.url});
      }catch(e){console.warn('Nie udalo sie odczytac PDF',entry.file,e)}
      finally{done++;if(onProgress)try{onProgress({done,total:index.length,label:entry.file||'PDF'});}catch{}}
    }
  }

  const out=[]; let fromPdf=0,fromHint=0,missing=0;
  for(const q of rawQuestions){
    const map=best.get(keyId(q.editionCode,q.stage));
    const keyEntry=map?.answers?.[Number(q.sourceQuestionNumber)] || null;
    let correct=keyEntry?.answer || null;
    let points=keyEntry?.points || q.points || null;
    let answerSource='pdf';
    if(correct&&correct.includes(',')){multi++; correct=null;}
    if(correct){fromPdf++;}
    else if(q.correctHint&&/^[A-D]$/.test(q.correctHint)){correct=q.correctHint;answerSource='html-hint';fromHint++;}
    else {missing++;continue;}
    out.push({...q,correct,points,difficulty:points===1?'easy':points===2?'hard':q.difficulty,answerSource,keySource:map?.source||null});
  }
  return {questions:out,stats:{raw:rawQuestions.length,ready:out.length,fromPdf,fromHint,missing,multi,parsedPdfs,keyPdfs,keySets:best.size}};
}
