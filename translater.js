console.log("Файл script-translate.js успешно загружен");

// Безопасное хранилище (чтобы скрипт не падал, если браузер блокирует localStorage)
const safeStorage = {
  get: (k) => { try { return localStorage.getItem(k); } catch(e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch(e) { console.error(e); } },
  remove: (k) => { try { localStorage.removeItem(k); } catch(e) { console.error(e); } }
};

async function googleTranslate(text,target){
  if(!text||!text.trim())return null;
  try{
    const url=`https://translate.googleapis.com/translate_a/single?client=gtx&sl=ru&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
    const r=await fetch(url);
    if(r.ok){
      const d=await r.json();
      if(Array.isArray(d)&&Array.isArray(d[0]))return d[0].map(x=>x[0]).join('');
    }
  }catch(e){console.warn("Google error:",e);}
  try{
    const r2=await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=ru|${target}`);
    const d2=await r2.json();
    if(d2&&d2.responseData&&d2.responseData.translatedText)return d2.responseData.translatedText;
  }catch(e){console.warn("MyMemory error:",e);}
  return null;
}

function collectWeekItems(){
  const w=window.weeks[window.cur.week];
  if(!w) return {itemList: [], uniqueTexts: []};
  const itemList=[];const textSet=new Set();
  for(let day=0;day<7;day++){
    const serial=w.dates[day];if(serial==null)continue;
    const dayObj={w,col:2+day,serial};
    for(const meal of MEALS){
      const list=w.blocks[meal.k]||[];
      ensureSel(day,meal.k,list);
      const sk=selKey(day,meal.k);
      for(const it of list){
        if(!window.sel[sk].has(it.key))continue;
        const t=texts(dayObj,it);
        if(!t.ru)continue;
        const needKk=!t.kk||t.kk===t.ru;
        const needEn=!t.en||t.en===t.ru||/[А-Яа-яЁё]/.test(t.en);
        if(!needKk&&!needEn)continue;
        textSet.add(t.ru);
        itemList.push({day,meal:meal.k,it,ruText:t.ru,needKk,needEn});
      }
    }
  }
  return {itemList,uniqueTexts:[...textSet],w};
}

function applyTranslations(itemList,kkMap,enMap){
  for(const {day,it,ruText,needKk,needEn} of itemList){
    const col=2+day;
    if(needKk&&kkMap[ruText])window.overrides['kk|'+col+'|'+it.key]=kkMap[ruText];
    if(needEn&&enMap[ruText])window.overrides['en|'+col+'|'+it.key]=enMap[ruText];
  }
}

/* ====== GOOGLE ====== */
const btnGoogle = document.getElementById('translateBtn');
if(btnGoogle) {
  btnGoogle.addEventListener('click', async function(){
    console.log("Клик по кнопке Google");
    this.disabled=true;
    try{
      const {itemList,uniqueTexts}=collectWeekItems();
      if(!itemList.length){say('Нечего переводить — всё заполнено.');return;}
      const kkMap={},enMap={};
      const needsKkSet=new Set(),needsEnSet=new Set();
      itemList.forEach(x=>{if(x.needKk)needsKkSet.add(x.ruText);if(x.needEn)needsEnSet.add(x.ruText);});

      for(let i=0;i<uniqueTexts.length;i++){
        const t=uniqueTexts[i];
        const nK=needsKkSet.has(t),nE=needsEnSet.has(t);
        if(!nK&&!nE)continue;
        say(`Google: ${i+1}/${uniqueTexts.length} — "${t.slice(0,30)}…"`);
        if(nK){const kk=await googleTranslate(t,'kk');if(kk)kkMap[t]=kk;}
        if(nE){const en=await googleTranslate(t,'en');if(en)enMap[t]=en;}
        await new Promise(r=>setTimeout(r,300));
      }
      applyTranslations(itemList,kkMap,enMap);
      renderWeek();
      say(`Готово (Google): переведено ${Object.keys(kkMap).length+Object.keys(enMap).length} текстов.`);
    }catch(e){say('Ошибка Google: '+e.message,true); console.error(e);}
    finally{this.disabled=false;}
  });
}

async function aiTranslateBatch(items, target, modelName = 'gemini-3.8-flash') {
  const apiKey = safeStorage.get('gemini_api_key');
  if (!apiKey) throw new Error('Сначала нажми «⚙️ Настроить ИИ».');
  
  const langName = target === 'kk' ? 'казахский' : 'английский';
  const prompt = `Переведи названия блюд с русского на ${langName}. Сохраняй кулинарный смысл. Верни СТРОГО JSON-массив строк без лишнего текста: ${JSON.stringify(items)}`;
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  const maxRetries = 3;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          contents: [{ parts: [{ text: prompt }] }], 
          generationConfig: { temperature: 0.1 } 
        })
      });
      
      // Если сервер перегружен (503) — ждем всё больше и больше времени
      if (res.status === 503 && attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt - 1) * 1000; // 1с, 2с, 4с...
        say(`Сервер перегружен. Ждем ${waitTime / 1000} сек. (Попытка ${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err.error && err.error.message) || ('HTTP ' + res.status));
      }
      
      const data = await res.json();
      let text = data.candidates[0].content.parts[0].text.trim();
      text = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      
      let arr;
      try {
        arr = JSON.parse(text);
      } catch (e) {
        const m = text.match(/\[[\s\S]*\]/);
        if (m) arr = JSON.parse(m[0]);
        else throw new Error('ИИ вернул не JSON: ' + text.slice(0, 100));
      }
      
      if (!Array.isArray(arr)) throw new Error('ИИ вернул не массив');
      return arr;
      
    } catch (err) {
      // Если модель недоступна (404) или сервер упал окончательно — пробуем резервную модель
      if (attempt === maxRetries) {
        console.warn(`Модель ${modelName} не справилась. Пробую резервную...`);
        if (modelName === 'gemini-3.8-flash') {
          return await aiTranslateBatch(items, target, 'gemini-3-flash-lite');
        } else if (modelName === 'gemini-3-flash-lite') {
          return await aiTranslateBatch(items, target, 'gemini-3.6-flash');
        }
        throw err;
      }
    }
  }
}

async function aiTranslateSafe(items,target){
  try{return await aiTranslateBatch(items,target);}
  catch(e){
    if(items.length>40){
      say(`Партия слишком большая — делю на 2 части…`);
      await new Promise(r=>setTimeout(r,1500));
      const half=Math.ceil(items.length/2);
      const a=await aiTranslateBatch(items.slice(0,half),target);
      await new Promise(r=>setTimeout(r,1500));
      const b=await aiTranslateBatch(items.slice(half),target);
      return [...a,...b];
    }
    throw e;
  }
}

const btnAi = document.getElementById('translateAiBtn');
if(btnAi) {
  btnAi.addEventListener('click', async function(){
    console.log("Клик по кнопке ИИ");
    this.disabled=true;
    try{
      if(!safeStorage.get('gemini_api_key')){say('Сначала нажми «⚙️ Настроить ИИ».',true);return;}
      const {itemList,uniqueTexts}=collectWeekItems();
      if(!itemList.length){say('Нечего переводить.');return;}
      const kkMap={},enMap={};
      const needsKkSet=new Set(),needsEnSet=new Set();
      itemList.forEach(x=>{if(x.needKk)needsKkSet.add(x.ruText);if(x.needEn)needsEnSet.add(x.ruText);});

      say(`ИИ: перевожу ${uniqueTexts.length} текстов…`);
      if(needsKkSet.size){
        say('ИИ: казахский…');
        const kkArr=await aiTranslateSafe(uniqueTexts,'kk');
        uniqueTexts.forEach((t,i)=>{if(kkArr[i])kkMap[t]=kkArr[i];});
      }
      if(needsEnSet.size){
        say('ИИ: английский…');
        await new Promise(r=>setTimeout(r,1200));
        const enArr=await aiTranslateSafe(uniqueTexts,'en');
        uniqueTexts.forEach((t,i)=>{if(enArr[i])enMap[t]=enArr[i];});
      }
      applyTranslations(itemList,kkMap,enMap);
      renderWeek();
      say(`Готово (ИИ): переведено ${itemList.length} строк.`);
    }catch(e){say('Ошибка ИИ: '+e.message,true); console.error(e);}
    finally{this.disabled=false;}
  });
}

/* ====== КЛЮЧ ИИ ====== */
const keyBtn=document.getElementById('aiKeyBtn');
function updateKeyBtnState(){
  if(!keyBtn) return;
  const k=safeStorage.get('gemini_api_key');
  if(k){keyBtn.textContent='🔒 Ключ сохранён';keyBtn.style.color='var(--mute)';}
  else{keyBtn.textContent='⚙️ Настроить ИИ (API-ключ)';keyBtn.style.color='';}
}
updateKeyBtnState();

if(keyBtn) {
  keyBtn.addEventListener('click',function(){
    console.log("Клик по кнопке ключа");
    try {
      const cur=safeStorage.get('gemini_api_key')||'';
      if(cur){
        if(!confirm('Ключ уже сохранён. Удалить и ввести новый?'))return;
        safeStorage.remove('gemini_api_key');
        updateKeyBtnState();say('Ключ удалён.');return;
      }
      const key=prompt('Вставь API-ключ Google Gemini:');
      if(key===null)return;
      if(key.trim()===''){say('Ключ не введён.',true);return;}
      safeStorage.set('gemini_api_key',key.trim());
      updateKeyBtnState();say('Ключ сохранён.');
    } catch(err) {
      alert("Браузер заблокировал окно ввода (prompt). Нажмите F12 -> Консоль и вставьте: localStorage.setItem('gemini_api_key', 'ВАШ_КЛЮЧ')");
    }
  });
}

/* ====== DRAG & DROP ====== */
const dropZone=document.getElementById('drop-zone');
const fileInput=document.getElementById('file');
if(dropZone&&fileInput){
  ['dragenter','dragover'].forEach(ev=>dropZone.addEventListener(ev,e=>{
    e.preventDefault();e.stopPropagation();dropZone.classList.add('drag-over');
  },false));
  ['dragleave','dragend'].forEach(ev=>dropZone.addEventListener(ev,e=>{
    e.preventDefault();e.stopPropagation();dropZone.classList.remove('drag-over');
  },false));
  dropZone.addEventListener('drop',e=>{
    e.preventDefault();e.stopPropagation();dropZone.classList.remove('drag-over');
    const files=e.dataTransfer.files;
    if(files.length>0){
      try{const dt=new DataTransfer();dt.items.add(files[0]);fileInput.files=dt.files;}
      catch(err){fileInput.files=files;}
      fileInput.dispatchEvent(new Event('change',{bubbles:true}));
    }
  },false);
}
