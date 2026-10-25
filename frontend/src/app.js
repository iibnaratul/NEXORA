// NEXORA frontend — same interface as the original single-file build, rewired
// to the real backend. No window.claude, no localStorage identity, no mock
// data: every action is an API call, every list comes from the database.
// The only localStorage keys left are the theme preference (harmless) and
// nothing else. Session lives in an HttpOnly cookie.
import { api, initCsrf } from './api.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const T = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const STATES = ['CREATED', 'SEARCHING_FOR_COURIER', 'ASSIGNED', 'ACCEPTED', 'PICKUP_VERIFIED', 'IN_TRANSIT', 'DROPOFF_VERIFIED', 'DELIVERED'];
const STATE_LABEL = {
  CREATED: 'Created', SEARCHING_FOR_COURIER: 'Looking for courier', ASSIGNED: 'Courier assigned',
  ACCEPTED: 'Accepted by courier', PICKUP_VERIFIED: 'Picked up', IN_TRANSIT: 'In transit',
  DROPOFF_VERIFIED: 'Drop-off verified', DELIVERED: 'Delivered', CANCELLED: 'Cancelled',
};
const CANCELLABLE = ['CREATED', 'SEARCHING_FOR_COURIER', 'ASSIGNED', 'ACCEPTED'];
const GL = ['◈', '⬡', '✦', '⌬', '◬', '⎔', '✧', '⟁'];

let me = null, backendDown = false, health = null;
let th = localStorage.getItem('nx_th') || 'auto';
let blk = [];
const S = {
  tab: 'chats', convs: null, conv: null, msgs: null, msgPage: 1, msgPages: 1,
  reply: null, sel: null, editing: null, filt: 'all', dt: 'queue', oid: null,
  form: null, off: !navigator.onLine, unread: 0, courier: null, codes: null,
  history: null, routeNote: null, route: null, photoFile: null, photoPreview: null,
  pickupLoc: null, dropoffLoc: null, busy: false, confirmDelete: false,
};
let socket = null;

const setTh = () => {
  const r = document.documentElement;
  th === 'auto' ? r.removeAttribute('data-theme') : (r.dataset.theme = th);
};
setTh();
function toast(m) {
  const t = $('#t'); t.textContent = m; t.hidden = false;
  clearTimeout(toast.i); toast.i = setTimeout(() => (t.hidden = true), 4000);
}
// Avatar border hue is per-user and dynamic, so it cannot be a static CSS
// class. It travels as data-hue and is applied via CSSOM (allowed under the
// style-src 'self' CSP, unlike an inline style attribute) by
// applyDynamicStyles() after each render.
const av = (glyph, nexoraId) =>
  `<span class="av" data-hue="${[...(nexoraId || '')].reduce((a, c) => a + c.charCodeAt(0), 0) * 7 % 360}">${esc(glyph || '◇')}</span>`;
function applyDynamicStyles() {
  document.querySelectorAll('[data-hue]').forEach((el) => { el.style.borderColor = `hsl(${el.dataset.hue} 90% 60%)`; });
}
// CSP-safe replacement for the QR <img> inline onerror: hide a QR image that
// fails to load. Capture phase, because img error events do not bubble.
document.addEventListener('error', (e) => {
  if (e.target?.classList?.contains('qr-img')) e.target.style.display = 'none';
}, true);
const NAV = [['chats', '◈', 'Chats'], ['delivery', '⬡', 'Delivery'], ['activity', '◬', 'Activity'], ['profile', '⌬', 'Profile']];

function nav() {
  $('#n').innerHTML = NAV.map(([k, i, l]) =>
    `<button data-a="tab" data-k="${k}" class="${S.tab === k ? 'on' : ''}" aria-label="${l}"><b>${i}</b>${l}${k === 'activity' && S.unread ? ` <span class="dot"></span>` : ''}</button>`).join('');
}
function banner() {
  return (backendDown ? '<div class="ban">Backend unavailable — is the server running (npm start) with DATABASE_URL set? Nothing is saved until it is back.</div>' : '')
    + (S.off ? '<div class="ban">Offline — messages and updates can’t be sent until you reconnect.</div>' : '')
    + (health && !health.maps?.configured ? '' : '');
}
function typeBadge(c) {
  return c.type === 'dm' ? '<span class="tag">DM</span>' : c.type === 'group' ? '<span class="tag">Group</span>' : '<span class="tag">Room</span>';
}
function convTitle(c) {
  if (c.type !== 'dm') return c.name || 'Untitled';
  const other = (c.members || []).find((m) => m.id !== me?.id);
  return other ? (other.display_name || other.nexora_id) : 'Direct message';
}

async function refreshUnread() {
  try { S.unread = (await api.unreadCount()).data.unread; } catch { /* ignore */ }
  nav();
}

function render() {
  nav();
  const v = $('#v');
  if (!me) return authView(v);
  if (S.tab === 'chats') return S.conv ? convView() : listView(v);
  if (S.tab === 'delivery') return S.oid ? odetail(v) : S.form ? oform(v) : dlv(v);
  if (S.tab === 'activity') return act2(v);
  prof(v);
}

// ---------- auth ----------
function authView(v) {
  v.innerHTML = `<h1><span></span>NEXORA</h1>${banner()}
  <div class="c"><b>Welcome to NEXORA</b><br><small>Chat and parcel delivery with a server-issued pseudonymous ID. No real name, email or phone is required for an anonymous account.</small><br><br>
  <button class="b" data-a="anon">Continue anonymously</button><br><br>
  <small>Anonymous means pseudonymous, not untraceable: accounts can still be moderated for abuse. Messages are <b>not</b> end-to-end encrypted.</small></div>
  <div class="c"><b>Sign in</b><input id="li-e" type="email" placeholder="Email" aria-label="Email"><input id="li-p" type="password" placeholder="Password" aria-label="Password"><button class="b" data-a="login">Sign in</button></div>
  <div class="c"><b>Create account</b><input id="rg-e" type="email" placeholder="Email" aria-label="Email"><input id="rg-p" type="password" placeholder="Password (min 10 characters)" aria-label="Password"><input id="rg-n" maxlength="24" placeholder="Display name (optional)" aria-label="Display name"><button class="b" data-a="register">Create account</button></div>`;
}

// ---------- chats ----------
function listView(v) {
  const rs = S.convs;
  v.innerHTML = `<h1><span></span>NEXORA</h1>${banner()}
  <div class="row"><h2 class="f">Chats</h2><button class="b" data-a="nr">+ New</button></div>` +
    (S.form === 'conv' ? `<div class="c">
      <label>Type<select id="cf-type"><option value="room">Public room</option><option value="group">Private group</option><option value="dm">Direct message</option></select></label>
      <input id="cf-name" maxlength="40" placeholder="Name (room / group)" aria-label="Name">
      <input id="cf-members" maxlength="400" placeholder="Member NEXORA IDs, comma separated (group / DM)" aria-label="Members">
      <button class="b" data-a="mkconv">Create</button> <button class="b g" data-a="nr0">Cancel</button><br>
      <small>Rooms are public to signed-in users. Groups and DMs are private to members only.</small></div>` : '') +
    (rs === null ? '<div class="sk"></div><div class="sk"></div>'
      : !rs.length ? '<div class="c mu">No chats yet. Create the first one.</div>'
      : rs.map((r) => `<button class="c" data-a="open" data-id="${esc(r.id)}"><b>${esc(r.type === 'dm' ? (r.dm_partner || 'Direct message') : (r.name || 'Untitled'))}</b>${typeBadge(r)}${r.unread ? `<span class="tag">${r.unread} new</span>` : ''}<br><small>${esc(r.description || '')} · ${r.updated_at ? 'active ' + T(r.updated_at) : 'no messages'}</small></button>`).join('')); 
}

function convView() {
  const r = S.conv;
  $('#v').innerHTML = `<div class="col-full">
  <div class="row"><button class="b g" data-a="back" aria-label="Back">←</button><div class="f"><b>${esc(convTitle(r))}</b><br><small>${r.type === 'room' ? 'Public room' : r.type === 'group' ? 'Private group' : 'Private conversation'}</small></div>
  ${r.type !== 'dm' ? `<button class="b g" data-a="leave">Leave</button>` : ''}</div>
  ${banner()}<div id="ml" aria-live="polite"></div><div id="rp"></div>
  <div class="row"><input id="in" class="f" maxlength="2000" placeholder="Message as ${esc(me.displayName || me.nexoraId)}" aria-label="Message">
  <label class="b g ptr">📎<input id="af" type="file" hidden></label>
  <button class="b" data-a="send">Send</button></div>
  ${r.type === 'group' ? `<div class="row mt8"><input id="am" class="f" placeholder="Add member NEXORA ID" aria-label="Add member"><button class="b g" data-a="addm">Add</button></div>` : ''}</div>`;
  $('#in').addEventListener('keydown', (e) => { if (e.key === 'Enter') act.send(); });
  $('#af').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const up = await api.uploadToConversation(r.id, f);
      toast('File attached — send a message to deliver it.');
      S.pendingAttachment = up.data.id; S.pendingAttachmentName = f.name;
    } catch (err) { toast('Upload failed: ' + err.message); }
  });
  draw();
}

function draw() {
  const ml = $('#ml'); if (!ml) return;
  const near = ml.scrollHeight - ml.scrollTop - ml.clientHeight < 80;
  ml.innerHTML = S.msgs === null ? '<div class="sk"></div>'
    : !S.msgs.length ? '<div class="mu empty-note">No messages yet. Say hello.</div>'
    : S.msgs.map((m) => {
      const mine = m.senderId === me.id, o = S.sel === m.id;
      const body = S.editing === m.id
        ? `<input id="ed" class="f" maxlength="2000" value="${esc(m.body)}"><button class="b" data-a="saveedit" data-id="${m.id}">Save</button>`
        : `<div>${esc(m.body)}</div>`;
      const atts = (m.attachments || []).map((a) =>
        `<div><small>📎 <a href="${esc(a.downloadUrl)}" target="_blank" rel="noopener">${esc(a.originalName)}</a></small></div>`).join('');
      return `<div class="m ${mine ? 'me' : ''}" data-a="sel" data-id="${m.id}"><small>${esc(m.senderName || m.senderNexoraId)} · ${T(m.createdAt)}${m.editedAt ? ' · edited' : ''}</small>
        ${m.replyToId ? `<div class="re">reply</div>` : ''}${body}${atts}
        ${o ? `<div class="row mt6"><button class="b g" data-a="reply" data-id="${m.id}">Reply</button>
          ${mine ? `<button class="b g" data-a="edit" data-id="${m.id}">Edit</button><button class="b r" data-a="del" data-id="${m.id}">Delete</button>`
            : `<button class="b r" data-a="block" data-h="${esc(m.senderNexoraId)}">Block</button>`}</div>` : ''}</div>`;
    }).join('')
    + (S.msgPage < S.msgPages ? `<button class="b g mt8" data-a="older">Load older messages</button>` : '');
  if (near) ml.scrollTop = ml.scrollHeight;
  $('#rp').innerHTML = S.reply ? `<small>Replying to ${esc(S.reply.senderName || S.reply.senderNexoraId)}: ${esc(S.reply.body.slice(0, 50))} <a href="#" data-a="xr">✕</a></small>`
    : (S.pendingAttachment ? `<small>📎 Attached: ${esc(S.pendingAttachmentName)} — send a message to deliver it.</small>` : '');
}

// ---------- delivery ----------
function dlv(v) {
  const o = S.orders, q = (o || []).filter((x) => x.status === 'SEARCHING_FOR_COURIER');
  const m = (o || []).filter((x) => x.sender_id === me.id || x.courier_id === me.id);
  const l = S.dt === 'queue' ? q : m;
  v.innerHTML = `<h1><span></span>NEXORA TRANSIT</h1>${banner()}
  <div class="c"><small>${health?.maps?.configured ? 'Routes: a distance/duration for an order is shown on its detail page when that order has coordinates.' : 'Tracking: <b>unavailable</b> — no map, geocoding or live-location provider is configured, so no positions or ETAs are shown.'} Status below comes only from recorded events. No payments are processed. There is no live tracking: a courier’s position is never followed.</small></div>
  <div class="row"><button class="b ${S.dt === 'queue' ? '' : 'g'}" data-a="dt" data-k="queue">Queue (${q.length})</button><button class="b ${S.dt === 'mine' ? '' : 'g'}" data-a="dt" data-k="mine">My orders (${m.length})</button><span class="f"></span><button class="b" data-a="no">+ Order</button></div>
  <h2>${S.dt === 'queue' ? 'Open for couriers' : 'Sent / carrying'}</h2>` +
    (o === null ? '<div class="sk"></div>'
      : S.dt === 'queue' && !S.courier ? '<div class="c mu">The queue is for registered couriers. Register as a courier from your Profile to browse open orders.</div>'
      : !l.length ? '<div class="c mu">Nothing here yet.</div>'
      : l.map((x) => `<button class="c" data-a="od" data-id="${esc(x.id)}"><b>${esc(x.name)}</b>${x.fragile ? '<span class="tag w">fragile</span>' : ''}<span class="tag">${STATE_LABEL[x.status] || x.status}</span>${x.disputed ? '<span class="tag w">DISPUTED</span>' : ''}<br><small>${esc(x.pickup_area)} → ${esc(x.dropoff_area)} · ${esc(x.size)} · offered ${esc(x.fee_offer || 0)} (not charged)</small></button>`).join(''));
}

function oform(v) {
  v.innerHTML = `<h1><span></span>NEW TRANSIT ORDER</h1>${banner()}<div class="c">
  <label>Parcel name<input id="f1" maxlength="60"></label>
  <label>Category<select id="f2"><option>Documents</option><option>Small goods</option><option>Clothing</option><option>Electronics</option><option>Other</option></select></label>
  <label>Size<select id="f3"><option>Small (fits a bag)</option><option>Medium (box)</option><option>Large</option></select></label>
  <label>Weight (kg)<input id="f4" type="number" min="0" step="0.1"></label>
  <label>Pickup area (coarse)<input id="f5" maxlength="60"></label>
  <div class="row"><button class="b g" data-a="gps" data-k="pickup">Use my location for pickup</button><span class="f"></span></div>
  <div id="geo-pickup"></div>
  <label>Pickup coordinates (optional, manual — latitude, longitude)<div class="row"><input id="f5a" type="number" step="any" min="-90" max="90" placeholder="Latitude, e.g. 23.81" aria-label="Pickup latitude"><input id="f5b" type="number" step="any" min="-180" max="180" placeholder="Longitude, e.g. 90.41" aria-label="Pickup longitude"></div></label>
  <small>Manual coordinates are stored exactly as you typed them — they are not GPS-verified.</small>
  <label>Drop-off area (coarse)<input id="f6" maxlength="60"></label>
  <div class="row"><button class="b g" data-a="gps" data-k="dropoff">Use my location for drop-off</button><span class="f"></span></div>
  <div id="geo-dropoff"></div>
  <label>Drop-off coordinates (optional, manual — latitude, longitude)<div class="row"><input id="f6a" type="number" step="any" min="-90" max="90" placeholder="Latitude" aria-label="Drop-off latitude"><input id="f6b" type="number" step="any" min="-180" max="180" placeholder="Longitude" aria-label="Drop-off longitude"></div></label>
  <small>Manual coordinates are stored exactly as you typed them — they are not GPS-verified.</small>
  <label>Instructions (shown only to participants)<textarea id="f7" maxlength="300"></textarea></label>
  <label>Offered fee (informational, not charged)<input id="f8" type="number" min="0"></label>
  <label><input id="f9" type="checkbox" class="wauto"> Fragile / special handling</label>
  <label>Parcel photo (optional)<input id="f10" type="file" accept="image/*" capture="environment"></label>
  <div id="pv"></div>
  <button class="b" data-a="mko">Create order</button> <button class="b g" data-a="nb">Cancel</button><br>
  <small>Use general areas only; exact addresses should be shared after a courier accepts, outside this page. Camera and location are only requested when you tap those buttons.</small></div>`;
  $('#f10').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) { S.photoFile = null; S.photoPreview = null; $('#pv').innerHTML = ''; return; }
    S.photoFile = f;
    if (S.photoPreview) URL.revokeObjectURL(S.photoPreview);
    S.photoPreview = URL.createObjectURL(f);
    $('#pv').innerHTML = `<small>Preview:</small><br><img src="${S.photoPreview}" class="preview-img" alt="Parcel preview">`;
  });
}

function odetail(v) {
  const o = S.order; if (!o) { S.oid = null; return render(); }
  const mine = o.sender_id === me.id, cr = o.courier_id === me.id, part = mine || cr || me.role === 'admin';
  const hist = S.history || [];
  const byStatus = {}; hist.forEach((h) => { byStatus[h.to_status] = h.created_at; });
  const tl = STATES.map((n, i) => {
    const e = byStatus[n];
    return `<li class="${e ? 'on' : n === o.status ? 'nx' : ''}"><i></i><b>${STATE_LABEL[n]}</b><small>${e ? T(e) : ''}</small></li>`;
  }).join('');
  let ac = '';
  if (o.status === 'SEARCHING_FOR_COURIER' && !mine && S.courier) ac = '<button class="b" data-a="acc">Accept this order</button>';
  else if (cr && o.status === 'ASSIGNED') ac = '<button class="b" data-a="step" data-k="ACCEPTED">Accept this order</button>';
  else if (cr && o.status === 'ACCEPTED') ac = `<h2>Courier action</h2><input id="cd" inputmode="numeric" maxlength="6" placeholder="Pickup code from sender" aria-label="Pickup code"><button class="b" data-a="verify" data-k="pickup">Verify pickup</button>`;
  else if (cr && o.status === 'PICKUP_VERIFIED') ac = '<button class="b" data-a="step" data-k="IN_TRANSIT">Start transit</button>';
  else if (cr && o.status === 'IN_TRANSIT') ac = `<h2>Courier action</h2><input id="cd" inputmode="numeric" maxlength="6" placeholder="Delivery code from recipient" aria-label="Delivery code"><button class="b" data-a="verify" data-k="dropoff">Verify delivery</button>`;
  else if (cr && o.status === 'DROPOFF_VERIFIED') ac = '<button class="b" data-a="step" data-k="DELIVERED">Mark delivered</button>';
  v.innerHTML = `<div class="row"><button class="b g" data-a="ob">←</button><b class="f">${esc(o.name)}</b></div>${banner()}
  <div class="c"><small>${esc(o.category)} · ${esc(o.size)} · ${esc(o.weight_kg ?? '?')} kg${o.fragile ? ' · fragile' : ''}<br>${esc(o.pickup_area)} → ${esc(o.dropoff_area)}<br>Ref: ${esc(o.public_ref)}<br>Fee offered: ${esc(o.fee_offer || 0)} (no payment integrated)${part && o.instructions ? `<br>Notes: ${esc(o.instructions)}` : ''}</small></div>
  <div class="c"><b>Status${o.disputed ? ' · DISPUTED' : ''}</b>${o.status === 'CANCELLED' ? '<div class="tag w">CANCELLED</div>' : ''}<ol>${tl}</ol><small>Live location: unavailable — no courier position is ever tracked.</small></div>
  ${S.route ? `<div class="c"><b>Route (road distance, from the map provider)</b><br>${(S.route.distanceKm).toFixed(2)} km · about ${Math.round(S.route.durationMinutes)} min<br><small>${esc(S.route.from.source === 'user-supplied' ? 'Endpoints you supplied, not GPS-verified. ' : '')}${esc(S.route.attribution || '')}</small></div>`
    : `<div class="c"><small>Route: ${esc(S.routeNote || 'no route is shown for this order.')}</small></div>`}
  ${o.photo_file_id ? `<div class="c"><small>Parcel photo is stored privately and visible only to participants.</small></div>` : ''}
  ${ac}
  ${mine && S.codes ? `<div class="c" id="cc"><small>Handover codes — share these with the courier / recipient. They expire and can only be used once.</small><br>
    Pickup (give to courier): <b>${S.codes.pickup?.code || '(used / expired)'}</b><br>
    Delivery (give to recipient): <b>${S.codes.dropoff?.code || '(used / expired)'}</b><br>
    <small>Valid until ${S.codes.pickup ? T(S.codes.pickup.expiresAt) : '—'}</small></div>` : ''}
  ${mine ? `<div class="c"><b>Order QR</b><br><img src="/api/deliveries/${esc(o.id)}/qr" alt="Order QR code" class="qr-img"><br><small>The QR holds only the order reference — it never authorizes delivery on its own.</small></div>` : ''}
  ${part && CANCELLABLE.includes(o.status) && mine ? `<div class="row"><button class="b r" data-a="cx">Cancel order</button></div>` : ''}
  ${part && !o.disputed && !['DELIVERED', 'CANCELLED'].includes(o.status) ? `<h2>Report a problem</h2><input id="dr" maxlength="200" placeholder="What went wrong?" aria-label="Dispute reason"><button class="b r" data-a="dsp">Open dispute</button>` : ''}
  ${o.disputed ? `<div class="c"><small>Disputed: ${esc(o.dispute_reason || '')} — an admin reviews disputes.</small></div>` : ''}`;
}

function act2(v) {
  const convs = (S.convs || []).filter((c) => c.unread);
  const mine = (S.orders || []).filter((x) => x.sender_id === me.id || x.courier_id === me.id);
  v.innerHTML = `<h1><span></span>ACTIVITY</h1>${banner()}
  <div class="row"><span class="f"></span><button class="b g" data-a="seen">Mark all read</button></div>
  <h2>Unread chats (${S.unread})</h2>` +
    (!convs.length ? '<div class="c mu">No unread chats.</div>'
      : convs.map((c) => `<button class="c" data-a="open" data-id="${esc(c.id)}"><span class="dot"></span><b>${esc(c.name || 'Direct message')}</b> · ${c.unread} new</button>`).join('')) +
    `<h2>My deliveries</h2>` +
    (!mine.length ? '<div class="c mu">No deliveries yet.</div>'
      : mine.map((x) => `<button class="c" data-a="od" data-id="${esc(x.id)}"><b>${esc(x.name)}</b> → ${STATE_LABEL[x.status] || x.status}<br><small>${T(x.updated_at)}</small></button>`).join(''));
}

function prof(v) {
  v.innerHTML = `<h1><span></span>PROFILE</h1>${banner()}<div class="c"><div class="row">${av(me.avatarGlyph, me.nexoraId)}<div class="f"><b>${esc(me.displayName || me.nexoraId)}</b><br><small>${me.nexoraId} · <span class="tag">${me.isAnonymous ? 'ANONYMOUS' : me.role.toUpperCase()}</span></small></div></div>
  <input id="pn" maxlength="24" value="${esc(me.displayName || '')}" placeholder="Custom display name (optional)" aria-label="Display name">
  <div class="row">${GL.map((g) => `<button class="b g" data-a="gl" data-g="${g}" aria-label="Avatar ${g}">${g}</button>`).join('')}</div><br>
  <button class="b" data-a="sn">Save</button></div>
  ${me.isAnonymous ? `<div class="c"><b>Claim this account</b><br><small>Add an email + password so you can sign in from another device.</small><input id="cl-e" type="email" placeholder="Email"><input id="cl-p" type="password" placeholder="Password (min 10 characters)"><button class="b" data-a="claim">Claim account</button></div>` : ''}
  <div class="c"><b>Courier</b><br>${S.courier ? `<small>Registered courier · available: ${S.courier.available ? 'yes' : 'no'}</small><br><button class="b g" data-a="avail" data-k="${S.courier.available ? 'off' : 'on'}">${S.courier.available ? 'Go offline' : 'Go online'}</button>` : '<small>You are not registered as a courier.</small><br><button class="b" data-a="creg">Register as courier</button>'}</div>
  <div class="c"><b>Session</b><br><small>Signed in with a server session (HttpOnly cookie). Your NEXORA ID is pseudonymous, not absolutely anonymous: the server can link activity to your account for moderation. Messages are <b>not</b> end-to-end encrypted.</small><br><br><button class="b g" data-a="logout">Sign out</button> <button class="b r" data-a="reset">${S.confirmDelete ? 'Tap again to confirm deletion' : 'Delete account'}</button></div>
  <div class="c"><b>Theme</b><div class="row">${['auto', 'dark', 'light'].map((k) => `<button class="b ${th === k ? '' : 'g'}" data-a="th" data-k="${k}">${k}</button>`).join('')}</div></div>
  <div class="c"><b>Blocked (${blk.length})</b>${blk.map((b) => `<div class="row"><span class="f">${esc(b.nexora_id)}</span><button class="b g" data-a="unb" data-h="${esc(b.nexora_id)}">Unblock</button></div>`).join('') || '<br><small>No one blocked.</small>'}</div>
  <div class="c"><small><b>Not included in this build:</b> live GPS tracking, push notifications, E2EE, payments. Map routing is shown only when a provider is configured, and only as distance/duration — no map is rendered and no position is tracked.</small></div>`;
  applyDynamicStyles();
}

// ---------- actions ----------
async function loadChats() {
  try { S.convs = (await api.conversations()).data; } catch (e) { S.convs = []; toast(e.message); }
  await refreshUnread();
  render();
}
async function loadOrders() {
  try {
    const mine = (await api.deliveries('mine')).data;
    let queue = [];
    try { queue = (await api.deliveries('queue')).data; } catch { queue = []; }
    const byId = new Map();
    [...mine, ...queue].forEach((o) => byId.set(o.id, o));
    S.orders = [...byId.values()];
  } catch (e) { S.orders = []; toast(e.message); }
  render();
}
async function openConv(id) {
  try {
    const conv = (await api.conversation(id)).data;
    if (conv.type === 'room') {
      const isMember = (conv.members || []).some((m) => m.id === me.id);
      if (!isMember) await api.joinRoom(id);
    }
    S.conv = conv; S.msgs = null; S.reply = null; S.sel = null; S.msgPage = 1;
    S.pendingAttachment = null; S.pendingAttachmentName = null;
    render();
    const page = await api.messages(id, 1);
    S.msgs = page.data.slice().reverse();
    S.msgPages = page.meta.pages;
    // Read-mark is best-effort: it must never block rendering or the socket
    // join (a failed markRead previously left the message list empty forever).
    try { await api.markRead(id); } catch { /* unread count refreshes next load */ }
    draw();
    socket?.emit('conversation:join', id);
    await refreshUnread();
  } catch (e) { toast(e.message); }
}
async function openOrder(id) {
  try {
    S.order = (await api.delivery(id)).data;
    S.history = (await api.deliveryHistory(id)).data;
    S.codes = null; S.routeNote = null; S.route = null;
    if (S.order.sender_id === me.id) { try { S.codes = (await api.deliveryCodes(id)).data; } catch { /* codes unavailable */ } }
    try {
      S.route = (await api.deliveryRoute(id)).data;
    } catch (e) {
      if (e.code === 'MAPS_NOT_CONFIGURED') S.routeNote = 'No map provider configured — no route or ETA is shown.';
      else if (e.code === 'MAPS_NOT_IMPLEMENTED') S.routeNote = 'The configured map provider is not supported — no route is shown.';
      else if (e.code === 'ROUTE_COORDS_MISSING') S.routeNote = 'This order has no coordinates, so no route can be calculated.';
      else if (e.code === 'MAPS_TIMEOUT' || e.code === 'MAPS_PROVIDER_ERROR') S.routeNote = 'The map provider is currently unavailable — no route is shown. Nothing here is estimated.';
      else S.routeNote = 'No route is shown for this order.';
    }
    S.oid = id; render();
  } catch (e) { toast(e.message); }
}

const act = {
  async tab(d) { S.tab = d.k; S.conv = null; S.oid = null; S.form = null; S.confirmDelete = false; if (S.tab === 'chats') await loadChats(); if (S.tab === 'delivery') await loadOrders(); render(); },
  nr() { S.form = 'conv'; render(); },
  nr0() { S.form = null; render(); },
  async mkconv() {
    const type = $('#cf-type').value;
    const name = $('#cf-name').value.trim();
    const members = $('#cf-members').value.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const r = await api.createConversation({ type, name: name || undefined, memberNexoraIds: members });
      S.form = null; toast(r.data.reused ? 'Opening existing conversation' : 'Created');
      await loadChats(); await openConv(r.data.id);
    } catch (e) { toast(e.message); }
  },
  async open(d) { S.tab = 'chats'; await openConv(d.id); },
  back() { S.conv = null; S.msgs = null; render(); loadChats(); },
  async leave() { try { await api.leaveConversation(S.conv.id); S.conv = null; await loadChats(); } catch (e) { toast(e.message); } },
  async send() {
    const i = $('#in'); const t = i.value.trim();
    if (!t && !S.pendingAttachment) return;
    if (S.off) return toast('You’re offline');
    const body = { body: t || `📎 ${S.pendingAttachmentName || 'Attachment'}`, replyToId: S.reply?.id, clientId: crypto.randomUUID(), attachmentIds: S.pendingAttachment ? [S.pendingAttachment] : [] };
    i.value = ''; S.reply = null; S.pendingAttachment = null; S.pendingAttachmentName = null;
    try {
      await api.sendMessage(S.conv.id, body);
      const page = await api.messages(S.conv.id, 1);
      S.msgs = page.data.slice().reverse(); S.msgPage = 1; S.msgPages = page.meta.pages;
      draw();
    } catch (e) { i.value = t; toast('Not sent: ' + e.message); }
  },
  sel(d, el) { if (el.target.closest('button,a,input')) return; S.sel = S.sel === d.id ? null : d.id; S.editing = null; draw(); },
  reply(d) { S.reply = S.msgs.find((m) => m.id === d.id); S.sel = null; draw(); $('#in').focus(); },
  xr() { S.reply = null; draw(); },
  edit(d) { S.editing = d.id; draw(); const ed = $('#ed'); ed?.focus(); },
  async saveedit(d) {
    const v = $('#ed').value.trim(); if (!v) return;
    try { await api.editMessage(d.id, v); S.editing = null; const page = await api.messages(S.conv.id, 1); S.msgs = page.data.slice().reverse(); draw(); } catch (e) { toast(e.message); }
  },
  async del(d) { try { await api.deleteMessage(d.id); S.sel = null; const page = await api.messages(S.conv.id, 1); S.msgs = page.data.slice().reverse(); draw(); } catch (e) { toast(e.message); } },
  async block(d) {
    try { await api.block(d.h); toast('Blocked ' + d.h); S.sel = null; const page = await api.messages(S.conv.id, 1); S.msgs = page.data.slice().reverse(); draw(); } catch (e) { toast(e.message); }
  },
  async unb(d) { try { await api.unblock(d.h); blk = (await api.blocks()).data; render(); } catch (e) { toast(e.message); } },
  async older() {
    try { const page = await api.messages(S.conv.id, S.msgPage + 1); S.msgPage += 1; S.msgPages = page.meta.pages; S.msgs = page.data.slice().reverse().concat(S.msgs); draw(); } catch (e) { toast(e.message); }
  },
  async addm() {
    const v = $('#am').value.trim(); if (!v) return;
    try { await api.addMember(S.conv.id, v); toast('Added ' + v); await openConv(S.conv.id); } catch (e) { toast(e.message); }
  },
  dt(d) { S.dt = d.k; render(); },
  no() { S.form = 'o'; S.photoFile = null; render(); },
  nb() { S.form = null; render(); },
  ob() { S.oid = null; S.order = null; render(); loadOrders(); },
  async od(d) { S.tab = 'delivery'; await openOrder(d.id); },
  // Geolocation is NEVER requested on first tap. The first tap only shows
  // this explanation; permission is requested only if the user then taps
  // "Use my device location". One single reading, never watchPosition:
  // no continuous or background tracking exists anywhere in this app.
  gps(d) {
    const box = document.getElementById(`geo-${d.k}`);
    if (!box) return;
    box.innerHTML = `<div class="c"><small>Using your device location will read your current position <b>once</b>, only for this ${d.k} field, and store it only if you then create the order. It is not tracked afterwards, and it is never shared with anyone except the order participants. You can also type coordinates manually instead — no permission needed.</small><br>
      <button class="b" data-a="gpsok" data-k="${d.k}">Use my device location</button> <button class="b g" data-a="gpsman" data-k="${d.k}">Enter manually instead</button></div>`;
  },
  gpsman(d) {
    const box = document.getElementById(`geo-${d.k}`);
    if (box) box.innerHTML = '<small>Enter the coordinates manually below — they will be stored exactly as typed, not GPS-verified.</small>';
    const input = document.getElementById(d.k === 'pickup' ? 'f5a' : 'f6a');
    input?.focus();
  },
  gpsok(d) {
    const box = document.getElementById(`geo-${d.k}`);
    const say = (m) => { if (box) box.innerHTML = `<div class="c"><small>${m}</small></div>`; toast(m); };
    if (!window.isSecureContext) return say('Location needs a secure context (HTTPS or localhost) — enter the coordinates manually instead.');
    if (!navigator.geolocation) return say('Geolocation is not available in this browser — enter the coordinates manually instead.');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const loc = { lat: p.coords.latitude, lng: p.coords.longitude, source: 'gps' };
        if (d.k === 'pickup') S.pickupLoc = loc; else S.dropoffLoc = loc;
        if (box) box.innerHTML = `<div class="c"><small>Location captured once for ${d.k}: ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}. It will be saved only when you create the order. No tracking continues.</small></div>`;
        toast(`Location captured for ${d.k}`);
      },
      (err) => {
        const why = err?.code === 1 ? 'Location permission was denied.'
          : err?.code === 2 ? 'Your position is unavailable right now.'
          : err?.code === 3 ? 'Getting your location timed out.'
          : 'Location could not be read.';
        say(`${why} Enter the coordinates manually instead — they will be stored exactly as typed, not GPS-verified.`);
      },
      { timeout: 10000, enableHighAccuracy: false, maximumAge: 0 },
    );
  },
  async mko() {
    const g = (i) => $('#f' + i);
    const name = g(1).value.trim(), pickup = g(5).value.trim(), dropoff = g(6).value.trim();
    if (!name || !pickup || !dropoff) return toast('Name, pickup and drop-off areas are required');
    // Manual coordinates (if both halves are typed) win over a GPS reading;
    // they are user-supplied, validated here and again server-side, and
    // never presented as GPS-verified. One half without the other is an error.
    const manual = (latEl, lngEl, label) => {
      const a = latEl.value.trim(), b = lngEl.value.trim();
      if (!a && !b) return null;
      if (!a || !b) { toast(`Enter both ${label} latitude and longitude, or neither`); return false; }
      const lat = Number(a), lng = Number(b);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        toast(`${label} coordinates are out of range (latitude -90..90, longitude -180..180)`); return false;
      }
      return { lat, lng, source: 'manual' };
    };
    const mPickup = manual($('#f5a'), $('#f5b'), 'Pickup');
    const mDropoff = manual($('#f6a'), $('#f6b'), 'Drop-off');
    if (mPickup === false || mDropoff === false) return;
    const pLoc = mPickup || S.pickupLoc, dLoc = mDropoff || S.dropoffLoc;
    if (S.busy) return; S.busy = true;
    try {
      const r = await api.createDelivery({
        name, category: g(2).value, size: g(3).value, weightKg: +g(4).value || 0,
        pickupArea: pickup, dropoffArea: dropoff,
        pickupLat: pLoc?.lat ?? null, pickupLng: pLoc?.lng ?? null,
        dropoffLat: dLoc?.lat ?? null, dropoffLng: dLoc?.lng ?? null,
        instructions: g(7).value.trim(), feeOffer: Math.max(0, +g(8).value || 0), fragile: g(9).checked,
      });
      if (S.photoFile) {
        toast('Order created — uploading parcel photo…');
        await api.uploadParcelPhoto(r.data.id, S.photoFile);
      }
      S.form = null; S.photoFile = null; S.pickupLoc = null; S.dropoffLoc = null; toast('Order created');
      await openOrder(r.data.id);
    } catch (e) { toast('Couldn’t create order: ' + e.message); }
    S.busy = false;
  },
  async acc() { try { await api.claimDelivery(S.oid); toast('Claimed — now accept to confirm.'); await openOrder(S.oid); } catch (e) { toast(e.message); } },
  async step(d) { try { await api.stepDelivery(S.oid, d.k); await openOrder(S.oid); } catch (e) { toast(e.message); } },
  async verify(d) {
    const code = ($('#cd').value || '').trim();
    if (!/^\d{6}$/.test(code)) return toast('Enter the 6-digit code');
    try { await api.verifyDelivery(S.oid, d.k, code); toast('Verified.'); await openOrder(S.oid); } catch (e) { toast(e.message); }
  },
  async cx() { try { await api.cancelDelivery(S.oid); await openOrder(S.oid); } catch (e) { toast(e.message); } },
  async dsp() {
    const t = $('#dr').value.trim(); if (!t) return toast('Describe the problem');
    try { await api.disputeDelivery(S.oid, t); toast('Dispute recorded. An admin reviews disputes.'); await openOrder(S.oid); } catch (e) { toast(e.message); }
  },
  async seen() {
    try {
      for (const c of (S.convs || []).filter((c) => c.unread)) await api.markRead(c.id);
      await loadChats(); render();
    } catch (e) { toast(e.message); }
  },
  th(d) { th = d.k; localStorage.setItem('nx_th', th); setTh(); render(); },
  gl(d) { if (!me) return; me.avatarGlyph = d.g; render(); },
  async sn() {
    try { await api.updateMe({ displayName: $('#pn').value.trim(), avatarGlyph: me.avatarGlyph }); me.displayName = $('#pn').value.trim(); toast('Saved'); render(); } catch (e) { toast(e.message); }
  },
  async creg() { try { await api.courierRegister(); S.courier = await api.courierMe().then((r) => r.data); toast('Registered as courier'); render(); } catch (e) { toast(e.message); } },
  async avail(d) {
    try { const r = await api.courierAvailability(d.k === 'on', S.courier?.vehicle || ''); S.courier = r.data; render(); } catch (e) { toast(e.message); }
  },
  async logout() { try { await api.logout(); } catch { /* ignore */ } me = null; S.conv = null; S.oid = null; render(); },
  async reset() {
    if (!S.confirmDelete) { S.confirmDelete = true; render(); setTimeout(() => { S.confirmDelete = false; render(); }, 4000); return; }
    try { await api.deleteAccount(); me = null; render(); toast('Account deleted.'); } catch (e) { toast(e.message); }
  },
  async anon() { try { const r = await api.anonymous(''); me = r.data.user; await afterAuth(); } catch (e) { toast(e.message); } },
  async login() {
    try { const r = await api.login($('#li-e').value.trim(), $('#li-p').value); me = r.data.user; await afterAuth(); } catch (e) { toast('Sign-in failed: ' + e.message); }
  },
  async register() {
    try { const r = await api.register($('#rg-e').value.trim(), $('#rg-p').value, $('#rg-n').value.trim()); me = r.data.user; await afterAuth(); } catch (e) { toast('Registration failed: ' + e.message); }
  },
  async claim() {
    try { await api.claim($('#cl-e').value.trim(), $('#cl-p').value); me = (await api.me()).data.user; toast('Account claimed — you can now sign in elsewhere.'); render(); } catch (e) { toast(e.message); }
  },
};

async function afterAuth() {
  try { S.courier = (await api.courierMe()).data; } catch { S.courier = null; }
  try { blk = (await api.blocks()).data; } catch { blk = []; }
  connectSocket();
  await loadChats();
}

function connectSocket() {
  if (typeof io === 'undefined') return;
  socket?.disconnect();
  socket = io({ withCredentials: true });
  socket.on('message:new', (m) => {
    if (S.conv && m.conversationId === S.conv.id) {
      if ((S.msgs || []).some((x) => x.id === m.id)) return; // already have it (HTTP refetch)
      S.msgs = [...(S.msgs || []), m];
      draw();
    } else { refreshUnread(); }
  });
  socket.on('delivery:update', (u) => {
    if (S.tab === 'delivery') loadOrders();
    else toast(`Delivery update: ${u.status}`);
  });
  socket.on('connect', () => { if (S.conv) socket.emit('conversation:join', S.conv.id); });
}

let e0;
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-a]'); if (!a) return;
  e0 = e; if (a.tagName === 'A') e.preventDefault();
  act[a.dataset.a]?.(a.dataset, a);
});
addEventListener('online', () => { S.off = false; render(); });
addEventListener('offline', () => { S.off = true; render(); });

(async () => {
  render();
  try {
    await initCsrf();
    health = (await api.health()).data;
    const session = await api.me();
    me = session.data.user;
    await afterAuth();
  } catch (e) {
    if (e.status !== 401) { backendDown = true; }
    render();
  }
})();
