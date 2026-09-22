import {SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY} from './config.js';
const {createClient}=window.supabase; const sb=createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY);
const $=s=>document.querySelector(s); const content=$('#content');
const pages={dashboard:['Dashboard','Keys99 residential platform overview'],projects:['Residential Projects','Manage projects and the 20-section project record'],developers:['Developers','Builder and developer master data'],locations:['Locations','Cities and localities'],agents:['Agents','Agent profiles and verification'],enquiries:['Enquiries','Residential project leads'],moderation:['Moderation','Review, approve and publish projects'],settings:['Settings','Admin account and application settings']};
let currentUser=null;
async function guard(){
 const {data:{session}}=await sb.auth.getSession();
 if(!session){location.replace('./login.html');return false}
 const {data:roles}=await sb.from('user_roles').select('role').eq('user_id',session.user.id);
 const allowed=roles?.some(r=>['admin','editor','moderator'].includes(r.role));
 if(!allowed){await sb.auth.signOut();location.replace('./login.html');return false}
 currentUser=session.user; $('#user-name').textContent=session.user.email||'Admin'; $('#role-badge').textContent=(roles.find(r=>r.role==='admin')?.role||roles[0]?.role||'admin').toUpperCase(); return true;
}
async function count(table,filter){let q=sb.from(table).select('*',{count:'exact',head:true});if(filter)q=filter(q);const r=await q;return r.count??0}
function status(s){return '<span class="status '+(s||'')+'">'+String(s||'—').replaceAll('_',' ')+'</span>'}
async function dashboard(){
 const [projects,developers,agents,enquiries,pending]=await Promise.all([
  count('residential_projects'),count('developers'),count('agents'),count('residential_enquiries'),
  count('residential_projects',q=>q.in('moderation_status',['pending_verification','under_review','changes_required','resubmitted']))
 ]);
 content.innerHTML=`<div class="cards">
 <div class="card"><div class="label">Residential Projects</div><div class="value">${projects}</div><div class="meta">All project records</div></div>
 <div class="card"><div class="label">Pending Moderation</div><div class="value">${pending}</div><div class="meta">Needs review</div></div>
 <div class="card"><div class="label">Developers</div><div class="value">${developers}</div><div class="meta">Builder master data</div></div>
 <div class="card"><div class="label">Enquiries</div><div class="value">${enquiries}</div><div class="meta">Residential leads</div></div>
 </div>
 <div class="grid-2">
 <div class="panel"><div class="panel-head"><h2>System architecture</h2></div><div class="notice">Admin UI is mapped to the current Supabase schema. All 21 public tables have RLS enabled. The browser uses only the publishable key; authorization is enforced by database RLS and user roles.</div></div>
 <div class="panel"><div class="panel-head"><h2>Residential workflow</h2></div><div class="notice">Draft → Pending Verification → Under Review → Changes Required / Resubmitted → Approved → Published. Moderation history is stored separately.</div></div>
 </div>`;
}
async function projects(){
 const {data,error}=await sb.from('residential_projects').select('id,project_code,project_name,project_type,status,moderation_status,slug,updated_at,developers(name),cities(name),localities(name)').order('updated_at',{ascending:false}).limit(100);
 content.innerHTML=`<div class="panel"><div class="panel-head"><h2>Residential Projects</h2><div class="toolbar"><input id="project-search" class="search" placeholder="Search projects"><button class="primary" id="new-project">+ Add Project</button></div></div>
 ${error?'<div class="error">'+error.message+'</div>':`<div class="table-wrap"><table class="table"><thead><tr><th>Project</th><th>Location</th><th>Type</th><th>Status</th><th>Moderation</th><th>Updated</th></tr></thead><tbody id="project-body">${(data||[]).map(p=>`<tr><td><strong>${escapeHtml(p.project_name)}</strong><br><small>${escapeHtml(p.project_code)}</small></td><td>${escapeHtml(p.localities?.name||'—')}, ${escapeHtml(p.cities?.name||'—')}</td><td>${escapeHtml(p.project_type||'—')}</td><td>${status(p.status)}</td><td>${status(p.moderation_status)}</td><td>${new Date(p.updated_at).toLocaleDateString()}</td></tr>`).join('')||'<tr><td colspan="6"><div class="empty">No residential projects yet.</div></td></tr>'}</tbody></table></div>`}</div>`;
 $('#new-project').onclick=()=>projectEditor();
}
function projectEditor(){
 const sections=['Basic Information','Project Location','Project Size & Scale','Project Status & Construction','Residential Configurations','Pricing & Cost','Apartment Specifications','Tower / Building Details','Amenities','Nearby Locations','Project Media','Pros & Cons','Project Documents','Litigation & Legal','Construction Updates','Project FAQ','Contact / Enquiry','SEO','Review & Submit','Publishing & Moderation'];
 content.innerHTML=`<div class="panel"><div class="panel-head"><div><h2>Add Residential Project</h2><div class="muted">Structured to match the residential_projects parent record and all child tables.</div></div><button class="btn" id="back-projects">← Back</button></div>
 <div class="tabs" id="project-tabs">${sections.map((s,i)=>`<button class="tab ${i===0?'active':''}" data-i="${i}">${i+1}. ${s}</button>`).join('')}</div>
 <div id="project-section" class="panel" style="margin-top:12px"></div></div>`;
 const render=i=>{document.querySelectorAll('.tab').forEach((b,j)=>b.classList.toggle('active',j===i)); const target=$('#project-section'); if(i===0)target.innerHTML=basicForm(); else target.innerHTML=`<div class="notice"><strong>${sections[i]}</strong><br><br>This section is intentionally mapped to the current Supabase schema and will be implemented as a structured child editor. No flat JSON blob will be used.</div>`;};
 document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>render(Number(b.dataset.i))); $('#back-projects').onclick=projects; render(0);
}
function basicForm(){return `<div class="form-grid">
<div class="field"><label>Project Name *</label><input id="project_name" required></div>
<div class="field"><label>Project Code *</label><input id="project_code" placeholder="RES-PUN-00001"></div>
<div class="field"><label>Project Type *</label><select id="project_type"><option value="apartment">Apartment</option><option value="villa">Villa</option><option value="row_house">Row House</option><option value="townhouse">Townhouse</option><option value="residential_plot">Residential Plot</option><option value="independent_house">Independent House</option><option value="mixed_residential">Mixed Residential</option><option value="other">Other</option></select></div>
<div class="field"><label>Project Status *</label><select id="status"><option value="upcoming">Upcoming</option><option value="under_construction">Under Construction</option><option value="ready_to_move">Ready to Move</option><option value="completed">Completed</option></select></div>
<div class="field full"><label>Project Overview *</label><textarea id="overview"></textarea></div>
<div class="field full"><label>Project Highlights</label><textarea id="highlights" placeholder="One highlight per line"></textarea></div>
</div><div style="margin-top:16px"><div class="notice">Location, developer, media and child records are saved through their related tables. This initial editor is the shell; we will add each structured section without changing the database contract.</div></div>`;}
function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function generic(page){
 const map={developers:['developers','Name','name,verified,status'],agents:['agents','Full Name','full_name,verified,status'],enquiries:['residential_enquiries','Contact Person','contact_person,phone,status'],locations:['cities','City','name,state,is_active']};
 const [table]=[map[page][0]]; const {data,error}=await sb.from(table).select('*').limit(100).order('created_at',{ascending:false});
 content.innerHTML=`<div class="panel"><div class="panel-head"><h2>${pages[page][0]}</h2></div>${error?'<div class="error">'+error.message+'</div>':`<div class="table-wrap"><table class="table"><thead><tr>${map[page][2].split(',').map(x=>'<th>'+x.replaceAll('_',' ')+'</th>').join('')}</tr></thead><tbody>${(data||[]).map(row=>'<tr>'+map[page][2].split(',').map(x=>'<td>'+escapeHtml(row[x])+'</td>').join('')+'</tr>').join('')||'<tr><td colspan="5"><div class="empty">No records yet.</div></td></tr>'}</tbody></table></div>`}</div>`;
}
async function moderation(){const {data}=await sb.from('residential_projects').select('project_code,project_name,moderation_status,updated_at').in('moderation_status',['pending_verification','under_review','changes_required','resubmitted']).order('updated_at',{ascending:false});content.innerHTML=`<div class="panel"><div class="panel-head"><h2>Moderation Queue</h2></div><div class="table-wrap"><table class="table"><thead><tr><th>Project</th><th>Status</th><th>Updated</th></tr></thead><tbody>${(data||[]).map(p=>`<tr><td><strong>${escapeHtml(p.project_name)}</strong><br><small>${escapeHtml(p.project_code)}</small></td><td>${status(p.moderation_status)}</td><td>${new Date(p.updated_at).toLocaleString()}</td></tr>`).join('')||'<tr><td colspan="3"><div class="empty">Moderation queue is empty.</div></td></tr>'}</tbody></table></div></div>`}
function settings(){content.innerHTML='<div class="panel"><div class="panel-head"><h2>Settings</h2></div><div class="notice">Authentication and authorization are controlled by Supabase Auth and the user_roles table. No service-role key is stored in this frontend.</div></div>'}
async function navigate(page){if(!pages[page])page='dashboard';$('#page-title').textContent=pages[page][0];$('#page-subtitle').textContent=pages[page][1];document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.page===page));if(page==='dashboard')return dashboard();if(page==='projects')return projects();if(page==='moderation')return moderation();if(page==='settings')return settings();return generic(page)}
document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>navigate(b.dataset.page));$('#mobile-menu').onclick=()=>$('.sidebar').classList.toggle('open');$('#logout-btn').onclick=async()=>{await sb.auth.signOut();location.replace('./login.html')};
if(await guard())navigate('dashboard');
