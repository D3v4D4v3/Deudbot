// ===== State =====
let currentSection = 'chat';
let deudores = [];
let waStatusInterval = null;

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  startWAStatusPolling();
  loadConfig();
  
  // Focus chat input
  const chatInput = document.getElementById('chat-input');
  if (chatInput) chatInput.focus();

  const searchInput = document.getElementById('search-deudores');
  if (searchInput) searchInput.addEventListener('input', filterDeudores);
});

// ===== Navigation =====
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      switchSection(btn.dataset.section);
    });
  });
}

function switchSection(section) {
  currentSection = section;
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.section === section);
  });
  document.querySelectorAll('.content-section').forEach(sec => {
    sec.classList.toggle('active', sec.id === `section-${section}`);
  });
  if (section === 'dashboard') loadDashboard();
  if (section === 'deudores') loadDeudores();
  if (section === 'mensajes') loadMensajes();
  if (section === 'configuracion') loadConfig();
  if (section === 'chat') {
    setTimeout(() => document.getElementById('chat-input')?.focus(), 100);
  }
}

// ===== API Helper =====
async function api(url, options = {}) {
  try {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error desconocido');
    return data;
  } catch (err) {
    console.error('API Error:', err);
    throw err;
  }
}

// =======================================
// ===== CHAT FUNCTIONALITY (MAIN) =====
// =======================================

function handleChatSubmit(event) {
  event.preventDefault();
  const input = document.getElementById('chat-input');
  const command = input.value.trim();
  if (!command) return;
  
  // Add user message to chat
  addChatMessage(command, 'user');
  input.value = '';
  input.focus();
  
  // Show typing indicator
  showTypingIndicator();
  
  // Send command to server
  processChatCommand(command);
}

function addChatMessage(content, sender, isHtml = false) {
  const messagesDiv = document.getElementById('chat-messages');
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-msg ${sender}`;
  
  const now = new Date();
  const time = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  
  const bubbleContent = isHtml ? content : escapeHtml(content);
  
  msgDiv.innerHTML = `
    <div class="chat-bubble ${sender}">
      <div class="chat-bubble-content">${bubbleContent}</div>
      <div class="chat-time">${time}</div>
    </div>
  `;
  
  messagesDiv.appendChild(msgDiv);
  scrollChatToBottom();
}

function showTypingIndicator() {
  const messagesDiv = document.getElementById('chat-messages');
  const typingDiv = document.createElement('div');
  typingDiv.className = 'chat-msg bot';
  typingDiv.id = 'typing-indicator';
  typingDiv.innerHTML = `
    <div class="chat-bubble bot">
      <div class="typing-indicator">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>
    </div>
  `;
  messagesDiv.appendChild(typingDiv);
  scrollChatToBottom();
}

function hideTypingIndicator() {
  const typing = document.getElementById('typing-indicator');
  if (typing) typing.remove();
}

async function processChatCommand(command) {
  try {
    const data = await api('/api/chat/command', {
      method: 'POST',
      body: { command }
    });
    
    hideTypingIndicator();
    addChatMessage(data.response, 'bot', true);
    
  } catch (err) {
    hideTypingIndicator();
    addChatMessage(`❌ Error: ${err.message}`, 'bot', true);
  }
}

function scrollChatToBottom() {
  const messagesDiv = document.getElementById('chat-messages');
  requestAnimationFrame(() => {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  });
}

// ===== Dashboard =====
async function loadDashboard() {
  try {
    const stats = await api('/api/estadisticas');
    document.getElementById('val-total-deudores').textContent = stats.totalDeudores;
    document.getElementById('val-total-deuda').textContent = `$${stats.totalDeuda.toFixed(2)}`;
    document.getElementById('val-con-deuda').textContent = stats.deudoresConDeuda;
    document.getElementById('val-mensajes-hoy').textContent = stats.mensajesHoy;

    const deudoresList = await api('/api/deudores');
    const topDeudores = deudoresList
      .filter(d => d.deuda_total > 0)
      .sort((a, b) => b.deuda_total - a.deuda_total)
      .slice(0, 5);

    const topList = document.getElementById('top-deudores-list');
    if (topDeudores.length === 0) {
      topList.innerHTML = '<p class="empty-state">No hay deudas pendientes 🎉</p>';
    } else {
      topList.innerHTML = topDeudores.map(d => `
        <div class="top-deudor-item">
          <div class="top-deudor-info">
            <span class="top-deudor-name">${escapeHtml(d.nombre)}</span>
            <span class="top-deudor-phone">${d.telefono}</span>
          </div>
          <span class="top-deudor-amount">$${d.deuda_total.toFixed(2)}</span>
        </div>
      `).join('');
    }

    const mensajes = await api('/api/mensajes/log');
    const actList = document.getElementById('activity-list');
    if (mensajes.length === 0) {
      actList.innerHTML = '<p class="empty-state">Sin actividad reciente</p>';
    } else {
      actList.innerHTML = mensajes.slice(0, 8).map(m => {
        const icon = m.tipo === 'recordatorio' ? '🔔' : m.tipo === 'manual' ? '📤' : '🤖';
        const time = formatRelativeTime(m.fecha);
        return `
          <div class="activity-item">
            <span class="activity-icon">${icon}</span>
            <span class="activity-text"><strong>${escapeHtml(m.deudor_nombre || 'Desconocido')}</strong> — ${m.tipo}</span>
            <span class="activity-time">${time}</span>
          </div>
        `;
      }).join('');
    }
  } catch (err) {
    console.error('Error loading dashboard:', err);
  }
}

// ===== Deudores =====
async function loadDeudores() {
  try {
    deudores = await api('/api/deudores');
    renderDeudores(deudores);
  } catch (err) {
    console.error('Error loading deudores:', err);
  }
}

function renderDeudores(list) {
  const tbody = document.getElementById('tbody-deudores');
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No hay deudores. Escribe en el chat: <code>nuevo Juan 5512345678</code></td></tr>';
    return;
  }
  tbody.innerHTML = list.map(d => `
    <tr>
      <td><strong>${escapeHtml(d.nombre)}</strong></td>
      <td>${d.telefono}</td>
      <td><span class="deuda-amount ${d.deuda_total <= 0 ? 'paid' : ''}">$${d.deuda_total.toFixed(2)}</span></td>
      <td style="color: var(--text-muted); font-size: 0.85rem;">${escapeHtml(d.notas || '-')}</td>
      <td>
        <div class="table-actions">
          <button class="btn btn-sm btn-success" onclick="openPagoModal(${d.id}, 'pago')" title="Registrar pago">💵</button>
          <button class="btn btn-sm btn-primary" onclick="sendSingleReminder(${d.id})" title="Enviar recordatorio">📤</button>
          <button class="btn btn-sm btn-secondary" onclick="openModal('edit', ${d.id})" title="Editar">✏️</button>
          <button class="btn btn-sm btn-danger" onclick="deleteDeudor(${d.id}, '${escapeHtml(d.nombre)}')" title="Eliminar">🗑️</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function filterDeudores() {
  const query = document.getElementById('search-deudores').value.toLowerCase();
  const filtered = deudores.filter(d => 
    d.nombre.toLowerCase().includes(query) || d.telefono.includes(query)
  );
  renderDeudores(filtered);
}

// ===== Modal =====
function openModal(mode, id = null) {
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const form = document.getElementById('deudor-form');
  form.reset();
  document.getElementById('form-deudor-id').value = '';
  
  if (mode === 'edit' && id) {
    const d = deudores.find(d => d.id === id);
    if (d) {
      title.textContent = 'Editar Deudor';
      document.getElementById('form-deudor-id').value = d.id;
      document.getElementById('form-nombre').value = d.nombre;
      document.getElementById('form-telefono').value = d.telefono;
      document.getElementById('form-deuda').value = d.deuda_total;
      document.getElementById('form-notas').value = d.notas || '';
    }
  } else {
    title.textContent = 'Agregar Deudor';
  }
  overlay.classList.add('show');
}

function closeModal(event) {
  if (event && event.target !== document.getElementById('modal-overlay')) return;
  document.getElementById('modal-overlay').classList.remove('show');
}

async function saveDeudor(event) {
  event.preventDefault();
  const id = document.getElementById('form-deudor-id').value;
  const data = {
    nombre: document.getElementById('form-nombre').value.trim(),
    telefono: document.getElementById('form-telefono').value.trim(),
    deuda_total: parseFloat(document.getElementById('form-deuda').value) || 0,
    notas: document.getElementById('form-notas').value.trim()
  };
  if (!data.nombre || !data.telefono) { showToast('Nombre y teléfono requeridos', 'error'); return; }
  try {
    if (id) {
      await api(`/api/deudores/${id}`, { method: 'PUT', body: data });
      showToast('Deudor actualizado ✅', 'success');
    } else {
      await api('/api/deudores', { method: 'POST', body: data });
      showToast('Deudor agregado ✅', 'success');
    }
    closeModal();
    loadDeudores();
    loadDashboard();
  } catch (err) { showToast(err.message, 'error'); }
}

async function deleteDeudor(id, nombre) {
  if (!confirm(`¿Eliminar a ${nombre}?`)) return;
  try {
    await api(`/api/deudores/${id}`, { method: 'DELETE' });
    showToast(`${nombre} eliminado`, 'success');
    loadDeudores();
    loadDashboard();
  } catch (err) { showToast(err.message, 'error'); }
}

// ===== Pago Modal =====
function openPagoModal(deudorId, tipo) {
  document.getElementById('pago-deudor-id').value = deudorId;
  document.getElementById('pago-tipo').value = tipo;
  document.getElementById('pago-modal-title').textContent = tipo === 'pago' ? '💵 Registrar Pago' : '📝 Agregar Cargo';
  document.getElementById('btn-save-pago').textContent = tipo === 'pago' ? 'Registrar Pago' : 'Agregar Cargo';
  document.getElementById('pago-form').reset();
  document.getElementById('pago-modal-overlay').classList.add('show');
}

function closePagoModal(event) {
  if (event && event.target !== document.getElementById('pago-modal-overlay')) return;
  document.getElementById('pago-modal-overlay').classList.remove('show');
}

async function savePago(event) {
  event.preventDefault();
  const deudorId = document.getElementById('pago-deudor-id').value;
  const tipo = document.getElementById('pago-tipo').value;
  const monto = parseFloat(document.getElementById('pago-monto').value);
  const concepto = document.getElementById('pago-concepto').value.trim();
  if (!monto || monto <= 0) { showToast('Monto debe ser mayor a 0', 'error'); return; }
  try {
    const endpoint = tipo === 'pago' ? 'pagos' : 'cargos';
    await api(`/api/deudores/${deudorId}/${endpoint}`, { method: 'POST', body: { monto, concepto } });
    showToast(tipo === 'pago' ? 'Pago registrado ✅' : 'Cargo agregado', 'success');
    closePagoModal();
    loadDeudores();
    loadDashboard();
  } catch (err) { showToast(err.message, 'error'); }
}

// ===== WhatsApp =====
function startWAStatusPolling() {
  checkWAStatus();
  waStatusInterval = setInterval(checkWAStatus, 3000);
}

async function checkWAStatus() {
  try {
    const data = await api('/api/whatsapp/status');
    updateWAUI(data);
  } catch (err) { /* silent */ }
}

function updateWAUI(data) {
  const { status, qr, info } = data;
  
  // Update sidebar badge
  const badge = document.getElementById('wa-status-badge');
  badge.className = `nav-badge ${status === 'ready' ? 'connected' : 'disconnected'}`;
  
  // Update sidebar mini status
  const miniStatus = document.getElementById('wa-mini-status');
  const dot = miniStatus.querySelector('.status-dot');
  const label = miniStatus.querySelector('span:last-child');
  
  // Update chat header indicator
  const chatDot = document.getElementById('chat-wa-dot');
  const chatLabel = document.getElementById('chat-wa-label');
  
  switch (status) {
    case 'ready':
      dot.className = 'status-dot connected';
      label.textContent = 'Conectado';
      if (chatDot) { chatDot.className = 'status-dot connected'; chatLabel.textContent = 'WhatsApp ✅'; }
      updateWASection('ready', qr, info);
      break;
    case 'qr':
      dot.className = 'status-dot connecting';
      label.textContent = 'Esperando QR...';
      if (chatDot) { chatDot.className = 'status-dot connecting'; chatLabel.textContent = 'Escaneando...'; }
      updateWASection('qr', qr, info);
      break;
    case 'connecting':
      dot.className = 'status-dot connecting';
      label.textContent = 'Conectando...';
      if (chatDot) { chatDot.className = 'status-dot connecting'; chatLabel.textContent = 'Conectando...'; }
      updateWASection('connecting', qr, info);
      break;
    default:
      dot.className = 'status-dot disconnected';
      label.textContent = 'Desconectado';
      if (chatDot) { chatDot.className = 'status-dot disconnected'; chatLabel.textContent = 'WhatsApp ❌'; }
      updateWASection('disconnected', qr, info);
  }
}

function updateWASection(status, qr, info) {
  const statusIcon = document.getElementById('wa-status-icon');
  const statusText = document.getElementById('wa-status-text');
  const statusDesc = document.getElementById('wa-status-desc');
  const qrContainer = document.getElementById('wa-qr-container');
  const qrImage = document.getElementById('wa-qr-image');
  const btnConnect = document.getElementById('btn-wa-connect');
  const btnDisconnect = document.getElementById('btn-wa-disconnect');
  const connectedInfo = document.getElementById('wa-connected-info');
  
  if (!statusIcon) return; // section not in DOM yet

  switch (status) {
    case 'ready':
      statusIcon.textContent = '✅'; statusIcon.className = 'wa-status-icon connected';
      statusText.textContent = '¡Conectado!'; statusDesc.textContent = 'WhatsApp listo para enviar mensajes';
      qrContainer.style.display = 'none';
      btnConnect.style.display = 'none'; btnDisconnect.style.display = 'inline-flex';
      connectedInfo.style.display = 'block';
      if (info) document.getElementById('wa-connected-name').textContent = info.pushname || info.phone;
      break;
    case 'qr':
      statusIcon.textContent = '📱'; statusIcon.className = 'wa-status-icon';
      statusText.textContent = 'Escanea el código QR'; statusDesc.textContent = 'Abre WhatsApp en tu teléfono y escanea';
      if (qr) { qrContainer.style.display = 'flex'; qrImage.src = qr; }
      btnConnect.style.display = 'none'; btnDisconnect.style.display = 'none';
      connectedInfo.style.display = 'none';
      break;
    case 'connecting':
      statusIcon.textContent = '⏳'; statusIcon.className = 'wa-status-icon';
      statusText.textContent = 'Conectando...'; statusDesc.textContent = 'Autenticando con WhatsApp';
      qrContainer.style.display = 'none';
      btnConnect.style.display = 'none'; btnDisconnect.style.display = 'none';
      connectedInfo.style.display = 'none';
      break;
    default:
      statusIcon.textContent = '📱'; statusIcon.className = 'wa-status-icon';
      statusText.textContent = 'Desconectado'; statusDesc.textContent = 'Conecta tu WhatsApp para enviar mensajes';
      qrContainer.style.display = 'none';
      btnConnect.style.display = 'inline-flex'; btnDisconnect.style.display = 'none';
      connectedInfo.style.display = 'none';
  }
}

async function connectWhatsApp() {
  try {
    const btn = document.getElementById('btn-wa-connect');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Conectando...';
    await api('/api/whatsapp/connect', { method: 'POST' });
    showToast('Iniciando conexión con WhatsApp...', 'info');
  } catch (err) { showToast(err.message, 'error'); }
  finally {
    const btn = document.getElementById('btn-wa-connect');
    btn.disabled = false;
    btn.innerHTML = 'Conectar WhatsApp';
  }
}

async function disconnectWhatsApp() {
  if (!confirm('¿Desconectar WhatsApp?')) return;
  try {
    await api('/api/whatsapp/disconnect', { method: 'POST' });
    showToast('WhatsApp desconectado', 'info');
  } catch (err) { showToast(err.message, 'error'); }
}

async function sendSingleReminder(deudorId) {
  try {
    await api('/api/mensajes/enviar', { method: 'POST', body: { deudor_id: deudorId } });
    showToast('Recordatorio enviado ✅', 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

async function sendAllReminders() {
  if (!confirm('¿Enviar recordatorio a TODOS los deudores con saldo pendiente?')) return;
  const btn = document.getElementById('btn-send-all');
  const resultDiv = document.getElementById('send-all-result');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Enviando...';
  resultDiv.innerHTML = '';
  try {
    const result = await api('/api/mensajes/enviar-todos', { method: 'POST' });
    resultDiv.innerHTML = `<div style="padding: 12px; background: rgba(34,197,94,0.1); border-radius: 8px; color: var(--accent-success);">✅ ${result.enviados} enviados, ${result.errores} errores</div>`;
    showToast(result.message, 'success');
  } catch (err) {
    resultDiv.innerHTML = `<div style="padding: 12px; background: rgba(239,68,68,0.1); border-radius: 8px; color: var(--accent-danger);">❌ ${err.message}</div>`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🚀 Enviar a Todos';
  }
}

// ===== Mensajes =====
async function loadMensajes() {
  try {
    const mensajes = await api('/api/mensajes/log');
    const tbody = document.getElementById('tbody-mensajes');
    if (mensajes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No hay mensajes registrados</td></tr>';
      return;
    }
    tbody.innerHTML = mensajes.map(m => {
      const tipoBadge = m.tipo === 'recordatorio' ? 'badge-recordatorio' : m.tipo === 'manual' ? 'badge-manual' : 'badge-auto';
      const estadoBadge = m.estado === 'enviado' ? 'badge-success' : m.estado === 'error' ? 'badge-error' : 'badge-auto';
      return `
        <tr>
          <td style="white-space: nowrap; font-size: 0.8rem; color: var(--text-muted);">${formatDate(m.fecha)}</td>
          <td><strong>${escapeHtml(m.deudor_nombre || 'N/A')}</strong></td>
          <td><span class="badge ${tipoBadge}">${m.tipo}</span></td>
          <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; font-size: 0.85rem; color: var(--text-secondary);">${escapeHtml(m.mensaje)}</td>
          <td><span class="badge ${estadoBadge}">${m.estado}</span></td>
        </tr>
      `;
    }).join('');
  } catch (err) { console.error('Error loading mensajes:', err); }
}

// ===== Configuración =====
async function loadConfig() {
  try {
    const config = await api('/api/configuracion');
    document.getElementById('config-msg-recordatorio').value = config.mensaje_recordatorio || '';
    document.getElementById('config-msg-respuesta').value = config.mensaje_respuesta || '';
    document.getElementById('config-cron-activo').checked = config.cron_activo === '1';
    document.getElementById('config-cron-horario').value = config.cron_horario || '09:00';
    const dias = (config.cron_dias || '').split(',');
    document.querySelectorAll('#days-selector input[type="checkbox"]').forEach(cb => {
      cb.checked = dias.includes(cb.value);
    });
  } catch (err) { console.error('Error loading config:', err); }
}

async function saveConfig() {
  const dias = [];
  document.querySelectorAll('#days-selector input[type="checkbox"]:checked').forEach(cb => dias.push(cb.value));
  const config = {
    mensaje_recordatorio: document.getElementById('config-msg-recordatorio').value,
    mensaje_respuesta: document.getElementById('config-msg-respuesta').value,
    cron_activo: document.getElementById('config-cron-activo').checked ? '1' : '0',
    cron_horario: document.getElementById('config-cron-horario').value,
    cron_dias: dias.join(',')
  };
  try {
    await api('/api/configuracion', { method: 'PUT', body: config });
    showToast('Configuración guardada ✅', 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

// ===== Utilities =====
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hide');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'Ahora';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return formatDate(dateStr);
}
