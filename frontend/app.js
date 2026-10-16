import {connectAuth} from './auth.js';
import {createApi} from './api.js';

const $=selector=>document.querySelector(selector);
const labels={views:'조회수',viewers:'시청자',interactions:'상호작용',visits:'프로필 방문',follows:'팔로우',link_clicks:'링크 클릭'};
const trends={up:'증가',down:'감소',stable:'유지',insufficient_data:'비교 자료 부족'};
const state={user:null,contents:[],data:[],series:[],conversationId:null,draft:null,lastDraftId:null,dirty:false,busy:false,pending:null,limit:100};
const welcome=$('#messages').innerHTML;
let auth;
function notice(text,error=false){$('#notice').textContent=text;$('#notice').hidden=!text;$('#notice').classList.toggle('error',error);}
const api=createApi(()=>state.user,text=>notice(text));
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
const button=(text,handler,cls='secondary')=>{const b=el('button',text,cls);b.type='button';b.addEventListener('click',()=>run(handler,b));return b;};
async function run(handler,b){if(b)b.disabled=true;try{await handler();}catch(e){notice(e.message,true);}finally{if(b)b.disabled=false;}}
function bindForm(id,handler){$(id).addEventListener('submit',event=>{event.preventDefault();run(handler,event.submitter);});}
function storageKey(){return `content-studio:${state.user?.uid||state.user?.displayName}:conversation`;}
function saveActive(){if(state.conversationId)localStorage.setItem(storageKey(),state.conversationId);else localStorage.removeItem(storageKey());}
function show(view){
 if(state.dirty && !confirm('저장하지 않은 원고 수정이 있어요. 화면을 이동할까요? 편집 내용은 이 페이지에 유지됩니다.'))return;
 document.querySelectorAll('.view').forEach(s=>s.hidden=s.id!==`view-${view}`);
 document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
 if(view==='history')run(loadHistory);
}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>show(b.dataset.view)));
$('#theme').addEventListener('click',()=>{document.documentElement.classList.toggle('dark');localStorage.setItem('content-studio:theme',document.documentElement.classList.contains('dark')?'dark':'light');});
document.documentElement.classList.toggle('dark',localStorage.getItem('content-studio:theme')==='dark');
window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue='';}});
$('#new-chat').addEventListener('click',()=>{
 if(state.busy)return notice('현재 답변이 끝난 뒤 새 대화를 시작해 주세요.');
 state.conversationId=null;state.pending=null;state.lastDraftId=null;saveActive();$('#messages').innerHTML=welcome;wireSuggestions();$('#ideas').replaceChildren();$('#open-draft').hidden=true;notice('새 대화를 시작했어요.');
});
function wireSuggestions(){document.querySelectorAll('[data-prompt]').forEach(b=>b.addEventListener('click',()=>{$('#message').value=b.dataset.prompt;$('#mode').value=b.dataset.mode;$('#message').focus();}));}wireSuggestions();
function message(role,text,meta=''){
 const row=el('div',undefined,`message ${role}`);row.append(el('span',role==='user'?'나':'✦','avatar'));
 const body=el('div',text,'message-content');if(meta)body.append(el('small',meta));row.append(body);$('#messages').append(row);$('#messages').scrollTop=$('#messages').scrollHeight;
}
function selectedSources(){return [...document.querySelectorAll('[data-source]:checked')].map(c=>c.dataset.source);}
function renderSources(){
 const selected=new Set(selectedSources());$('#source-picker').replaceChildren();
 for(const c of state.contents){const label=el('label',undefined,'source-option');const check=el('input');check.type='checkbox';check.dataset.source=c.id;check.checked=selected.has(c.id);check.addEventListener('change',()=>{if(selectedSources().length>5){check.checked=false;notice('참고 원고는 최대 5개 선택할 수 있어요.',true);}});const text=el('span',c.title);text.append(el('small',`${c.kind==='review'?'검토 메모':'원고'} · ${c.publication_status==='published'?'게시함':'게시 미확인'} · 검토 미확인`));label.append(check,text);$('#source-picker').append(label);}
 if(!state.contents.length)$('#source-picker').append(el('p','아직 원고가 없어요. 라이브러리에 첫 원고를 추가해 주세요.','empty-small'));
}
function query(){const start=$('#filter-start').value,end=$('#filter-end').value;return start||end?`?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`:'';}
function number(value){return value===null||value===undefined?'—':Number(value).toLocaleString('ko-KR',{maximumFractionDigits:1});}
async function loadSummary(){
 const s=await api('/api/data/summary'+query());const metric=$('#filter-metric').value||'views';const m=s.metrics.views||{};
 $('#summary-period').textContent=s.period?`${s.period.start} – ${s.period.end}`:'기록을 추가하면 여기에 요약이 표시돼요.';
 $('#summary-average').textContent=number(m.average);$('#summary-count').textContent=`${m.count||0}개`;$('#summary-trend').textContent=trends[m.trend]||'데이터 없음';
 $('.context-card .tag').textContent=query()?'선택 기간':'최근 7일';
 $('#trend-chart').replaceChildren();const daily=(s.daily||[]).filter(d=>d.metric==='views');const valid=daily.map(d=>d.value).filter(v=>v!==null);const max=Math.max(...valid,1);
 const segment=[];const draw=()=>{if(!segment.length)return;const poly=document.createElementNS('http://www.w3.org/2000/svg','polyline');poly.setAttribute('points',segment.join(' '));poly.setAttribute('fill','none');poly.setAttribute('stroke','#7ea3c7');poly.setAttribute('stroke-width','2.5');$('#trend-chart').append(poly);segment.length=0;};
 daily.forEach((d,i)=>{if(d.value===null){draw();return;}segment.push(`${8+i*284/Math.max(daily.length-1,1)},${78-d.value/max*65}`);});draw();
 const v=s.metrics[metric]||{};$('#data-summary').replaceChildren();
 for(const [name,value] of [[`${labels[metric]} 평균`,number(v.average)],['최고',number(v.max)],['유효 관측 / 결측',`${v.count||0} / ${v.missing_count||0}`],['전기 대비 평균 변화',v.change_percent===null||v.change_percent===undefined?'계산 불가':number(v.change_percent)+'%']]){const node=el('div',undefined,'stat');node.append(el('small',name),el('strong',value));$('#data-summary').append(node);}
}
async function loadContents(){state.contents=await api('/api/contents');renderSources();$('#content-list').replaceChildren();for(const c of state.contents){const card=el('article',undefined,'card');card.append(el('h3',c.title),el('small',`${c.tags.join(' · ')} · 게시: ${c.publication_status} · 검토: ${c.review_status}`,'muted'),el('p',c.text.slice(0,220)+(c.text.length>220?'…':'')),el('small',`출처: ${c.source||'직접 입력 / 미확인'}`,'muted'));const actions=el('div',undefined,'actions');actions.append(button('수정',()=>{for(const [field,value] of Object.entries({id:c.id,title:c.title,text:c.text,tags:c.tags.join(', '),source:c.source||'',kind:c.kind,publication:c.publication_status,date:c.published_at||''}))$(`#content-${field}`).value=value;$('#content-title').focus();}),button('삭제',async()=>{if(!confirm('이 원고 자료를 삭제할까요? 기존 생성 원고는 유지됩니다.'))return;await api('/api/contents/'+c.id,{method:'DELETE'});await loadContents();notice('원고 자료를 삭제했어요.');}));card.append(actions);$('#content-list').append(card);}if(!state.contents.length)$('#content-list').append(el('p','첫 원고를 등록해 나만의 제작 맥락을 만들어 보세요.','empty-small'));}
bindForm('#content-form',async()=>{const id=$('#content-id').value;await api('/api/contents'+(id?'/'+id:''),{method:id?'PUT':'POST',body:{title:$('#content-title').value,text:$('#content-text').value,tags:$('#content-tags').value.split(',').map(s=>s.trim()).filter(Boolean),source:$('#content-source').value,kind:$('#content-kind').value,publication_status:$('#content-publication').value,published_at:$('#content-date').value||null}});$('#content-form').reset();$('#content-id').value='';await loadContents();notice('원고 자료를 저장했어요. 수정된 내용은 검토 미확인 상태입니다.');});
$('#content-reset').onclick=()=>{$('#content-form').reset();$('#content-id').value='';};
for(const select of ['#data-metric','#filter-metric']){for(const [value,label]of Object.entries(labels)){const option=el('option',label);option.value=value;$(select).append(option);}}
function resetData(){$('#data-form').reset();$('#data-id').value='';$('#data-date').disabled=false;$('#data-metric').disabled=false;}
function renderData(){
 $('#data-list').replaceChildren();const filtered=state.data.filter(d=>d.metric===$('#filter-metric').value);$('#data-total').textContent=`${filtered.length}개 기록`;$('#more-data').hidden=filtered.length<=state.limit;
 for(const d of filtered.slice(0,state.limit)){const tr=el('tr');for(const value of [d.date,labels[d.metric],d.value===null?'결측':number(d.value),d.memo])tr.append(el('td',value));const actions=el('td');actions.append(button('수정',()=>{$('#data-id').value=d.id;$('#data-date').value=d.date;$('#data-date').disabled=true;$('#data-metric').value=d.metric;$('#data-metric').disabled=true;$('#data-value').value=d.value??'';$('#data-memo').value=d.memo;}),button('삭제',async()=>{if(!confirm('이 데이터 기록을 삭제할까요?'))return;await api('/api/data/'+d.id,{method:'DELETE'});await loadData();notice('데이터를 삭제했어요.');}));tr.append(actions);$('#data-list').append(tr);}
 if(!filtered.length){const td=el('td','조건에 맞는 데이터가 없어요.');td.colSpan=5;const tr=el('tr');tr.append(td);$('#data-list').append(tr);}
}
async function loadData(){state.data=(await api('/api/data'+query())).reverse();renderData();await loadSummary();}
$('#more-data').onclick=()=>{state.limit+=100;renderData();};
bindForm('#data-form',async()=>{const id=$('#data-id').value;const body={value:$('#data-value').value===''?null:Number($('#data-value').value),memo:$('#data-memo').value};if(!id)Object.assign(body,{date:$('#data-date').value,metric:$('#data-metric').value});await api('/api/data'+(id?'/'+id:''),{method:id?'PUT':'POST',body});resetData();await loadData();notice('데이터를 저장하고 요약을 갱신했어요.');});
$('#data-reset').onclick=resetData;bindForm('#filter-form',async()=>{state.limit=100;await loadData();notice('선택 기간을 작업실 요약과 채팅에도 적용했어요.');});
$('#clear-filter').onclick=()=>run(async()=>{$('#filter-start').value='';$('#filter-end').value='';await loadData();});
function download(name,data,type='application/json'){const url=URL.createObjectURL(new Blob([typeof data==='string'?data:JSON.stringify(data,null,2)],{type}));const a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('#export-data').onclick=()=>download('account-data.json',state.data);
async function loadPreferences(){const [profile,series]=await Promise.all([api('/api/profile'),api('/api/series')]);$('#profile-instructions').value=profile.instructions;$('#style-preview').textContent=profile.instructions||'확인한 제작 선호가 아직 없어요.';state.series=series;const current=$('#series-select').value;$('#series-select').replaceChildren();const empty=el('option','일반 제작');empty.value='';$('#series-select').append(empty);$('#series-list').replaceChildren();for(const s of series){const opt=el('option',s.title);opt.value=s.id;$('#series-select').append(opt);const card=el('article',undefined,'card');card.append(el('h3',s.title),el('p',s.instructions),button('규칙 수정',()=>{$('#series-id').value=s.id;$('#series-title').value=s.title;$('#series-instructions').value=s.instructions;$('#series-confirm').checked=false;}));$('#series-list').append(card);}$('#series-select').value=current;}
bindForm('#profile-form',async()=>{await api('/api/profile',{method:'PUT',body:{instructions:$('#profile-instructions').value,confirmed:$('#profile-confirm').checked}});await loadPreferences();notice('확인한 제작 선호를 저장했어요. 다음 요청부터 반영돼요.');});
bindForm('#series-form',async()=>{const id=$('#series-id').value;await api('/api/series'+(id?'/'+id:''),{method:id?'PUT':'POST',body:{title:$('#series-title').value,instructions:$('#series-instructions').value,confirmed:$('#series-confirm').checked}});$('#series-form').reset();$('#series-id').value='';await loadPreferences();notice('시리즈 규칙을 저장했어요.');});
function renderIdeas(ideas){$('#ideas').replaceChildren();for(const [i,idea]of ideas.entries()){const item=el('article',undefined,'idea');item.append(el('span',`IDEA 0${i+1}`,'eyebrow'),el('h3',idea.title),el('p',idea.objective),el('p',`선행 개념: ${idea.prerequisites}\n기존 자료와의 관계: ${idea.relationship}\n추천 이유: ${idea.reason}`),button('이 주제로 원고 만들기',()=>send(idea),'primary'));$('#ideas').append(item);}}
async function send(idea=null){
 if(state.busy)return;
 const text=idea?`${idea.title} 주제로 카드뉴스와 퀴즈 초안을 만들어줘.`:$('#message').value.trim();if(!text)return;
 const request={request_id:crypto.randomUUID(),conversation_id:state.conversationId,mode:idea?'draft':$('#mode').value,message:text,selected_content_ids:selectedSources(),series_id:$('#series-select').value||null,card_count:Number($('#card-count').value),selected_idea:idea,start:$('#filter-start').value||null,end:$('#filter-end').value||null};
 const comparable=r=>JSON.stringify({...r,request_id:null});
 if(state.pending && comparable(state.pending)!==comparable(request)){notice('응답 확인이 안 된 요청이 있어요. 원래 입력 그대로 재시도하거나 새 대화를 시작하세요.',true);return;}
 const body=state.pending||request;state.pending=body;state.busy=true;$('#send').disabled=true;$('#loading').hidden=false;$('#save-state').textContent='생성 중 · 아직 저장되지 않았어요';
 try{
  const result=await api('/api/chat',{method:'POST',body});
  state.pending=null;state.conversationId=result.conversation_id;saveActive();
  if($('#messages .welcome'))$('#messages').replaceChildren();
  message('user',body.message);message('assistant',result.result.answer,result.result.source_ids.length?`참고 원고 ${result.result.source_ids.length}개 · 자동 저장됨`:'참고 원고 없음 · 자동 저장됨');
  if(!idea)$('#message').value='';renderIdeas(result.result.ideas);
  if(result.draft_id){state.lastDraftId=result.draft_id;$('#open-draft').hidden=false;await openDraft(result.draft_id);}
  $('#save-state').textContent='대화가 저장됐어요';notice('대화가 자동 저장됐어요.');
 }catch(error){$('#save-state').textContent='저장 완료를 확인하지 못했어요';if(error.status && error.status!==409)state.pending=null;throw error;}
 finally{state.busy=false;$('#send').disabled=false;$('#loading').hidden=true;}
}
bindForm('#chat-form',()=>send());
async function loadConversation(id){
 if(state.busy)throw new Error('현재 답변이 끝난 뒤 불러와 주세요.');
 const data=await api('/api/conversations/'+id);state.conversationId=id;state.pending=null;saveActive();$('#messages').replaceChildren();$('#ideas').replaceChildren();state.lastDraftId=null;
 for(const m of data.messages){message(m.role,m.content);if(m.result)renderIdeas(m.result.ideas);if(m.draft_id)state.lastDraftId=m.draft_id;}
 $('#open-draft').hidden=!state.lastDraftId;show('studio');notice('이전 대화를 불러왔어요.');
}
async function loadHistory(){
 const [history,drafts]=await Promise.all([api('/api/conversations'),api('/api/drafts')]);$('#history-list').replaceChildren();$('#draft-list').replaceChildren();
 for(const c of history){const card=el('article',undefined,'card');card.append(el('h3',c.title),el('small',`${new Date(c.updated_at).toLocaleString('ko-KR')} · 메시지 ${c.message_count}개`,'muted'));const actions=el('div',undefined,'actions');actions.append(button('불러오기',()=>loadConversation(c.id),'primary'),button('대화 삭제',async()=>{if(!confirm('대화와 메시지를 삭제할까요? 보관한 원고는 유지됩니다.'))return;await api('/api/conversations/'+c.id,{method:'DELETE'});if(state.conversationId===c.id){state.conversationId=null;saveActive();state.lastDraftId=null;$('#messages').innerHTML=welcome;wireSuggestions();$('#ideas').replaceChildren();$('#open-draft').hidden=true;}await loadHistory();notice('대화를 삭제했어요.');}));card.append(actions);$('#history-list').append(card);}
 if(!history.length)$('#history-list').append(el('p','아직 저장된 대화가 없어요. 작업실에서 첫 질문을 남겨 보세요.','empty-small'));
 for(const d of drafts){const card=el('article',undefined,'card');card.append(el('h3',d.draft.title),el('p',`버전 ${d.version} · ${d.status==='reviewed'?'사용자 검토 완료':'검토할 초안'}`),button('원고 열기',()=>openDraft(d.id)));$('#draft-list').append(card);}
}
function field(label,value,change,options={}){
 const wrapper=el('label',label);const input=el(options.multiline?'textarea':'input');if(options.multiline)input.rows=options.rows||3;input.value=value??'';input.maxLength=options.maxLength||4000;if(options.attr)input.setAttribute(options.attr,'');input.addEventListener('input',()=>{change(input.value);state.dirty=true;$('#draft-state').textContent='저장하지 않은 수정';});wrapper.append(input);return wrapper;
}
async function openDraft(id){
 if(state.dirty && state.draft?.id!==id && !confirm('현재 수정 내용을 버리고 다른 원고를 열까요?'))return;
 state.draft=await api('/api/drafts/'+id);state.dirty=false;renderDraft();
}
function renderDraft(){
 const d=state.draft.draft;document.querySelectorAll('.view').forEach(s=>s.hidden=true);$('#draft-editor').hidden=false;$('#draft-fields').replaceChildren();$('#draft-state').textContent=`v${state.draft.version} · ${state.draft.status==='reviewed'?'사용자 검토 완료':'검토할 초안'}`;
 const title=el('div',undefined,'card');title.append(field('제목',d.title,v=>d.title=v,{maxLength:200}),field('학습 목표',d.objective,v=>d.objective=v));$('#draft-fields').append(title);
 const cards=el('div',undefined,'draft-grid');d.cards.forEach((c,i)=>{const card=el('div',undefined,'card');card.append(el('span',`CARD ${String(i+1).padStart(2,'0')}`,'eyebrow'),field('카드 제목',c.title,v=>c.title=v,{maxLength:200}),field('본문',c.body,v=>c.body=v,{multiline:true,rows:4,attr:'data-card-body'}),field('수식 (LaTeX 원문)',c.formula,v=>c.formula=v,{maxLength:2000}),field('적용 조건',c.conditions,v=>c.conditions=v,{maxLength:2000}),field('도식 지시문',c.diagram,v=>c.diagram=v,{multiline:true,maxLength:2000}));cards.append(card);});$('#draft-fields').append(cards);
 const quiz=el('div',undefined,'card');quiz.append(el('h2','같은 개념의 퀴즈'),field('질문',d.quiz.question,v=>d.quiz.question=v,{multiline:true}));d.quiz.choices.forEach((c,i)=>quiz.append(field(`보기 ${i+1}`,c,v=>d.quiz.choices[i]=v)));const label=el('label','정답');const select=el('select');d.quiz.choices.forEach((_,i)=>{const opt=el('option',`보기 ${i+1}`);opt.value=String(i);select.append(opt);});select.value=String(d.quiz.answer_index);select.onchange=()=>{d.quiz.answer_index=Number(select.value);state.dirty=true;$('#draft-state').textContent='저장하지 않은 수정';};label.append(select);quiz.append(label,field('해설',d.quiz.explanation,v=>d.quiz.explanation=v,{multiline:true}));d.quiz.choice_explanations.forEach((c,i)=>quiz.append(field(`보기 ${i+1}의 판단 근거`,c,v=>d.quiz.choice_explanations[i]=v)));$('#draft-fields').append(quiz);
 const review=el('div',undefined,'card');review.append(el('h2','사람이 확인할 항목'));d.review_items.forEach(item=>review.append(el('p','□ '+item)));review.append(el('small',`참고 자료 ID: ${d.source_ids.join(', ')||'없음'}`,'muted'));$('#draft-fields').append(review);$('#draft-feedback').value='';
}
$('#open-draft').onclick=()=>run(()=>openDraft(state.lastDraftId));
$('#save-draft').onclick=()=>run(async()=>{state.draft=await api('/api/drafts/'+state.draft.id,{method:'PUT',body:{version:state.draft.version,draft:state.draft.draft,feedback:$('#draft-feedback').value}});state.dirty=false;renderDraft();notice('원고를 저장했어요.');},$('#save-draft'));
$('#review-draft').onclick=()=>run(async()=>{if(state.dirty)throw new Error('먼저 수정한 원고를 저장해 주세요.');if(!confirm('수식·조건·정답을 직접 검토했나요? AI 생성 성공과 별개의 확인입니다.'))return;state.draft=await api('/api/drafts/'+state.draft.id+'/review',{method:'POST',body:{version:state.draft.version,confirmed:true}});renderDraft();notice('사용자 검토 완료로 표시했어요.');});
$('#export-draft').onclick=()=>download('content-draft.json',state.draft.draft);
$('#export-markdown').onclick=()=>{const d=state.draft.draft;const text=`# ${d.title}\n\n${d.objective}\n\n`+d.cards.map((c,i)=>`## ${i+1}. ${c.title}\n\n${c.body}\n\n수식: ${c.formula}\n조건: ${c.conditions}\n도식: ${c.diagram}`).join('\n\n')+`\n\n## 퀴즈\n${d.quiz.question}\n`+d.quiz.choices.map((c,i)=>`${i+1}. ${c}`).join('\n')+`\n정답: ${d.quiz.answer_index+1}\n${d.quiz.explanation}\n`+d.quiz.choice_explanations.map((c,i)=>`보기 ${i+1}: ${c}`).join('\n')+'\n\n## 검토 항목\n'+d.review_items.map(c=>'- '+c).join('\n')+'\n\n참고 ID: '+d.source_ids.join(', ');download('content-draft.md',text,'text/markdown');};
$('#login').onclick=()=>run(async()=>{if(!auth)throw new Error('먼저 Firebase 웹 설정을 준비해 주세요. README에서 설정 방법을 확인할 수 있어요.');await auth.login();});
$('#logout').onclick=()=>run(async()=>{if(state.busy)throw new Error('답변 생성이 끝난 뒤 로그아웃해 주세요.');if(state.dirty && !confirm('저장하지 않은 원고가 있어요. 로그아웃할까요?'))return;await auth.logout();});
async function session(user){
 state.user=user;$('#login').hidden=!!user;$('#logout').hidden=!user;$('#user-name').textContent=user?.displayName||'개인 작업실';$('#setup').hidden=!!user;
 if(!user){state.contents=[];state.data=[];state.series=[];state.conversationId=null;state.draft=null;state.dirty=false;state.lastDraftId=null;state.pending=null;$('#messages').innerHTML=welcome;wireSuggestions();$('#ideas').replaceChildren();$('#draft-fields').replaceChildren();for(const id of ['content-list','history-list','draft-list','series-list','data-list'])$('#'+id).replaceChildren();$('#content-form').reset();resetData();$('#profile-form').reset();$('#series-form').reset();$('#message').value='';$('#open-draft').hidden=true;$('#summary-period').textContent='로그인 후 데이터가 표시돼요.';for(const id of ['summary-average','summary-count','summary-trend'])$('#'+id).textContent='—';$('#trend-chart').replaceChildren();$('#style-preview').textContent='확인한 제작 선호가 아직 없어요.';renderSources();show('studio');return;}
 try{await Promise.all([loadData(),loadContents(),loadPreferences()]);const id=localStorage.getItem(storageKey());if(id){try{await loadConversation(id);}catch(e){if(e.status===404)localStorage.removeItem(storageKey());else throw e;}}}catch(e){notice(e.message,true);}
}
try{auth=await connectAuth(session);}catch(e){$('#setup').hidden=false;notice(e.message,true);}
