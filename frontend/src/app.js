// NEXORA frontend — same interface as the original single-file build, rewired
// to the real backend. No window.claude, no localStorage identity, no mock
// data: every action is an API call, every list comes from the database.
// The only localStorage keys left are the theme preference (harmless) and
// nothing else. Session lives in an HttpOnly cookie.
import { api, initCsrf } from './api.js';
import { mountPinPicker, mountPinsMap, mountGpsButton, directionsUrl, fmt } from './map.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const T = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const STATES = ['CREATED', 'PREPARED', 'READY_FOR_PICKUP', 'SEARCHING_FOR_COURIER', 'ASSIGNED', 'ACCEPTED', 'PICKUP_VERIFIED', 'IN_TRANSIT', 'DROPOFF_VERIFIED', 'DELIVERED'];
const STATE_LABEL = {
  CREATED: 'Created', PREPARED: 'Prepared by seller', READY_FOR_PICKUP: 'Ready for pickup', SEARCHING_FOR_COURIER: 'Looking for courier', ASSIGNED: 'Courier assigned',
  ACCEPTED: 'Accepted by courier', PICKUP_VERIFIED: 'Picked up', IN_TRANSIT: 'In transit',
  DROPOFF_VERIFIED: 'Drop-off verified', DELIVERED: 'Delivered', CANCELLED: 'Cancelled',
};
const CANCELLABLE = ['CREATED', 'SEARCHING_FOR_COURIER', 'ASSIGNED', 'ACCEPTED'];
// Marketplace DELIVERED renders as "Item Exchanged" everywhere; courier
// orders keep "Delivered". List rows carry fulfillment (SELECT *).
function stateTag(x) { return (x && x.fulfillment === 'marketplace' && x.status === 'DELIVERED') ? 'Item Exchanged' : (STATE_LABEL[x.status] || x.status); }
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
  requests: null, reqShowForm: false, reqEdit: null, reqTarget: null,
  dropoffPick: null, dropoffPhotoFile: null, dropoffArea: '',
  pins: null, thread: null, glog: null, invites: null, joinReqs: null,
  statusCard: null, pickupShare: null, confirmTransfer: null,
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
  <div class="row"><h2 class="f">Chats</h2><button class="b" data-a="nr">+ New</button></div>
  <div class="c"><small>Join a private group with an invite code, or request to join a group by its ID (an owner/admin approves).</small>
  <div class="row"><input id="jc-code" class="f" maxlength="32" placeholder="Invite code, e.g. INV-…" aria-label="Invite code"><button class="b g" data-a="joincode">Join with code</button></div>
  <div class="row"><input id="jr-id" class="f" placeholder="Group ID" aria-label="Group ID"><button class="b g" data-a="groupjoinreq">Request to join</button></div></div>` +
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
  ${banner()}<div id="pins"></div><div id="statuscard"></div><div id="ml" aria-live="polite"></div><div id="thread"></div><div id="rp"></div>
  <div id="dset"></div><div id="reqs"></div><div id="gset"></div>
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
      if (m.isSystem) {
        // System announcements (arrival / exchange): distinct, and never
        // editable, deletable, reactable or replyable — no action buttons.
        return `<div class="m sys"><small>◆ ${esc(m.body)}</small></div>`;
      }
      const body = S.editing === m.id
        ? `<input id="ed" class="f" maxlength="2000" value="${esc(m.body)}"><button class="b" data-a="saveedit" data-id="${m.id}">Save</button>`
        : `<div>${esc(m.body)}</div>`;
      const atts = (m.attachments || []).map((a) =>
        `<div><small>📎 <a href="${esc(a.downloadUrl)}" target="_blank" rel="noopener">${esc(a.originalName)}</a></small></div>`).join('');
      const rx = (m.reactions || []).map((r) =>
        `<button class="b g ${r.reacted ? 'on' : ''}" data-a="react" data-id="${m.id}" data-e="${esc(r.emoji)}">${esc(r.emoji)} ${r.count}</button>`).join('');
      return `<div class="m ${mine ? 'me' : ''}" data-a="sel" data-id="${m.id}"><small>${esc(m.senderName || m.senderNexoraId)} · ${T(m.createdAt)}${m.editedAt ? ' · edited' : ''}</small>
        ${m.replyToId && m.parentSnippet ? `<div class="re">↩ ${esc(m.parentSnippet)}</div>` : (m.replyToId ? '<div class="re">reply</div>' : '')}${body}${atts}
        ${rx ? `<div class="rx">${rx}</div>` : ''}
        ${m.replyCount ? `<div><button class="b g" data-a="thread" data-id="${m.id}">Thread (${m.replyCount})</button></div>` : ''}
        ${o ? `<div class="row mt6"><button class="b g" data-a="reply" data-id="${m.id}">Reply</button>
          <button class="b g" data-a="react" data-id="${m.id}" data-e="👍">👍</button><button class="b g" data-a="react" data-id="${m.id}" data-e="❤️">❤️</button><button class="b g" data-a="react" data-id="${m.id}" data-e="😂">😂</button>
          ${S.conv?.type === 'group' ? `<button class="b g" data-a="pin" data-id="${m.id}">Pin</button>` : ''}
          ${mine ? `<button class="b g" data-a="edit" data-id="${m.id}">Edit</button><button class="b r" data-a="del" data-id="${m.id}">Delete</button>`
            : `<button class="b r" data-a="block" data-h="${esc(m.senderNexoraId)}">Block</button>`}</div>` : ''}</div>`;
    }).join('')
    + (S.msgPage < S.msgPages ? `<button class="b g mt8" data-a="older">Load older messages</button>` : '');
  if (near) ml.scrollTop = ml.scrollHeight;
  $('#rp').innerHTML = S.reply ? `<small>Replying to ${esc(S.reply.senderName || S.reply.senderNexoraId)}: ${esc(S.reply.body.slice(0, 50))} <a href="#" data-a="xr">✕</a></small>`
    : (S.pendingAttachment ? `<small>📎 Attached: ${esc(S.pendingAttachmentName)} — send a message to deliver it.</small>` : '');
  renderThread();
}

// ---------- delivery requests (marketplace, Phase 1+2) ----------
// Backend contract (built in parallel): GET /api/conversations/:id returns
// deliverySettings { enabled, allowRequests }; requests live under
// /api/delivery-requests. Field names are read defensively (camelCase or
// snake_case) because the backend shape is not yet live to check against.
// A missing deliverySettings object is treated as enabled (backwards
// compatible with conversations created before the field existed).
function dsetOf(conv) {
  const d = conv?.deliverySettings || conv?.delivery_settings;
  if (!d) return { enabled: true, allowRequests: true };
  return { enabled: d.enabled !== false, allowRequests: d.allowRequests !== false };
}
function reqStatus(r) { return String(r.status || r.state || 'pending').toLowerCase(); }
function reqRequesterId(r) { return r.requesterId || r.requester_id || r.requester?.id; }
function reqTargetId(r) { return r.targetId || r.target_id || r.sellerId || r.seller_id || r.target?.id; }
function reqPriceMinor(r) { return r.priceMinor ?? r.price_minor ?? r.price ?? null; }
function canManageDset(conv) {
  if (!conv) return false;
  if (conv.type === 'dm') return true; // either participant
  if (conv.type === 'group') {
    const mine = (conv.members || []).find((m) => m.id === me?.id);
    return mine && (mine.role === 'owner' || mine.role === 'admin');
  }
  return false;
}
function renderDset() {
  const box = $('#dset'); if (!box || !S.conv) return;
  const d = dsetOf(S.conv);
  if (S.conv.type === 'room') { box.innerHTML = ''; return; }
  if (!canManageDset(S.conv)) {
    box.innerHTML = d.enabled ? '' : '<div class="c mu"><small>Delivery requests are disabled for this conversation.</small></div>';
    return;
  }
  box.innerHTML = `<div class="c"><b>Delivery requests</b><br>
    <label><input id="ds-en" type="checkbox" class="wauto" ${d.enabled ? 'checked' : ''}> Enable delivery requests for this conversation</label><br>
    <small>Any member may request a parcel or product. Requests are listed below; nothing is ordered or paid in-app.</small><br>
    <button class="b g" data-a="dsetsave">Save delivery settings</button></div>`;
}
function renderRequests() {
  const box = $('#reqs'); if (!box || !S.conv) return;
  const conv = S.conv, d = dsetOf(conv);
  if (conv.type === 'room') { box.innerHTML = ''; return; }
  const others = (conv.members || []).filter((m) => m.id !== me?.id);
  const dmTarget = conv.type === 'dm' ? others[0] : null;
  const reqBtn = d.enabled
    ? `<button class="b g" data-a="reqform">${S.reqShowForm ? 'Hide request form' : 'Request parcel / product'}</button>`
    : `<button class="b g" disabled title="Delivery requests are disabled for this conversation">Request parcel / product (disabled)</button>`;
  const form = !S.reqShowForm || !d.enabled ? '' : `<div class="c">
    <label>Title<input id="rq-title" maxlength="60" placeholder="What do you need delivered?"></label>
    <label>Description<textarea id="rq-desc" maxlength="500" placeholder="Details for the seller"></textarea></label>
    ${conv.type === 'group' ? `<label>Ask (seller)<select id="rq-target">${others.map((m) => `<option value="${esc(m.id)}">${esc(m.display_name || m.nexora_id)}</option>`).join('')}</select></label>` : ''}
    <label>Price in minor units (optional)<input id="rq-price" type="number" min="0" step="1" placeholder="e.g. 50000"></label>
    <label>Note (optional)<input id="rq-note" maxlength="200"></label>
    <button class="b" data-a="reqcreate">Send request</button> <button class="b g" data-a="reqform">Cancel</button><br>
    <small>Price is recorded in minor units with no currency assumed. No money moves in-app; payment, if any, is settled outside the app and recorded after delivery.</small></div>`;
  const list = S.requests === null ? '<div class="sk"></div>'
    : !S.requests.length ? '<div class="c mu"><small>No delivery requests in this conversation yet.</small></div>'
    : S.requests.map((r) => {
      const st = reqStatus(r), isSeller = reqTargetId(r) === me?.id, isRequester = reqRequesterId(r) === me?.id;
      const pending = ['pending', 'open', 'requested'].includes(st);
      const accepted = ['accepted', 'approved', 'confirmed'].includes(st);
      const deliveryId = r.deliveryId || r.delivery_id;
      const editForm = S.reqEdit === r.id && pending && (isSeller || isRequester)
        ? `<div class="row"><input id="rq-eprice" type="number" min="0" step="1" value="${reqPriceMinor(r) ?? ''}" placeholder="Price (minor units)" aria-label="Price"><input id="rq-enote" maxlength="200" value="${esc(r.note || '')}" placeholder="Note" aria-label="Note"><button class="b" data-a="reqsave" data-id="${esc(r.id)}">Save</button></div>` : '';
      return `<div class="c"><b>${esc(r.title)}</b> <span class="tag">${esc(st)}</span><br>
        <small>${esc(r.description || '')}${reqPriceMinor(r) != null ? `<br>Price: ${esc(reqPriceMinor(r))} (minor units)` : ''}${r.note ? `<br>Note: ${esc(r.note)}` : ''}</small><br>
        <div class="row mt6">
        ${isSeller && pending ? `<button class="b" data-a="reqaccept" data-id="${esc(r.id)}">Accept</button><button class="b g" data-a="reqdecline" data-id="${esc(r.id)}">Decline</button>` : ''}
        ${isRequester && (pending || accepted) ? `<button class="b r" data-a="reqcancel" data-id="${esc(r.id)}">Cancel</button>` : ''}
        ${(isSeller || isRequester) && pending ? `<button class="b g" data-a="reqedit" data-id="${esc(r.id)}">Edit price / note</button>` : ''}
        ${deliveryId ? `<button class="b g" data-a="od" data-id="${esc(deliveryId)}">View delivery</button>` : ''}
        </div>${editForm}</div>`;
    }).join('');
  box.innerHTML = `<div class="row mt8"><h2 class="f">Delivery requests</h2>${reqBtn}</div>${form}${list}`;
}
async function loadRequests() {
  if (!S.conv || S.conv.type === 'room') return;
  renderDset(); renderRequests();
  try { S.requests = (await api.deliveryRequests(S.conv.id)).data; }
  catch (e) {
    // The backend builds these endpoints in parallel: a 404 here means the
    // endpoint is not live yet, not that requests are empty. Say so plainly.
    S.requests = e.status === 404 ? [] : S.requests;
    if (e.status === 404) toast('Delivery requests are not available yet (backend endpoint not live).');
    else toast(e.message);
  }
  renderDset(); renderRequests();
  await renderStatusCard();
  await loadGroupExtras();
}

// ---------- community hub + transaction flow (005) ----------
const ROLE_BADGE = { owner: 'Owner', admin: 'Admin', moderator: 'Moderator', member: 'Member' };
function myRole(conv) {
  return (conv?.members || []).find((m) => m.id === me?.id)?.role || null;
}
function renderPins() {
  const box = $('#pins'); if (!box || !S.conv) return;
  if (S.conv.type !== 'group') { box.innerHTML = ''; return; }
  const mod = ['owner', 'admin', 'moderator'].includes(myRole(S.conv));
  if (!S.pins?.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="c"><b>📌 Pinned announcements</b>${S.pins.map((p) => `<div class="row"><span class="f"><small>${esc(p.senderName || p.senderNexoraId)}: ${esc(p.body.slice(0, 120))}</small></span>${mod ? `<button class="b g" data-a="unpin" data-id="${p.id}">Unpin</button>` : ''}</div>`).join('')}</div>`;
}
function renderThread() {
  const box = $('#thread'); if (!box) return;
  if (!S.thread) { box.innerHTML = ''; return; }
  const { parent, replies } = S.thread;
  box.innerHTML = `<div class="c"><div class="row"><b class="f">Thread</b><button class="b g" data-a="threadx">Close</button></div>
    <div><small>${esc(parent.senderName || parent.senderNexoraId)}: ${esc(parent.body)}</small></div>
    ${replies.map((r) => `<div class="m"><small>${esc(r.senderName || r.senderNexoraId)} · ${T(r.createdAt)}${r.editedAt ? ' · edited' : ''}</small><div>${esc(r.body)}</div></div>`).join('') || '<div class="mu"><small>No replies yet.</small></div>'}
    <div class="row"><input id="th-in" class="f" maxlength="2000" placeholder="Reply in this thread" aria-label="Thread reply"><button class="b" data-a="threadsend">Send reply</button></div></div>`;
}
async function loadThread(id) {
  try { S.thread = (await api.messageReplies(id)).data; }
  catch (e) { toast(e.message); return; }
  draw();
}
// Delivery status card: driven ONLY by the real delivery row + arrived_at.
// Step 1 reached at PREPARED or later; step 2 when arrived_at is set;
// step 3 at DELIVERED. The QR shown is the order-reference QR only — it
// authorizes nothing; the handover code remains the verification.
async function renderStatusCard() {
  const box = $('#statuscard'); if (!box || !S.conv) return;
  const req = (S.requests || []).find((r) => {
    const st = reqStatus(r);
    return ['accepted', 'approved', 'confirmed'].includes(st) && (r.deliveryId || r.delivery_id);
  });
  if (!req) { box.innerHTML = ''; return; }
  const deliveryId = req.deliveryId || req.delivery_id;
  let d;
  try { d = (await api.delivery(deliveryId)).data; }
  catch { box.innerHTML = ''; return; }
  const isMkt = d.fulfillment === 'marketplace';
  const label = isMkt && d.status === 'DELIVERED' ? 'Item Exchanged' : (STATE_LABEL[d.status] || d.status);
  const step = (reached, title, sub) => `<div><small>${reached ? '✓' : '○'} <b>${title}</b> — ${sub}</small></div>`;
  const step1 = ['PREPARED', 'READY_FOR_PICKUP', 'DELIVERED'].includes(d.status);
  const step2 = !!d.arrived_at;
  const step3 = d.status === 'DELIVERED';
  box.innerHTML = `<div class="c"><b>Delivery status: ${esc(label)}</b> <span class="tag">${esc(req.title)}</span><br>
    ${step(step1, 'Seller En Route', step1 ? `Order is ${esc(label.toLowerCase())}` : 'Waiting for the seller to prepare the order')}
    ${step(step2, 'Buyer Arriving', step2 ? 'Buyer has arrived at the drop-off point' : 'Buyer has not arrived yet')}
    ${step(step3, 'QR Scan for Exchange', step3 ? 'Item exchanged' : 'Exchange happens with the handover code shown by the buyer')}
    <div><img src="/api/deliveries/${esc(deliveryId)}/qr" alt="Order QR code (reference only)" class="qr-img"><br><small>The QR holds only the order reference — it never authorizes delivery on its own.</small></div>
    <div class="row mt6"><button class="b g" data-a="od" data-id="${esc(deliveryId)}">View delivery</button></div>
    ${isMkt && d.status === 'READY_FOR_PICKUP' ? '<div id="card-share"></div><div id="card-sharemap" class="map-box"></div>' : ''}</div>`;
  if (isMkt && d.status === 'READY_FOR_PICKUP') {
    const shareBox = $('#card-share');
    mountGpsButton(shareBox, { label: 'pickup location share (30 minutes, one reading only)',
      onReading: async (loc) => {
        try { await api.sharePickupLocation(deliveryId, loc.lat, loc.lng); toast('Pickup location shared for 30 minutes'); await renderStatusCard(); }
        catch (e) { toast(e.message); }
      } });
    try {
      const sh = (await api.pickupLocation(deliveryId)).data.share;
      if (sh && sh.sharerId !== me.id) {
        const pins = [{ lat: sh.lat, lng: sh.lng, label: 'Other participant (shared pickup location)' }];
        if (Number.isFinite(Number(d.dropoff_lat)) && Number.isFinite(Number(d.dropoff_lng))) {
          pins.push({ lat: Number(d.dropoff_lat), lng: Number(d.dropoff_lng), label: 'Drop-off' });
        }
        mountPinsMap($('#card-sharemap'), pins);
      } else { const m = $('#card-sharemap'); if (m) m.innerHTML = ''; }
    } catch { /* no share to show */ }
  }
}
function renderGroupExtras() {
  const box = $('#gset'); if (!box || !S.conv) return;
  const conv = S.conv;
  if (conv.type !== 'group') { box.innerHTML = ''; return; }
  const role = myRole(conv);
  const isAdmin = ['owner', 'admin'].includes(role);
  const isMod = ['owner', 'admin', 'moderator'].includes(role);
  const rulesHtml = `<div class="c"><b>Group rules</b><br>${conv.rules ? `<small>${esc(conv.rules)}</small>` : '<small class="mu">No rules set yet.</small>'}
    ${isAdmin ? `<div class="row mt6"><input id="gr-in" class="f" maxlength="1000" value="${esc(conv.rules || '')}" placeholder="Group rules" aria-label="Group rules"><button class="b g" data-a="rulessave">Save rules</button></div>` : ''}</div>`;
  const membersHtml = `<div class="c"><b>Members</b>${(conv.members || []).map((m) => `<div class="row"><span class="f"><small>${esc(m.display_name || m.nexora_id)}</small> <span class="tag role">${ROLE_BADGE[m.role] || m.role}</span></span>
    ${isAdmin && m.id !== me.id ? `<select id="role-${m.id}" class="wauto"><option value="member" ${m.role === 'member' ? 'selected' : ''}>Member</option><option value="moderator" ${m.role === 'moderator' ? 'selected' : ''}>Moderator</option>${role === 'owner' ? `<option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Admin</option>` : ''}</select><button class="b g" data-a="roleset" data-id="${m.id}">Set role</button><button class="b r" data-a="memberrm" data-id="${m.id}">Remove</button>` : ''}
    ${role === 'owner' && m.id !== me.id ? `<button class="b g" data-a="transfer" data-id="${m.id}">${S.confirmTransfer === m.id ? 'Tap again to confirm transfer' : 'Transfer ownership'}</button>` : ''}</div>`).join('')}</div>`;
  const invitesHtml = !isAdmin ? '' : `<div class="c"><b>Invite links</b><br>
    <label>Max uses (optional)<input id="inv-uses" type="number" min="1" placeholder="Unlimited"></label>
    <button class="b g" data-a="invcreate">Create invite</button>
    ${(S.invites || []).map((inv) => `<div class="row"><span class="f"><small><b>${esc(inv.code)}</b> · uses ${inv.uses}${inv.max_uses ? ` / ${inv.max_uses}` : ''}${inv.expires_at ? ` · expires ${T(inv.expires_at)}` : ''}</small></span><img src="${api.inviteQrUrl(conv.id, inv.code)}" alt="Invite QR (code only)" class="qr-img"></div>`).join('') || '<div class="mu"><small>No invites yet.</small></div>'}</div>`;
  const joinHtml = !isAdmin ? '' : `<div class="c"><b>Join requests</b>${(S.joinReqs || []).filter((r) => r.status === 'REQUESTED').map((r) => `<div class="row"><span class="f"><small>${esc(r.requester_display_name || r.requester_nexora_id)}</small></span><button class="b" data-a="joinok" data-id="${r.id}">Approve</button><button class="b g" data-a="joinno" data-id="${r.id}">Decline</button></div>`).join('') || '<div class="mu"><small>No pending join requests.</small></div>'}</div>`;
  const logHtml = !isAdmin ? '' : `<div class="c"><b>Admin log</b>${(S.glog || []).map((e) => `<div><small>${T(e.created_at)} · ${esc(e.actor_nexora_id || '—')} · ${esc(e.action)}</small></div>`).join('') || '<div class="mu"><small>No admin actions yet.</small></div>'}</div>`;
  box.innerHTML = rulesHtml + membersHtml + invitesHtml + joinHtml + logHtml;
  void isMod;
}
async function loadGroupExtras() {
  if (!S.conv || S.conv.type !== 'group') return;
  renderPins(); renderGroupExtras();
  try { S.pins = (await api.pins(S.conv.id)).data; } catch { S.pins = []; }
  const role = myRole(S.conv);
  if (['owner', 'admin'].includes(role)) {
    try { S.glog = (await api.adminLog(S.conv.id)).data; } catch { S.glog = []; }
    try { S.invites = (await api.listInvites(S.conv.id)).data; } catch { S.invites = []; }
    try { S.joinReqs = (await api.listJoinRequests(S.conv.id)).data; } catch { S.joinReqs = []; }
  }
  renderPins(); renderGroupExtras();
}

// ---------- delivery ----------
function dlv(v) {
  const o = S.orders, q = (o || []).filter((x) => x.status === 'SEARCHING_FOR_COURIER');
  const m = (o || []).filter((x) => x.sender_id === me.id || x.courier_id === me.id);
  const l = S.dt === 'queue' ? q : m;
  v.innerHTML = `<h1><span></span>NEXORA TRANSIT</h1>${banner()}
  <div class="c"><small>${health?.maps?.configured ? 'Routes: a distance/duration for an order is shown on its detail page when that order has coordinates.' : 'Tracking: <b>unavailable</b> — no route provider is configured, so no distances are shown.'} Status below comes only from recorded events. No payments are processed in-app. There is no live tracking: a courier’s position is never followed. The detail page shows pickup and drop-off pins on a map when coordinates exist — no route line is drawn and no ETA is shown.</small></div>
  <div class="row"><button class="b ${S.dt === 'queue' ? '' : 'g'}" data-a="dt" data-k="queue">Queue (${q.length})</button><button class="b ${S.dt === 'mine' ? '' : 'g'}" data-a="dt" data-k="mine">My orders (${m.length})</button><span class="f"></span><button class="b" data-a="no">+ Order</button></div>
  <h2>${S.dt === 'queue' ? 'Open for couriers' : 'Sent / carrying'}</h2>` +
    (o === null ? '<div class="sk"></div>'
      : S.dt === 'queue' && !S.courier ? '<div class="c mu">The queue is for registered couriers. Register as a courier from your Profile to browse open orders.</div>'
      : !l.length ? '<div class="c mu">Nothing here yet.</div>'
      : l.map((x) => `<button class="c" data-a="od" data-id="${esc(x.id)}"><b>${esc(x.name)}</b>${x.fragile ? '<span class="tag w">fragile</span>' : ''}<span class="tag">${stateTag(x)}</span>${x.disputed ? '<span class="tag w">DISPUTED</span>' : ''}<br><small>${esc(x.pickup_area)} → ${esc(x.dropoff_area)} · ${esc(x.size)} · offered ${esc(x.fee_offer || 0)} (not charged)</small></button>`).join(''));
}

function oform(v) {
  v.innerHTML = `<h1><span></span>NEW TRANSIT ORDER</h1>${banner()}<div class="c">
  <label>Parcel name<input id="f1" maxlength="60"></label>
  <label>Category<select id="f2"><option>Documents</option><option>Small goods</option><option>Clothing</option><option>Electronics</option><option>Other</option></select></label>
  <label>Size<select id="f3"><option>Small (fits a bag)</option><option>Medium (box)</option><option>Large</option></select></label>
  <label>Weight (kg)<input id="f4" type="number" min="0" step="0.1"></label>
  <label>Pickup area (coarse)<input id="f5" maxlength="60"></label>
  <label>Pickup pin — click the map to place / move the pin<div id="map-pickup" class="map-box"></div></label>
  <div id="coord-pickup" class="map-coord"></div><div id="gps-pickup"></div>
  <label>Pickup coordinates (optional — picked, typed, or one-shot GPS)<div class="row"><input id="f5a" type="number" step="any" min="-90" max="90" placeholder="Latitude, e.g. 23.81" aria-label="Pickup latitude"><input id="f5b" type="number" step="any" min="-180" max="180" placeholder="Longitude, e.g. 90.41" aria-label="Pickup longitude"></div></label>
  <small>Coordinates are stored exactly as picked or typed and labelled user-supplied, unless they came from the one-shot GPS reading — they are never GPS-verified otherwise.</small>
  <label>Drop-off area (coarse)<input id="f6" maxlength="60"></label>
  <label>Drop-off pin — click the map to place / move the pin<div id="map-dropoff" class="map-box"></div></label>
  <div id="coord-dropoff" class="map-coord"></div><div id="gps-dropoff"></div>
  <label>Drop-off coordinates (optional — picked, typed, or one-shot GPS)<div class="row"><input id="f6a" type="number" step="any" min="-90" max="90" placeholder="Latitude" aria-label="Drop-off latitude"><input id="f6b" type="number" step="any" min="-180" max="180" placeholder="Longitude" aria-label="Drop-off longitude"></div></label>
  <small>Coordinates are stored exactly as picked or typed and labelled user-supplied, unless they came from the one-shot GPS reading — they are never GPS-verified otherwise.</small>
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
  // Map pin pickers, kept in sync with the typed coordinate inputs and the
  // one-shot GPS buttons. Typed/picked = user-supplied; GPS = one-shot reading.
  const coordLabel = (loc) => loc
    ? `${fmt(loc.lat, loc.lng)} · ${loc.source === 'gps' ? 'one-shot GPS reading' : 'user-supplied (picked / typed, not GPS-verified)'}`
    : 'No pin placed yet — optional.';
  const wirePicker = (kind, mapEl, coordEl, latEl, lngEl, gpsEl) => {
    const setLoc = (loc) => {
      if (kind === 'pickup') S.pickupLoc = loc; else S.dropoffLoc = loc;
      $(latEl).value = loc ? loc.lat : ''; $(lngEl).value = loc ? loc.lng : '';
      $(coordEl).textContent = coordLabel(loc);
    };
    const picker = mountPinPicker($(mapEl), { onPick: setLoc });
    $(coordEl).textContent = coordLabel(null);
    mountGpsButton($(gpsEl), { label: kind, onReading: (loc) => { picker?.set(loc.lat, loc.lng, 'gps'); setLoc(loc); } });
    const syncFromInputs = () => {
      const lat = Number($(latEl).value), lng = Number($(lngEl).value);
      if ($(latEl).value !== '' && $(lngEl).value !== '' && Number.isFinite(lat) && Number.isFinite(lng)) {
        picker?.setFromInputs(lat, lng); setLoc({ lat, lng, source: 'manual' });
      } else if ($(latEl).value === '' && $(lngEl).value === '') {
        if (kind === 'pickup') S.pickupLoc = null; else S.dropoffLoc = null;
        $(coordEl).textContent = coordLabel(null);
      }
    };
    $(latEl).addEventListener('change', syncFromInputs);
    $(lngEl).addEventListener('change', syncFromInputs);
    return picker;
  };
  wirePicker('pickup', '#map-pickup', '#coord-pickup', '#f5a', '#f5b', '#gps-pickup');
  wirePicker('dropoff', '#map-dropoff', '#coord-dropoff', '#f6a', '#f6b', '#gps-dropoff');
}

function odetail(v) {
  const o = S.order; if (!o) { S.oid = null; return render(); }
  const mine = o.sender_id === me.id, cr = o.courier_id === me.id, part = mine || cr || me.role === 'admin';
  const isMkt = o.fulfillment === 'marketplace';
  const mktCancellable = isMkt ? ['CREATED', 'PREPARED', 'READY_FOR_PICKUP'].includes(o.status) : CANCELLABLE.includes(o.status);
  const mktDropoffEditable = isMkt && ['PREPARED', 'READY_FOR_PICKUP'].includes(o.status);
  const hist = S.history || [];
  const byStatus = {}; hist.forEach((h) => { byStatus[h.to_status] = h.created_at; });
  const tl = STATES.map((n, i) => {
    const e = byStatus[n];
    return `<li class="${e ? 'on' : n === o.status ? 'nx' : ''}"><i></i><b>${(n === 'DELIVERED' && o.fulfillment === 'marketplace') ? 'Item Exchanged' : STATE_LABEL[n]}</b><small>${e ? T(e) : ''}</small></li>`;
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
  <div class="c"><b>Status: ${o.fulfillment === 'marketplace' && o.status === 'DELIVERED' ? 'Item Exchanged' : (STATE_LABEL[o.status] || o.status)}${o.disputed ? ' · DISPUTED' : ''}</b>${o.status === 'CANCELLED' ? '<div class="tag w">CANCELLED</div>' : ''}<ol>${tl}</ol><small>Live location: unavailable — no courier position is ever tracked.</small></div>
  ${S.route ? `<div class="c"><b>Route (road distance, from the map provider)</b><br>${(S.route.distanceKm).toFixed(2)} km · about ${Math.round(S.route.durationMinutes)} min<br><small>${esc(S.route.from.source === 'user-supplied' ? 'Endpoints you supplied, not GPS-verified. ' : '')}${esc(S.route.attribution || '')}</small></div>`
    : `<div class="c"><small>Route: ${esc(S.routeNote || 'no route is shown for this order.')}</small></div>`}
  ${o.photo_file_id ? `<div class="c"><small>Parcel photo is stored privately and visible only to participants.</small></div>` : ''}
  <div class="c"><b>Pickup &amp; drop-off pins</b><div id="omap" class="map-box"></div><div id="omap-note" class="map-coord"></div>
  <small>Pins are shown exactly as stored: user-supplied unless they came from a one-shot GPS reading. No route line is drawn — the route API returns no geometry — and no ETA is shown.</small></div>
  <div id="mkt"></div>
  <div id="dphoto"></div>
  <div id="shareloc"></div>
  <div id="otherrep"></div>
  <div id="rateform"></div>
  ${ac}
  ${mine && S.codes ? `<div class="c" id="cc"><small>Handover codes — share these with the courier / recipient. They expire and can only be used once.</small><br>
    Pickup (give to courier): <b>${S.codes.pickup?.code || '(used / expired)'}</b><br>
    Delivery (give to recipient): <b>${S.codes.dropoff?.code || '(used / expired)'}</b><br>
    <small>Valid until ${S.codes.pickup ? T(S.codes.pickup.expiresAt) : '—'}</small></div>` : ''}
  ${mine ? `<div class="c"><b>Order QR</b><br><img src="/api/deliveries/${esc(o.id)}/qr" alt="Order QR code" class="qr-img"><br><small>The QR holds only the order reference — it never authorizes delivery on its own.</small></div>` : ''}
  ${part && mktCancellable && mine ? `<div class="row"><button class="b r" data-a="cx">Cancel order</button></div>` : ''}
  ${part && !o.disputed && !['DELIVERED', 'CANCELLED'].includes(o.status) ? `<h2>Report a problem</h2><input id="dr" maxlength="200" placeholder="What went wrong?" aria-label="Dispute reason"><button class="b r" data-a="dsp">Open dispute</button>` : ''}
  ${o.disputed ? `<div class="c"><small>Disputed: ${esc(o.dispute_reason || '')} — an admin reviews disputes.</small></div>` : ''}`;
  // Post-render: pins map + marketplace actions. Field names are read
  // defensively (snake_case from the existing API, camelCase from the
  // marketplace contract) because the new backend fields are not yet live.
  const plat = o.pickup_lat ?? o.pickupLat, plng = o.pickup_lng ?? o.pickupLng;
  const dlat = o.dropoff_lat ?? o.dropoffLat, dlng = o.dropoff_lng ?? o.dropoffLng;
  const hasPickup = Number.isFinite(Number(plat)) && Number.isFinite(Number(plng));
  const hasDropoff = Number.isFinite(Number(dlat)) && Number.isFinite(Number(dlng));
  if (hasPickup || hasDropoff) {
    mountPinsMap($('#omap'), [
      ...(hasPickup ? [{ lat: Number(plat), lng: Number(plng), label: 'Pickup' }] : []),
      ...(hasDropoff ? [{ lat: Number(dlat), lng: Number(dlng), label: 'Drop-off' }] : []),
    ]);
    const dsrc = o.dropoff_coord_source || o.dropoffCoordSource;
    $('#omap-note').textContent = `Pickup: ${hasPickup ? fmt(plat, plng) : 'not stored'} · Drop-off: ${hasDropoff ? `${fmt(dlat, dlng)} (${dsrc === 'gps' ? 'one-shot GPS reading' : 'user-supplied'})` : 'not stored'}`;
  } else {
    $('#omap').innerHTML = '<div class="c mu"><small>No coordinates stored for this delivery, so no pins are shown.</small></div>';
  }
  const sellerId = o.seller_id || o.sellerId || o.sender_id;
  const buyerId = o.buyer_id || o.buyerId || o.recipient_id || o.recipientId || o.receiver_id;
  const isSeller = sellerId === me.id, isBuyer = buyerId ? buyerId === me.id : false;
  const terminal = ['DELIVERED', 'CANCELLED'].includes(o.status);
  const dir = (hasPickup && hasDropoff) ? directionsUrl({ lat: plat, lng: plng }, { lat: dlat, lng: dlng }) : null;
  const pay = o.payment || o.payment_record || o.paymentRecord || o.cash_payment || o.cashPayment || null;
  const payPayerId = pay ? (pay.payer_id ?? pay.payerId) : null;
  const payPayeeId = pay ? (pay.payee_id ?? pay.payeeId) : null;
  const payWhen = pay ? (pay.recorded_at ?? pay.recordedAt ?? pay.paidAt ?? pay.paid_at ?? pay.timestamp ?? pay.createdAt) : null;
  const payHtml = o.status === 'DELIVERED'
    ? (pay ? `<div class="c"><b>Cash payment record</b><br><small>Amount: ${esc(pay.amountMinor ?? pay.amount ?? pay.amount_minor ?? '—')} (minor units, as recorded)<br>Payer: ${esc(payPayerId ? (payPayerId === me.id ? 'You (buyer)' : 'Buyer') : '—')} · Payee: ${esc(payPayeeId ? (payPayeeId === me.id ? 'You (seller)' : 'Seller') : '—')}<br>Recorded: ${payWhen ? T(payWhen) : '—'}</small><br><small>This is a payment RECORD only — no money moves in-app.</small></div>`
      : '<div class="c mu"><small>No cash payment record was returned for this delivery.</small></div>')
    : '';
  let mkt = '';
  // 005 guidance copy, shown on every marketplace drop-off/pickup view
  // (not only the pre-pickup editor/buyer blocks, which hide at DELIVERED).
  if (isMkt) {
    mkt += '<div class="c"><small>Meet in a well-lit public place. Check the photo and pin before you travel, and confirm the handover code in person.</small></div>';
  }
  if (isSeller && isMkt && !terminal && (o.status === 'CREATED' || o.status === 'READY_FOR_PICKUP')) {
    mkt += `<div class="c"><b>Seller actions</b><br>
      ${o.status === 'CREATED' ? '<button class="b" data-a="prep">Mark prepared</button>' : ''}
      ${o.status === 'READY_FOR_PICKUP' ? `<label>Confirm handover — code from the buyer<input id="ho-code" inputmode="numeric" maxlength="6" placeholder="6-digit code" aria-label="Handover code"></label>
      <button class="b" data-a="handover">Confirm handover</button>` : ''}</div>`;
  }
  if (isSeller && mktDropoffEditable) {
    mkt += `<div class="c"><b>Set / edit drop-off</b><br><small>Seller only, before pickup. Click the map to move the pin.</small>
      <div id="edit-dropoff-map" class="map-box"></div><div id="edit-dropoff-coord" class="map-coord"></div><div id="edit-dropoff-gps"></div>
      <label>Drop-off area<input id="ed-area" maxlength="60" value="${esc(o.dropoff_area || '')}"></label>
      <label>Drop-off photo (optional)<input id="ed-photo" type="file" accept="image/*" capture="environment"></label>
      <button class="b" data-a="dropoffsave">Save drop-off</button><br>
      <small>Meet in a well-lit public place. Check the photo and pin before you travel, and confirm the handover code in person.</small></div>`;
  }
  if (isBuyer && isMkt && !terminal) {
    mkt += `<div class="c"><b>Buyer actions</b><br>
      ${dir ? `<a href="${esc(dir)}" target="_blank" rel="noopener">Open directions (OpenStreetMap, pickup → drop-off)</a><br>` : '<small>Directions need both pickup and drop-off coordinates.</small><br>'}
      ${o.status === 'READY_FOR_PICKUP' ? '<button class="b" data-a="arrive">Confirm arrival</button>' : '<small>Arrival confirmation opens once the seller sets the drop-off point.</small>'}<br>
      <small>Meet in a well-lit public place. Check the photo and pin before you travel, and confirm the handover code in person.</small></div>`;
  }
  if (!isSeller && !isBuyer && buyerId) mkt += '';
  $('#mkt').innerHTML = mkt + payHtml;
  if (isSeller && mktDropoffEditable) {
    const storedSrc = o.dropoff_coord_source || o.dropoffCoordSource || 'user-supplied';
    S.dropoffPick = hasDropoff ? { lat: Number(dlat), lng: Number(dlng), source: storedSrc } : null;
    S.dropoffPhotoFile = null;
    const ep = mountPinPicker($('#edit-dropoff-map'), {
      initial: S.dropoffPick,
      onPick: (loc) => { S.dropoffPick = loc; const c = $('#edit-dropoff-coord'); if (c) c.textContent = `${fmt(loc.lat, loc.lng)} · ${loc.source === 'gps' ? 'one-shot GPS reading' : 'user-supplied (picked, not GPS-verified)'}`; },
    });
    const c0 = $('#edit-dropoff-coord');
    if (c0) c0.textContent = S.dropoffPick ? `${fmt(S.dropoffPick.lat, S.dropoffPick.lng)} · stored drop-off pin (${storedSrc === 'gps' ? 'one-shot GPS reading' : 'user-supplied'})` : 'No drop-off pin yet — click the map to place one.';
    $('#ed-photo')?.addEventListener('change', (e) => { S.dropoffPhotoFile = e.target.files[0] || null; });
    S.dropoffPicker = ep;
    mountGpsButton($('#edit-dropoff-gps'), { label: 'drop-off', onReading: (loc) => { S.dropoffPicker?.set(loc.lat, loc.lng, 'gps'); } });
  }
  // Drop-off photo for the buyer (and other participants): prefer the signed
  // URL the API returns; otherwise mint one from the stored file id.
  (async () => {
    const box = $('#dphoto'); if (!box) return;
    const url = o.dropoff_photo_url || o.dropoffPhotoUrl || o.dropoff_photo_download_url;
    const fid = o.dropoff_photo_file_id || o.dropoffPhotoFileId;
    let show = url || null;
    if (!show && fid) { try { show = (await api.fileUrl(fid)).data.downloadUrl; } catch { show = null; } }
    if (show) box.innerHTML = `<div class="c"><b>Drop-off photo</b><br><img src="${esc(show)}" class="preview-img" alt="Drop-off place photo"><br><small>Photo of the drop-off place, as supplied by the seller.</small></div>`;
    else if (isBuyer) box.innerHTML = '<div class="c mu"><small>No drop-off photo has been supplied yet.</small></div>';
  })();
  // 005: pickup-location share (READY_FOR_PICKUP only), other party's
  // reputation, and the post-delivery rating form — marketplace only.
  (async () => {
    const otherId = isSeller ? buyerId : (isBuyer ? sellerId : null);
    if (!isMkt || !otherId) return;
    const repBox = $('#otherrep');
    if (repBox && ['READY_FOR_PICKUP', 'DELIVERED'].includes(o.status)) {
      try {
        const rep = (await api.userReputation(otherId)).data;
        repBox.innerHTML = `<div class="c"><b>Other party's reputation</b><br><small>${rep.avgStars === null
          ? 'No ratings yet'
          : `★ ${Number(rep.avgStars).toFixed(1)} · ${rep.ratingsCount} rating${rep.ratingsCount === 1 ? '' : 's'} · ${rep.completedDeliveries} completed deliver${rep.completedDeliveries === 1 ? 'y' : 'ies'}`}</small><br><small>Computed only from real completed deliveries and ratings — never estimated.</small></div>`;
      } catch { /* reputation unavailable */ }
    }
    if (o.status === 'DELIVERED' && (isSeller || isBuyer)) {
      const rf = $('#rateform');
      if (rf) rf.innerHTML = `<div class="c"><b>Rate the other party</b><br>
        <label>Stars<select id="rt-stars"><option value="5">5 ★</option><option value="4">4 ★</option><option value="3">3 ★</option><option value="2">2 ★</option><option value="1">1 ★</option></select></label>
        <label>Comment (optional)<input id="rt-comment" maxlength="500" placeholder="How did the handoff go?"></label>
        <button class="b" data-a="ratesubmit">Submit rating</button><br><small>One rating per delivery. Only delivered orders can be rated.</small></div>`;
    }
    if (o.status === 'READY_FOR_PICKUP' && (isSeller || isBuyer)) {
      const sl = $('#shareloc');
      if (!sl) return;
      sl.innerHTML = `<div class="c"><b>Live pickup location (30 minutes)</b><br>
        <small>Share one reading of your current position with the other participant, only while the order is ready for pickup. It expires after 30 minutes and is never tracked afterwards.</small>
        <div id="share-gps"></div><div id="share-map" class="map-box"></div><div id="share-note" class="map-coord"></div></div>`;
      mountGpsButton($('#share-gps'), { label: 'pickup location share (30 minutes, one reading only)',
        onReading: async (loc) => {
          try { await api.sharePickupLocation(o.id, loc.lat, loc.lng); toast('Pickup location shared for 30 minutes'); await openOrder(o.id); }
          catch (e) { toast(e.message); }
        } });
      try {
        const sh = (await api.pickupLocation(o.id)).data.share;
        if (sh) {
          const mine = sh.sharerId === me.id;
          $('#share-note').textContent = mine
            ? `You shared ${fmt(sh.lat, sh.lng)} — expires ${T(sh.expiresAt)}.`
            : `Other participant shared ${fmt(sh.lat, sh.lng)} — expires ${T(sh.expiresAt)}.`;
          mountPinsMap($('#share-map'), [{ lat: sh.lat, lng: sh.lng, label: mine ? 'Your shared location' : 'Other participant' }]);
        } else {
          $('#share-note').textContent = 'No live pickup location is being shared right now.';
        }
      } catch { /* no share */ }
    }
  })();
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
      : mine.map((x) => `<button class="c" data-a="od" data-id="${esc(x.id)}"><b>${esc(x.name)}</b> → ${stateTag(x)}<br><small>${T(x.updated_at)}</small></button>`).join(''));
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
  <div class="c"><small><b>Not included in this build:</b> live GPS tracking, push notifications, E2EE, in-app payments. Maps show stored pickup/drop-off pins only — no route line is drawn, no ETA is shown, and no position is tracked. Map routing distance/duration is shown only when a provider is configured.</small></div>`;
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
    S.requests = null; S.reqShowForm = false; S.reqEdit = null;
    S.pins = null; S.thread = null; S.glog = null; S.invites = null; S.joinReqs = null; S.confirmTransfer = null;
    S.pendingAttachment = null; S.pendingAttachmentName = null;
    render();
    const page = await api.messages(id, 1);
    S.msgs = page.data.slice().reverse();
    S.msgPages = page.meta.pages;
    // Read-mark is best-effort: it must never block rendering or the socket
    // join (a failed markRead previously left the message list empty forever).
    try { await api.markRead(id); } catch { /* unread count refreshes next load */ }
    draw();
    loadRequests();
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
  // The click listener passes the [data-a] element as `el`, not the event,
  // so the event target comes from the listener's global e0 (set before
  // dispatch). Reading el.target here used to throw, which silently broke
  // message selection — and with it the reply/edit/react panels.
  sel(d, el) { if (e0.target.closest('button,a,input')) return; S.sel = S.sel === d.id ? null : d.id; S.editing = null; draw(); },
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
  // --- 005: reactions / threads / pins / group admin ---
  async react(d) {
    try {
      await api.toggleReaction(d.id, d.e);
      const page = await api.messages(S.conv.id, 1);
      S.msgs = page.data.slice().reverse(); draw();
    } catch (e) { toast(e.message); }
  },
  async thread(d) { await loadThread(d.id); },
  threadx() { S.thread = null; draw(); },
  async threadsend() {
    const v = $('#th-in').value.trim(); if (!v || !S.thread) return;
    try {
      await api.sendMessage(S.conv.id, { body: v, replyToId: S.thread.parent.id });
      $('#th-in').value = '';
      await loadThread(S.thread.parent.id);
      const page = await api.messages(S.conv.id, 1);
      S.msgs = page.data.slice().reverse(); S.msgPage = 1; S.msgPages = page.meta.pages; draw();
    } catch (e) { toast(e.message); }
  },
  async pin(d) { try { await api.pinMessage(S.conv.id, d.id); toast('Pinned'); await loadGroupExtras(); } catch (e) { toast(e.message); } },
  async unpin(d) { try { await api.unpinMessage(S.conv.id, d.id); toast('Unpinned'); await loadGroupExtras(); } catch (e) { toast(e.message); } },
  async rulessave() {
    try { await api.updateGroupRules(S.conv.id, $('#gr-in').value.trim()); toast('Rules saved'); await openConv(S.conv.id); } catch (e) { toast(e.message); }
  },
  async roleset(d) {
    const sel = document.getElementById(`role-${d.id}`);
    if (!sel) return;
    try { await api.setMemberRole(S.conv.id, d.id, sel.value); toast('Role updated'); await openConv(S.conv.id); } catch (e) { toast(e.message); }
  },
  async memberrm(d) { try { await api.removeMember(S.conv.id, d.id); toast('Member removed'); await openConv(S.conv.id); } catch (e) { toast(e.message); } },
  async transfer(d) {
    if (S.confirmTransfer !== d.id) {
      S.confirmTransfer = d.id; renderGroupExtras();
      setTimeout(() => { if (S.confirmTransfer === d.id) { S.confirmTransfer = null; renderGroupExtras(); } }, 4000);
      return;
    }
    try { await api.transferOwnership(S.conv.id, d.id); toast('Ownership transferred'); await openConv(S.conv.id); } catch (e) { toast(e.message); }
  },
  async invcreate() {
    const raw = $('#inv-uses').value.trim();
    try { await api.createInvite(S.conv.id, raw === '' ? {} : { maxUses: Math.max(1, Math.round(Number(raw))) }); toast('Invite created'); await loadGroupExtras(); } catch (e) { toast(e.message); }
  },
  async joinok(d) { try { await api.decideJoinRequest(S.conv.id, d.id, 'approve'); toast('Join approved'); await loadGroupExtras(); } catch (e) { toast(e.message); } },
  async joinno(d) { try { await api.decideJoinRequest(S.conv.id, d.id, 'decline'); toast('Join declined'); await loadGroupExtras(); } catch (e) { toast(e.message); } },
  async joincode() {
    const code = $('#jc-code').value.trim(); if (!code) return;
    try { const r = await api.joinByCode(code); toast('Joined group'); await loadChats(); await openConv(r.data.conversationId); } catch (e) { toast(e.message); }
  },
  async groupjoinreq() {
    const id = $('#jr-id').value.trim(); if (!id) return;
    try { await api.createJoinRequest(id); toast('Join request sent — an owner/admin must approve it'); } catch (e) { toast(e.message); }
  },
  async ratesubmit() {
    const stars = Number($('#rt-stars').value);
    const comment = $('#rt-comment').value.trim() || undefined;
    try { await api.rateDelivery(S.oid, stars, comment); toast('Rating submitted'); await openOrder(S.oid); } catch (e) { toast(e.message); }
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
  // --- delivery requests + settings ---
  reqform() { S.reqShowForm = !S.reqShowForm; S.reqEdit = null; renderRequests(); },
  async reqcreate() {
    const title = $('#rq-title').value.trim(), desc = $('#rq-desc').value.trim();
    if (!title) return toast('Title is required');
    const priceRaw = $('#rq-price').value.trim();
    const body = { conversationId: S.conv.id, title, description: desc || undefined,
      priceMinor: priceRaw === '' ? undefined : Math.max(0, Math.round(Number(priceRaw))),
      note: $('#rq-note').value.trim() || undefined };
    if (S.conv.type === 'group') body.targetId = $('#rq-target').value;
    else if (S.conv.type === 'dm') {
      const other = (S.conv.members || []).find((m) => m.id !== me?.id);
      if (other) body.targetId = other.id;
    }
    if (body.priceMinor !== undefined && !Number.isFinite(body.priceMinor)) return toast('Price must be a number (minor units)');
    try { await api.createDeliveryRequest(body); S.reqShowForm = false; toast('Request sent'); await loadRequests(); }
    catch (e) { toast(e.message); }
  },
  async reqaccept(d) { try { await api.acceptDeliveryRequest(d.id); toast('Request accepted'); await loadRequests(); } catch (e) { toast(e.message); } },
  async reqdecline(d) { try { await api.declineDeliveryRequest(d.id); toast('Request declined'); await loadRequests(); } catch (e) { toast(e.message); } },
  async reqcancel(d) { try { await api.cancelDeliveryRequest(d.id); toast('Request cancelled'); await loadRequests(); } catch (e) { toast(e.message); } },
  reqedit(d) { S.reqEdit = S.reqEdit === d.id ? null : d.id; renderRequests(); },
  async reqsave(d) {
    const priceRaw = $('#rq-eprice').value.trim();
    const patch = { note: $('#rq-enote').value.trim() || undefined,
      priceMinor: priceRaw === '' ? undefined : Math.max(0, Math.round(Number(priceRaw))) };
    try { await api.updateDeliveryRequest(d.id, patch); S.reqEdit = null; toast('Request updated'); await loadRequests(); }
    catch (e) { toast(e.message); }
  },
  async dsetsave() {
    try {
      await api.updateDeliverySettings(S.conv.id, { enabled: $('#ds-en').checked });
      toast('Delivery settings saved'); await openConv(S.conv.id);
    } catch (e) { toast(e.message); }
  },
  // --- marketplace delivery actions ---
  async prep() { try { await api.prepareDelivery(S.oid); toast('Marked prepared'); await openOrder(S.oid); } catch (e) { toast(e.message); } },
  async dropoffsave() {
    if (!S.dropoffPick) return toast('Place a drop-off pin on the map first');
    if (S.busy) return; S.busy = true;
    try {
      let photoFileId;
      if (S.dropoffPhotoFile) {
        // Existing private-file endpoint; it also stores the id on the
        // delivery, and the id is passed to the dropoff PATCH per contract.
        const up = await api.uploadParcelPhoto(S.oid, S.dropoffPhotoFile);
        photoFileId = up.data.id;
      }
      await api.updateDropoff(S.oid, {
        dropoffLat: S.dropoffPick.lat, dropoffLng: S.dropoffPick.lng,
        dropoffArea: $('#ed-area').value.trim() || undefined,
        dropoffPhotoFileId: photoFileId,
        dropoffCoordSource: S.dropoffPick.source || 'user-supplied',
      });
      toast('Drop-off saved'); await openOrder(S.oid);
    } catch (e) { toast(e.message); }
    S.busy = false;
  },
  async arrive() { try { await api.arriveDelivery(S.oid); toast('Arrival confirmed'); await openOrder(S.oid); } catch (e) { toast(e.message); } },
  async handover() {
    const code = ($('#ho-code').value || '').trim();
    if (!/^\d{6}$/.test(code)) return toast('Enter the 6-digit code');
    try { await api.handoverDelivery(S.oid, code); toast('Handover confirmed'); await openOrder(S.oid); } catch (e) { toast(e.message); }
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
