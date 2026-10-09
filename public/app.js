const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
let currentUser = null;
let activeAuthMode = 'login';
let currentMaterials = [];
let currentSubjects = [];
let searchTimer;
let libraryRequestId = 0;
let confirmAction = null;
const dateFmt = value => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
const sizeFmt = n => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (response.status === 401 && currentUser) {
    showAuth();
    closeUpload();
    $('#confirm-modal').classList.add('hidden');
    confirmAction = null;
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
let toastTimeout;
function toast(message, type = 'success') {
  const el = $('#toast'); el.textContent = message; el.className = `toast show ${type === 'error' ? 'error' : ''}`;
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => el.classList.remove('show'), 3200);
}
function setBusy(button, busy, text) { button.disabled = busy; if (busy) { button.dataset.oldText = button.innerHTML; button.textContent = text || 'Please wait…'; } else if (button.dataset.oldText) { button.innerHTML = button.dataset.oldText; delete button.dataset.oldText; } }
function switchAuth(mode) {
  activeAuthMode = mode;
  const register = mode === 'register';
  $('#login-tab').classList.toggle('active', !register); $('#register-tab').classList.toggle('active', register);
  $('#name-wrap').classList.toggle('hidden', !register); $('#name').required = register;
  $('#auth-title').textContent = register ? 'Your next chapter starts here.' : 'Good to have you back.';
  $('#auth-subtitle').textContent = register ? 'Create your student account in a moment.' : 'Sign in to pick up where you left off.';
  $('#auth-submit').innerHTML = register ? 'Create account <span>↗</span>' : 'Sign in <span>↗</span>';
  $('#auth-note').textContent = register ? 'Student accounts only. Administrator access is configured by the owner.' : 'Student? Create an account to get started. Admin accounts are configured by the owner.';
  $('#password').autocomplete = register ? 'new-password' : 'current-password';
}
function showApp(user) {
  currentUser = user; $('#auth-view').classList.add('hidden'); $('#app-view').classList.remove('hidden');
  const initial = (user.name || 'S').trim().charAt(0).toUpperCase();
  $('#profile-avatar').textContent = initial; $('#top-avatar').textContent = initial; $('#profile-name').textContent = user.name; $('#profile-role').textContent = user.role === 'admin' ? 'Administrator' : 'Student account';
  $$('.admin-nav,.admin-only').forEach(el => el.classList.toggle('hidden', user.role !== 'admin'));
  $('#library-count').textContent = currentMaterials.length;
  navigate('library'); loadLibrary();
}
function showAuth() { libraryRequestId++; currentUser = null; $('#app-view').classList.add('hidden'); $('#auth-view').classList.remove('hidden'); $('#auth-form').reset(); switchAuth('login'); }
function navigate(page) {
  if (page === 'admin' && currentUser?.role !== 'admin') page = 'library';
  ['library', 'bookmarks', 'admin'].forEach(p => $(`#${p}-page`).classList.toggle('hidden', p !== page));
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $('#page-crumb').textContent = page === 'library' ? 'Library' : page === 'bookmarks' ? 'My bookmarks' : 'Admin dashboard';
  $('#sidebar').classList.remove('open');
  if (page === 'library') loadLibrary(); if (page === 'bookmarks') loadBookmarks(); if (page === 'admin') loadAdmin();
}
function cardHtml(m) {
  return `<article class="material-card"><div class="card-top"><div class="file-badge">PDF</div><span class="subject-tag" title="${esc(m.subject)}">${esc(m.subject)}</span></div><div class="card-top" style="margin-top:-8px;margin-bottom:10px"><span style="font-size:9px;color:#9ba3af">${esc(sizeFmt(m.size || 0))}</span><button class="bookmark-btn ${m.bookmarked ? 'saved' : ''}" data-bookmark="${esc(m.id)}" aria-label="${m.bookmarked ? 'Remove bookmark' : 'Bookmark material'}" title="${m.bookmarked ? 'Remove bookmark' : 'Bookmark material'}">${m.bookmarked ? '♥' : '♡'}</button></div><h3>${esc(m.title)}</h3><p class="material-description">${esc(m.description || 'No description provided for this resource.')}</p><div class="card-meta"><span>Added ${esc(dateFmt(m.createdAt))}</span><span title="${esc(m.uploadedByName)}">${esc(m.uploadedByName || 'StudyHub')}</span></div><div class="card-actions"><a class="open-pdf" href="/api/materials/${encodeURIComponent(m.id)}/pdf" target="_blank" rel="noopener">Open PDF ↗</a>${currentUser?.role === 'admin' ? `<button class="delete-material" data-delete-material="${esc(m.id)}">Delete</button>` : ''}</div></article>`;
}
function renderCards(target, empty, materials) {
  $(target).innerHTML = materials.map(cardHtml).join(''); $(empty).classList.toggle('hidden', materials.length > 0);
}
function updateStats(materials, subjects) {
  $('#stat-materials').textContent = materials.length; $('#stat-subjects').textContent = subjects.length; $('#stat-bookmarks').textContent = materials.filter(m => m.bookmarked).length;
  $('#material-total').textContent = materials.length; $('#library-count').textContent = materials.length;
}
async function loadLibrary() {
  if (!currentUser) return;
  const requestId = ++libraryRequestId;
  const userId = currentUser.id;
  try {
    const q = $('#search-input').value.trim(); const subject = $('#subject-filter').value;
    const data = await api(`/api/materials?q=${encodeURIComponent(q)}&subject=${encodeURIComponent(subject)}`);
    if (requestId !== libraryRequestId || currentUser?.id !== userId) return;
    currentMaterials = data.materials; currentSubjects = data.subjects;
    const filter = $('#subject-filter'); const old = filter.value;
    filter.innerHTML = '<option value="">All subjects</option>' + currentSubjects.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if (currentSubjects.includes(old)) filter.value = old;
    updateStats(currentMaterials, currentSubjects); $('#results-label').textContent = q || subject ? 'Search results' : 'All materials'; $('#results-count').textContent = `${currentMaterials.length} ${currentMaterials.length === 1 ? 'result' : 'results'}`;
    renderCards('#material-grid', '#empty-state', currentMaterials);
    if ($('#bookmarks-page').classList.contains('hidden') === false) loadBookmarks();
  } catch (e) { if (requestId === libraryRequestId) toast(e.message, 'error'); }
}
async function loadBookmarks() {
  if (!currentUser) return;
  try { const data = await api('/api/materials?bookmarked=true'); renderCards('#bookmark-grid', '#bookmark-empty', data.materials); }
  catch (e) { toast(e.message, 'error'); }
}
async function loadAdmin() {
  if (currentUser?.role !== 'admin') return;
  try {
    const [summary, users, materials] = await Promise.all([api('/api/admin/summary'), api('/api/admin/users'), api('/api/materials')]);
    $('#admin-stats').innerHTML = [['TOTAL USERS', summary.users], ['STUDENTS', summary.students], ['RESOURCES', summary.materials], ['SUBJECTS', summary.subjects]].map(([label, value]) => `<div class="admin-stat"><span>${label}</span><strong>${value}</strong></div>`).join('');
    $('#user-count-badge').textContent = `${users.users.length} users`;
    $('#admin-user-list').innerHTML = users.users.length ? users.users.map(u => `<div class="user-row"><div class="avatar">${esc(u.name.charAt(0).toUpperCase())}</div><div class="user-details"><strong>${esc(u.name)}</strong><span>${esc(u.email)}</span></div><span class="role-chip">${esc(u.role)}</span>${u.id !== currentUser.id ? `<button class="user-remove" data-delete-user="${esc(u.id)}" title="Delete user">Remove</button>` : ''}</div>`).join('') : '<div class="admin-empty">No users yet.</div>';
    const latest = materials.materials.slice(0, 8);
    $('#admin-material-rows').innerHTML = latest.length ? latest.map(m => `<tr><td title="${esc(m.title)}">${esc(m.title)}</td><td>${esc(m.subject)}</td><td>${esc(dateFmt(m.createdAt))}</td><td><button class="table-delete" data-delete-material="${esc(m.id)}">Delete</button></td></tr>`).join('') : '<tr><td colspan="4">No materials uploaded yet.</td></tr>';
  } catch (e) { toast(e.message, 'error'); }
}
function openUpload() { if (currentUser?.role !== 'admin') return toast('Administrator access required.', 'error'); $('#upload-modal').classList.remove('hidden'); $('#upload-form').reset(); $('#file-label').textContent = 'Choose a PDF to upload'; $('#upload-title').focus?.(); }
function closeUpload() { $('#upload-modal').classList.add('hidden'); }
function askConfirm({ title, copy, action, label = 'Delete' }) {
  $('#confirm-title').textContent = title; $('#confirm-copy').textContent = copy; $('#confirm-yes').textContent = label; confirmAction = action; $('#confirm-modal').classList.remove('hidden');
}
async function handleDeleteMaterial(id) {
  try { await api(`/api/materials/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('Material deleted.'); await loadLibrary(); await loadAdmin(); }
  catch (e) { toast(e.message, 'error'); }
}
async function handleDeleteUser(id) {
  try { await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('User removed.'); await loadAdmin(); }
  catch (e) { toast(e.message, 'error'); }
}
$('#login-tab').addEventListener('click', () => switchAuth('login'));
$('#register-tab').addEventListener('click', () => switchAuth('register'));
$('#auth-form').addEventListener('submit', async e => {
  e.preventDefault(); const button = $('#auth-submit'); setBusy(button, true, 'Please wait…');
  try {
    const payload = { email: $('#email').value, password: $('#password').value };
    if (activeAuthMode === 'register') payload.name = $('#name').value;
    const data = await api(`/api/auth/${activeAuthMode === 'register' ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(payload) });
    showApp(data.user); toast(activeAuthMode === 'register' ? 'Account created. Welcome to StudyHub!' : `Welcome back, ${data.user.name.split(' ')[0]}.`);
  } catch (err) { toast(err.message, 'error'); }
  finally { setBusy(button, false); }
});
$('#logout-btn').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST' }); showAuth(); } catch (e) { toast(e.message, 'error'); } });
$$('.nav-item').forEach(b => b.addEventListener('click', () => navigate(b.dataset.page)));
$$('[data-go-library]').forEach(b => b.addEventListener('click', () => navigate('library')));
$('#search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadLibrary, 180); });
$('#subject-filter').addEventListener('change', loadLibrary);
$('#clear-filters').addEventListener('click', () => { $('#search-input').value = ''; $('#subject-filter').value = ''; loadLibrary(); });
$('#empty-clear').addEventListener('click', () => $('#clear-filters').click());
$('#upload-open').addEventListener('click', openUpload); $('#admin-upload-open').addEventListener('click', openUpload);
$('#upload-close').addEventListener('click', closeUpload); $('#upload-cancel').addEventListener('click', closeUpload);
$('#upload-modal').addEventListener('click', e => { if (e.target === $('#upload-modal')) closeUpload(); });
$('#pdf-file').addEventListener('change', () => { const f = $('#pdf-file').files[0]; $('#file-label').textContent = f ? `${f.name} · ${sizeFmt(f.size)}` : 'Choose a PDF to upload'; });
$('#upload-form').addEventListener('submit', async e => {
  e.preventDefault(); const file = $('#pdf-file').files[0];
  if (!file || (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf')) return toast('Choose a valid PDF file.', 'error');
  if (file.size > 20 * 1024 * 1024) return toast('PDF must be 20 MB or smaller.', 'error');
  const button = $('#upload-submit'); setBusy(button, true, 'Uploading…');
  try { const form = new FormData(e.currentTarget); await api('/api/materials', { method: 'POST', body: form }); toast('Study material uploaded successfully.'); closeUpload(); await loadLibrary(); await loadAdmin(); }
  catch (err) { toast(err.message, 'error'); }
  finally { setBusy(button, false); }
});
document.addEventListener('click', async e => {
  const bookmark = e.target.closest('[data-bookmark]');
  if (bookmark) { try { await api(`/api/materials/${encodeURIComponent(bookmark.dataset.bookmark)}/bookmark`, { method: 'POST' }); await loadLibrary(); if (!$('#bookmarks-page').classList.contains('hidden')) await loadBookmarks(); }
    catch (err) { toast(err.message, 'error'); } return; }
  const delMaterial = e.target.closest('[data-delete-material]');
  if (delMaterial) { const id = delMaterial.dataset.deleteMaterial; const material = currentMaterials.find(m => m.id === id); askConfirm({ title: 'Delete this material?', copy: `“${material?.title || 'This material'}” and its uploaded PDF will be permanently removed.`, action: () => handleDeleteMaterial(id) }); return; }
  const delUser = e.target.closest('[data-delete-user]');
  if (delUser) { const id = delUser.dataset.deleteUser; const name = $(`[data-delete-user="${CSS.escape(id)}"]`)?.closest('.user-row')?.querySelector('.user-details strong')?.textContent || 'this user'; askConfirm({ title: 'Remove this account?', copy: `${name} will lose access to StudyHub. This action cannot be undone.`, action: () => handleDeleteUser(id) }); }
});
$('#confirm-cancel').addEventListener('click', () => { $('#confirm-modal').classList.add('hidden'); confirmAction = null; });
$('#confirm-yes').addEventListener('click', async () => { const action = confirmAction; $('#confirm-modal').classList.add('hidden'); confirmAction = null; if (action) await action(); });
$('#mobile-menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#search-input').focus(); } if (e.key === 'Escape') { closeUpload(); $('#confirm-modal').classList.add('hidden'); $('#sidebar').classList.remove('open'); } });
(async function init() {
  try { const data = await api('/api/auth/me'); if (data.user) showApp(data.user); else showAuth(); }
  catch { showAuth(); }
})();
