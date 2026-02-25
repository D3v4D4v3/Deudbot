const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cron = require('node-cron');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== WhatsApp Client Setup =====
let whatsappClient = null;
let whatsappStatus = 'disconnected'; // disconnected, qr, connecting, ready
let currentQR = null;
let clientInfo = null;
let cronJob = null;

// Find Chrome executable on Windows
function findChromePath() {
  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const fs = require('fs');
  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function initWhatsApp() {
  const chromePath = findChromePath();
  const puppeteerConfig = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  };
  if (chromePath) {
    puppeteerConfig.executablePath = chromePath;
    console.log(`🌐 Usando navegador: ${chromePath}`);
  }

  whatsappClient = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
    puppeteer: puppeteerConfig
  });

  whatsappClient.on('qr', async (qr) => {
    console.log('📱 QR Code recibido. Escanea con WhatsApp.');
    whatsappStatus = 'qr';
    try {
      currentQR = await qrcode.toDataURL(qr);
    } catch (err) {
      console.error('Error generando QR:', err);
    }
  });

  whatsappClient.on('ready', () => {
    console.log('✅ WhatsApp conectado correctamente.');
    whatsappStatus = 'ready';
    currentQR = null;
    clientInfo = whatsappClient.info;
    setupCron();
  });

  whatsappClient.on('authenticated', () => {
    console.log('🔐 Autenticado correctamente.');
    whatsappStatus = 'connecting';
  });

  whatsappClient.on('auth_failure', (msg) => {
    console.error('❌ Error de autenticación:', msg);
    whatsappStatus = 'disconnected';
  });

  whatsappClient.on('disconnected', (reason) => {
    console.log('🔌 WhatsApp desconectado:', reason);
    whatsappStatus = 'disconnected';
    currentQR = null;
    clientInfo = null;
  });

  // Auto-respond to incoming messages
  whatsappClient.on('message', async (msg) => {
    try {
      if (msg.fromMe) return;
      
      const senderNumber = msg.from.replace('@c.us', '');
      const messageBody = msg.body.toLowerCase().trim();
      
      const keywords = ['deuda', 'debo', 'cuanto debo', 'cuánto debo', 'saldo', 'mi deuda', 
                        'cuanto es', 'cuánto es', 'pendiente', 'cobro', 'pagar', 'monto',
                        'hola', 'info', 'información', 'informacion', 'estado'];
      
      const isAskingDebt = keywords.some(kw => messageBody.includes(kw));
      
      if (isAskingDebt) {
        const deudor = db.getDeudorByTelefono(senderNumber);
        
        if (deudor) {
          let plantilla = db.getConfig('mensaje_respuesta') || 
            'Hola {nombre}, tu deuda actual es de ${deuda}.';
          
          const mensaje = formatMensaje(plantilla, deudor);
          await msg.reply(mensaje);
          db.logMensaje(deudor.id, 'auto-respuesta', mensaje, 'enviado');
          console.log(`🤖 Auto-respuesta enviada a ${deudor.nombre}`);
        } else {
          await msg.reply('Hola, no encontré tu número registrado en el sistema. Contacta al administrador para más información.');
          db.logMensaje(null, 'auto-respuesta', `Número no registrado: ${senderNumber}`, 'info');
        }
      }
    } catch (err) {
      console.error('Error procesando mensaje:', err);
    }
  });

  console.log('🔄 Iniciando conexión con WhatsApp...');
  whatsappClient.initialize();
}

function formatMensaje(plantilla, deudor) {
  return plantilla
    .replace(/{nombre}/g, deudor.nombre)
    .replace(/\$\{deuda\}/g, `$${deudor.deuda_total.toFixed(2)}`)
    .replace(/{telefono}/g, deudor.telefono)
    .replace(/{notas}/g, deudor.notas || '');
}

async function sendWhatsAppMessage(telefono, mensaje) {
  if (whatsappStatus !== 'ready' || !whatsappClient) {
    throw new Error('WhatsApp no está conectado');
  }
  
  let cleanPhone = telefono.replace(/\D/g, '');
  
  // Validate phone number
  if (cleanPhone.length < 10 || cleanPhone === '0000000000') {
    throw new Error('Número de teléfono no válido');
  }
  
  // Build possible chat IDs for Mexican numbers
  // Mexico numbers can be registered as 52XXXXXXXXXX or 521XXXXXXXXXX on WhatsApp
  const candidates = [];
  
  if (cleanPhone.length === 10) {
    // Raw 10-digit number: try both 52+number and 521+number
    candidates.push('52' + cleanPhone + '@c.us');
    candidates.push('521' + cleanPhone + '@c.us');
  } else if (cleanPhone.startsWith('521') && cleanPhone.length === 13) {
    // Already has 521 prefix: try as-is and without the 1
    candidates.push(cleanPhone + '@c.us');
    candidates.push('52' + cleanPhone.slice(3) + '@c.us');
  } else if (cleanPhone.startsWith('52') && cleanPhone.length === 12) {
    // Has 52 prefix without 1: try as-is and with the 1
    candidates.push(cleanPhone + '@c.us');
    candidates.push('521' + cleanPhone.slice(2) + '@c.us');
  } else {
    // Other country or format: use as-is
    candidates.push(cleanPhone + '@c.us');
  }
  
  try {
    // Try each candidate to find one registered on WhatsApp
    let validChatId = null;
    
    for (const chatId of candidates) {
      try {
        const isRegistered = await whatsappClient.isRegisteredUser(chatId);
        if (isRegistered) {
          validChatId = chatId;
          break;
        }
      } catch (e) {
        // Try next candidate
        console.log(`  ↳ ${chatId} falló, probando siguiente formato...`);
      }
    }
    
    if (!validChatId) {
      throw new Error(`${telefono} no tiene WhatsApp`);
    }
    
    await whatsappClient.sendMessage(validChatId, mensaje);
    console.log(`  ✅ Mensaje enviado a ${validChatId}`);
    return { success: true };
  } catch (err) {
    console.error(`Error enviando mensaje a ${telefono}:`, err.message);
    
    // Translate common errors to user-friendly messages
    const errMsg = err.message || String(err);
    if (errMsg.includes('no tiene WhatsApp')) {
      throw err;
    }
    if (errMsg.includes('No LID') || errMsg.includes('not found')) {
      throw new Error(`${telefono} no encontrado en WhatsApp`);
    }
    if (errMsg.includes('disconnected') || errMsg.includes('not ready')) {
      throw new Error('WhatsApp se desconectó');
    }
    if (errMsg.includes('rate-limit') || errMsg.includes('too many')) {
      throw new Error('Demasiados mensajes. Espera un momento');
    }
    
    throw new Error(`No se pudo enviar a ${telefono}`);
  }
}

// ===== CRON JOB for automatic reminders =====
function setupCron() {
  if (cronJob) cronJob.stop();
  
  const activo = db.getConfig('cron_activo') === '1';
  if (!activo) {
    console.log('⏰ Recordatorios automáticos desactivados.');
    return;
  }
  
  const horario = db.getConfig('cron_horario') || '09:00';
  const dias = (db.getConfig('cron_dias') || 'lunes,miercoles,viernes').split(',');
  const [hour, minute] = horario.split(':');
  
  const daysMap = {
    'domingo': 0, 'lunes': 1, 'martes': 2, 'miercoles': 3, 'miércoles': 3,
    'jueves': 4, 'viernes': 5, 'sabado': 6, 'sábado': 6
  };
  
  const cronDays = dias.map(d => daysMap[d.trim().toLowerCase()]).filter(d => d !== undefined).join(',');
  if (!cronDays) return;
  
  const cronExpression = `${minute} ${hour} * * ${cronDays}`;
  cronJob = cron.schedule(cronExpression, async () => {
    console.log('⏰ Ejecutando recordatorios automáticos...');
    await sendBulkReminders();
  });
  console.log(`⏰ Recordatorios programados: ${cronExpression}`);
}

async function sendBulkReminders() {
  const deudores = db.getAllDeudores().filter(d => d.deuda_total > 0);
  const plantilla = db.getConfig('mensaje_recordatorio') || 
    'Hola {nombre}, tienes una deuda pendiente de ${deuda}.';
  
  let enviados = 0;
  let errores = 0;
  
  for (const deudor of deudores) {
    try {
      const mensaje = formatMensaje(plantilla, deudor);
      await sendWhatsAppMessage(deudor.telefono, mensaje);
      db.logMensaje(deudor.id, 'recordatorio', mensaje, 'enviado');
      enviados++;
      await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 3000));
    } catch (err) {
      db.logMensaje(deudor.id, 'recordatorio', `Error: ${err.message}`, 'error');
      errores++;
    }
  }
  
  console.log(`📊 Recordatorios: ${enviados} enviados, ${errores} errores`);
  return { enviados, errores };
}

// ===== CHAT COMMAND PROCESSOR =====
// This is the main feature: process chat commands like "mau - 40"
app.post('/api/chat/command', async (req, res) => {
  try {
    const { command } = req.body;
    if (!command || !command.trim()) {
      return res.json({ response: 'Escribe un comando. Escribe <strong>ayuda</strong> para ver los comandos disponibles.', type: 'info' });
    }

    const input = command.trim();
    const inputLower = input.toLowerCase();

    // ===== AYUDA =====
    if (inputLower === 'ayuda' || inputLower === 'help' || inputLower === '?') {
      return res.json({
        type: 'help',
        response: `<p><strong>📖 Comandos disponibles:</strong></p>
        <div class="chat-help-commands">
          <div class="help-cmd"><code>nombre - monto</code> → Poner la deuda en ese monto (ej: <code>mau - 40</code>)</div>
          <div class="help-cmd"><code>nombre +monto</code> → Sumar a la deuda (ej: <code>mau +15</code>)</div>
          <div class="help-cmd"><code>nombre pago monto</code> → Registrar un pago (ej: <code>mau pago 20</code>)</div>
          <div class="help-cmd"><code>nuevo nombre telefono</code> → Agregar deudor (ej: <code>nuevo Juan 5512345678</code>)</div>
          <div class="help-cmd"><code>nuevo nombre telefono monto</code> → Agregar con deuda (ej: <code>nuevo Juan 5512345678 50</code>)</div>
          <div class="help-cmd"><code>borrar nombre</code> → Eliminar un deudor</div>
          <div class="help-cmd"><code>lista</code> → Ver todos los deudores y sus deudas</div>
          <div class="help-cmd"><code>info nombre</code> → Ver detalle de un deudor</div>
          <div class="help-cmd"><code>notificar nombre</code> → Enviar recordatorio a un deudor</div>
          <div class="help-cmd"><code>notificar todos</code> → Enviar recordatorio a todos</div>
          <div class="help-cmd"><code>total</code> → Ver el total de deuda</div>
        </div>`
      });
    }

    // ===== LISTA =====
    if (inputLower === 'lista' || inputLower === 'ls' || inputLower === 'ver' || inputLower === 'todos') {
      const deudores = db.getAllDeudores();
      if (deudores.length === 0) {
        return res.json({ type: 'info', response: '📋 No hay deudores registrados. Usa <code>nuevo nombre telefono</code> para agregar uno.' });
      }
      let tableHtml = '<p><strong>📋 Lista de Deudores:</strong></p><table class="chat-list-table"><thead><tr><th>Nombre</th><th>Deuda</th><th>Teléfono</th></tr></thead><tbody>';
      for (const d of deudores) {
        const amountClass = d.deuda_total === 0 ? 'style="color: #22c55e;"' : 'style="color: #ef4444; font-weight:700;"';
        tableHtml += `<tr><td>${d.nombre}</td><td ${amountClass}>$${d.deuda_total.toFixed(2)}</td><td style="color:#64748b;">${d.telefono}</td></tr>`;
      }
      tableHtml += '</tbody></table>';
      const total = deudores.reduce((s, d) => s + d.deuda_total, 0);
      tableHtml += `<p style="margin-top:8px;font-weight:700;">💰 Total: $${total.toFixed(2)}</p>`;
      return res.json({ type: 'list', response: tableHtml });
    }

    // ===== TOTAL =====
    if (inputLower === 'total' || inputLower === 'resumen') {
      const stats = db.getEstadisticas();
      return res.json({
        type: 'info',
        response: `<p><strong>📊 Resumen:</strong></p>
          <div class="chat-deuda-card">
            <div>👥 Deudores: <strong>${stats.totalDeudores}</strong></div>
            <div>⚠️ Con deuda: <strong>${stats.deudoresConDeuda}</strong></div>
            <div class="deuda-amount-big" style="margin-top:6px;">💰 Total: $${stats.totalDeuda.toFixed(2)}</div>
            <div style="margin-top:4px;color:#64748b;">💵 Total pagado: $${stats.totalPagos.toFixed(2)}</div>
          </div>`
      });
    }

    // ===== NUEVO =====
    const nuevoMatch = input.match(/^(?:nuevo|new|agregar|add)\s+(.+?)\s+(\d{10,15})(?:\s+(\d+(?:\.\d+)?))?$/i);
    if (nuevoMatch) {
      const nombre = nuevoMatch[1].trim();
      const telefono = nuevoMatch[2];
      const deuda = parseFloat(nuevoMatch[3]) || 0;
      
      try {
        const result = db.addDeudor(nombre, telefono, deuda);
        let msgHtml = `<p>✅ <strong>${nombre}</strong> agregado correctamente</p>
          <div class="chat-deuda-card">
            <div class="deuda-name">${nombre}</div>
            <div class="deuda-amount-big ${deuda === 0 ? 'paid' : ''}">$${deuda.toFixed(2)}</div>
            <div class="deuda-phone">📱 ${telefono}</div>
          </div>`;
        return res.json({ type: 'success', response: msgHtml });
      } catch (err) {
        if (err.message.includes('UNIQUE')) {
          return res.json({ type: 'error', response: `❌ El teléfono <strong>${telefono}</strong> ya está registrado.` });
        }
        throw err;
      }
    }

    // ===== BORRAR =====
    const borrarMatch = input.match(/^(?:borrar|eliminar|delete|del|remove)\s+(.+)$/i);
    if (borrarMatch) {
      const nombre = borrarMatch[1].trim();
      const deudor = findDeudorByName(nombre);
      if (!deudor) {
        return res.json({ type: 'error', response: `❌ No encontré a "<strong>${escHtml(nombre)}</strong>". Escribe <code>lista</code> para ver los nombres.` });
      }
      db.deleteDeudor(deudor.id);
      return res.json({ type: 'success', response: `🗑️ <strong>${deudor.nombre}</strong> ha sido eliminado.` });
    }

    // ===== INFO =====
    const infoMatch = input.match(/^(?:info|ver|detalle|detalles)\s+(.+)$/i);
    if (infoMatch) {
      const nombre = infoMatch[1].trim();
      const deudor = findDeudorByName(nombre);
      if (!deudor) {
        return res.json({ type: 'error', response: `❌ No encontré a "<strong>${escHtml(nombre)}</strong>".` });
      }
      const pagos = db.getPagosByDeudor(deudor.id);
      let pagosHtml = '';
      if (pagos.length > 0) {
        pagosHtml = '<p style="margin-top:10px;font-weight:600;">📝 Historial:</p>';
        for (const p of pagos.slice(0, 10)) {
          const icon = p.tipo === 'pago' ? '💵' : '📝';
          const color = p.tipo === 'pago' ? '#22c55e' : '#ef4444';
          pagosHtml += `<div style="font-size:0.8rem;padding:4px 0;color:#94a3b8;">${icon} <span style="color:${color};">$${p.monto.toFixed(2)}</span> — ${p.concepto || p.tipo} (${p.fecha})</div>`;
        }
      }
      return res.json({
        type: 'info',
        response: `<div class="chat-deuda-card">
          <div class="deuda-name">${deudor.nombre}</div>
          <div class="deuda-amount-big ${deudor.deuda_total === 0 ? 'paid' : ''}">$${deudor.deuda_total.toFixed(2)}</div>
          <div class="deuda-phone">📱 ${deudor.telefono}</div>
          ${deudor.notas ? `<div style="margin-top:4px;color:#94a3b8;">📌 ${escHtml(deudor.notas)}</div>` : ''}
          ${pagosHtml}
        </div>`
      });
    }

    // ===== NOTIFICAR =====
    const notMatch = input.match(/^(?:notificar|enviar|notify|send|recordar)\s+(.+)$/i);
    if (notMatch) {
      const target = notMatch[1].trim().toLowerCase();
      
      if (target === 'todos' || target === 'all') {
        try {
          const result = await sendBulkReminders();
          return res.json({ type: 'success', response: `📤 Recordatorios enviados: <strong>${result.enviados}</strong> ✅, Errores: <strong>${result.errores}</strong>` });
        } catch (err) {
          return res.json({ type: 'error', response: `❌ Error enviando: ${err.message}` });
        }
      }
      
      const deudor = findDeudorByName(target);
      if (!deudor) {
        return res.json({ type: 'error', response: `❌ No encontré a "<strong>${escHtml(target)}</strong>".` });
      }
      
      try {
        const plantilla = db.getConfig('mensaje_recordatorio') || 'Hola {nombre}, tienes una deuda pendiente de ${deuda}.';
        const mensaje = formatMensaje(plantilla, deudor);
        await sendWhatsAppMessage(deudor.telefono, mensaje);
        db.logMensaje(deudor.id, 'manual', mensaje, 'enviado');
        return res.json({
          type: 'success',
          response: `<div class="chat-deuda-card">
            <div class="deuda-name">${deudor.nombre}</div>
            <div class="deuda-amount-big">$${deudor.deuda_total.toFixed(2)}</div>
            <div class="deuda-wa-status sent">✅ Mensaje enviado por WhatsApp</div>
          </div>`
        });
      } catch (err) {
        return res.json({
          type: 'error',
          response: `<div class="chat-deuda-card">
            <div class="deuda-name">${deudor.nombre}</div>
            <div class="deuda-amount-big">$${deudor.deuda_total.toFixed(2)}</div>
            <div class="deuda-wa-status error">❌ Error: ${err.message}</div>
          </div>`
        });
      }
    }

    // ===== PAGO: "nombre pago monto" =====
    const pagoMatch = input.match(/^(.+?)\s+(?:pago|paga|abono|abona|pagó|payed)\s+(\d+(?:\.\d+)?)$/i);
    if (pagoMatch) {
      const nombre = pagoMatch[1].trim();
      const monto = parseFloat(pagoMatch[2]);
      const deudor = findDeudorByName(nombre);
      
      if (!deudor) {
        return res.json({ type: 'error', response: `❌ No encontré a "<strong>${escHtml(nombre)}</strong>". Usa <code>nuevo ${escHtml(nombre)} telefono</code> para registrarlo.` });
      }
      
      db.addPago(deudor.id, monto, `Pago desde chat`);
      const updated = db.getDeudorById(deudor.id);
      
      // Auto-send WhatsApp notification
      let waStatus = '';
      try {
        const plantilla = db.getConfig('mensaje_recordatorio') || 'Hola {nombre}, tu deuda actual es de ${deuda}.';
        const mensaje = formatMensaje(plantilla, updated);
        await sendWhatsAppMessage(updated.telefono, mensaje);
        db.logMensaje(updated.id, 'actualización', mensaje, 'enviado');
        waStatus = '<div class="deuda-wa-status sent">✅ Notificado por WhatsApp</div>';
      } catch (err) {
        waStatus = `<div class="deuda-wa-status error">⚠️ WhatsApp: ${err.message}</div>`;
      }

      return res.json({
        type: 'success',
        response: `<p>💵 Pago de <strong>$${monto.toFixed(2)}</strong> registrado para <strong>${updated.nombre}</strong></p>
          <div class="chat-deuda-card">
            <div class="deuda-name">${updated.nombre}</div>
            <div class="deuda-amount-big ${updated.deuda_total === 0 ? 'paid' : ''}">$${updated.deuda_total.toFixed(2)}</div>
            <div class="deuda-phone">📱 ${updated.telefono}</div>
            ${waStatus}
          </div>`
      });
    }

    // ===== SET DEBT: "nombre - monto" (set to exact amount) =====
    const setDebtMatch = input.match(/^(.+?)\s*[-–]\s*(\d+(?:\.\d+)?)$/);
    if (setDebtMatch) {
      const nombre = setDebtMatch[1].trim();
      const newDebt = parseFloat(setDebtMatch[2]);
      const deudor = findDeudorByName(nombre);
      
      if (!deudor) {
        return res.json({ type: 'error', response: `❌ No encontré a "<strong>${escHtml(nombre)}</strong>". Usa <code>nuevo ${escHtml(nombre)} telefono</code> para registrarlo primero.` });
      }

      const oldDebt = deudor.deuda_total;
      
      // Update the debt directly
      db.updateDeudor(deudor.id, deudor.nombre, deudor.telefono, newDebt, deudor.notas);
      
      // Log the change as a payment record (without modifying deuda_total again)
      if (newDebt !== oldDebt) {
        const tipo = newDebt > oldDebt ? 'cargo' : 'pago';
        const monto = Math.abs(newDebt - oldDebt);
        const pg = db.db.prepare('INSERT INTO pagos (deudor_id, monto, concepto, tipo) VALUES (?, ?, ?, ?)');
        pg.run(deudor.id, monto, `Actualización: $${oldDebt.toFixed(2)} → $${newDebt.toFixed(2)}`, tipo);
      }


      const updated = db.getDeudorById(deudor.id);
      const changeIcon = newDebt > oldDebt ? '📈' : newDebt < oldDebt ? '📉' : '➡️';
      
      // Auto-send WhatsApp notification
      let waStatus = '';
      try {
        const plantilla = db.getConfig('mensaje_recordatorio') || 'Hola {nombre}, tu deuda actual es de ${deuda}.';
        const mensaje = formatMensaje(plantilla, updated);
        await sendWhatsAppMessage(updated.telefono, mensaje);
        db.logMensaje(updated.id, 'actualización', mensaje, 'enviado');
        waStatus = '<div class="deuda-wa-status sent">✅ Notificado por WhatsApp</div>';
      } catch (err) {
        waStatus = `<div class="deuda-wa-status error">⚠️ WhatsApp: ${err.message}</div>`;
      }

      return res.json({
        type: 'success',
        response: `<p>${changeIcon} Deuda de <strong>${updated.nombre}</strong> actualizada: $${oldDebt.toFixed(2)} → <strong>$${newDebt.toFixed(2)}</strong></p>
          <div class="chat-deuda-card">
            <div class="deuda-name">${updated.nombre}</div>
            <div class="deuda-amount-big ${updated.deuda_total === 0 ? 'paid' : ''}">$${updated.deuda_total.toFixed(2)}</div>
            <div class="deuda-phone">📱 ${updated.telefono}</div>
            ${waStatus}
          </div>`
      });
    }

    // ===== ADD TO DEBT: "nombre +monto" =====
    const addDebtMatch = input.match(/^(.+?)\s*\+\s*(\d+(?:\.\d+)?)$/);
    if (addDebtMatch) {
      const nombre = addDebtMatch[1].trim();
      const amount = parseFloat(addDebtMatch[2]);
      const deudor = findDeudorByName(nombre);
      
      if (!deudor) {
        return res.json({ type: 'error', response: `❌ No encontré a "<strong>${escHtml(nombre)}</strong>".` });
      }
      
      db.addCargo(deudor.id, amount, `Cargo desde chat`);
      const updated = db.getDeudorById(deudor.id);
      
      // Auto-send WhatsApp notification
      let waStatus = '';
      try {
        const plantilla = db.getConfig('mensaje_recordatorio') || 'Hola {nombre}, tu deuda actual es de ${deuda}.';
        const mensaje = formatMensaje(plantilla, updated);
        await sendWhatsAppMessage(updated.telefono, mensaje);
        db.logMensaje(updated.id, 'actualización', mensaje, 'enviado');
        waStatus = '<div class="deuda-wa-status sent">✅ Notificado por WhatsApp</div>';
      } catch (err) {
        waStatus = `<div class="deuda-wa-status error">⚠️ WhatsApp: ${err.message}</div>`;
      }

      return res.json({
        type: 'success',
        response: `<p>📈 Se sumó <strong>$${amount.toFixed(2)}</strong> a la deuda de <strong>${updated.nombre}</strong></p>
          <div class="chat-deuda-card">
            <div class="deuda-name">${updated.nombre}</div>
            <div class="deuda-amount-big">$${updated.deuda_total.toFixed(2)}</div>
            <div class="deuda-phone">📱 ${updated.telefono}</div>
            ${waStatus}
          </div>`
      });
    }

    // ===== Not recognized =====
    return res.json({
      type: 'error',
      response: `🤔 No entendí "<strong>${escHtml(input)}</strong>". Escribe <strong>ayuda</strong> para ver los comandos disponibles.`
    });

  } catch (err) {
    console.error('Error processing chat command:', err);
    res.json({ type: 'error', response: `❌ Error: ${err.message}` });
  }
});

// Helper: find debtor by fuzzy name match
function findDeudorByName(nameQuery) {
  const deudores = db.getAllDeudores();
  const query = nameQuery.toLowerCase().trim();
  
  // Exact match first
  let found = deudores.find(d => d.nombre.toLowerCase() === query);
  if (found) return found;
  
  // Starts with
  found = deudores.find(d => d.nombre.toLowerCase().startsWith(query));
  if (found) return found;
  
  // Contains
  found = deudores.find(d => d.nombre.toLowerCase().includes(query));
  if (found) return found;
  
  return null;
}

function escHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== API ROUTES =====

// -- WhatsApp Status --
app.get('/api/whatsapp/status', (req, res) => {
  res.json({
    status: whatsappStatus,
    qr: currentQR,
    info: clientInfo ? {
      pushname: clientInfo.pushname,
      phone: clientInfo.wid?.user
    } : null
  });
});

app.post('/api/whatsapp/connect', (req, res) => {
  if (whatsappStatus === 'ready') {
    return res.json({ message: 'Ya estás conectado' });
  }
  if (whatsappStatus === 'qr' || whatsappStatus === 'connecting') {
    return res.json({ message: 'Ya se está intentando conectar' });
  }
  initWhatsApp();
  res.json({ message: 'Iniciando conexión...' });
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    if (whatsappClient) {
      await whatsappClient.logout();
      await whatsappClient.destroy();
      whatsappClient = null;
    }
    whatsappStatus = 'disconnected';
    currentQR = null;
    clientInfo = null;
    res.json({ message: 'Desconectado correctamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Deudores --
app.get('/api/deudores', (req, res) => {
  try { res.json(db.getAllDeudores()); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/deudores/:id', (req, res) => {
  try {
    const deudor = db.getDeudorById(req.params.id);
    if (!deudor) return res.status(404).json({ error: 'Deudor no encontrado' });
    res.json(deudor);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/deudores', (req, res) => {
  try {
    const { nombre, telefono, deuda_total, notas } = req.body;
    if (!nombre || !telefono) return res.status(400).json({ error: 'Nombre y teléfono son requeridos' });
    const result = db.addDeudor(nombre, telefono, deuda_total || 0, notas || '');
    res.json({ id: result.lastInsertRowid, message: 'Deudor agregado' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Ese número ya está registrado' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/deudores/:id', (req, res) => {
  try {
    const { nombre, telefono, deuda_total, notas } = req.body;
    db.updateDeudor(req.params.id, nombre, telefono, deuda_total, notas || '');
    res.json({ message: 'Deudor actualizado' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/deudores/:id', (req, res) => {
  try { db.deleteDeudor(req.params.id); res.json({ message: 'Deudor eliminado' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// -- Pagos --
app.get('/api/deudores/:id/pagos', (req, res) => {
  try { res.json(db.getPagosByDeudor(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/deudores/:id/pagos', (req, res) => {
  try {
    const { monto, concepto } = req.body;
    if (!monto || monto <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
    db.addPago(req.params.id, monto, concepto || '');
    res.json({ message: 'Pago registrado' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/deudores/:id/cargos', (req, res) => {
  try {
    const { monto, concepto } = req.body;
    if (!monto || monto <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
    db.addCargo(req.params.id, monto, concepto || '');
    res.json({ message: 'Cargo registrado' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// -- Mensajes --
app.post('/api/mensajes/enviar', async (req, res) => {
  try {
    const { deudor_id } = req.body;
    const deudor = db.getDeudorById(deudor_id);
    if (!deudor) return res.status(404).json({ error: 'Deudor no encontrado' });
    const plantilla = db.getConfig('mensaje_recordatorio') || 'Hola {nombre}, tienes una deuda pendiente de ${deuda}.';
    const mensaje = formatMensaje(plantilla, deudor);
    await sendWhatsAppMessage(deudor.telefono, mensaje);
    db.logMensaje(deudor.id, 'manual', mensaje, 'enviado');
    res.json({ message: 'Mensaje enviado correctamente' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mensajes/enviar-todos', async (req, res) => {
  try {
    const result = await sendBulkReminders();
    res.json({ message: `Recordatorios: ${result.enviados} enviados, ${result.errores} errores`, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mensajes/log', (req, res) => {
  try { res.json(db.getMensajesRecientes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// -- Estadísticas --
app.get('/api/estadisticas', (req, res) => {
  try { res.json(db.getEstadisticas()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// -- Configuración --
app.get('/api/configuracion', (req, res) => {
  try {
    res.json({
      mensaje_recordatorio: db.getConfig('mensaje_recordatorio'),
      mensaje_respuesta: db.getConfig('mensaje_respuesta'),
      cron_activo: db.getConfig('cron_activo'),
      cron_horario: db.getConfig('cron_horario'),
      cron_dias: db.getConfig('cron_dias')
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/configuracion', (req, res) => {
  try {
    for (const [clave, valor] of Object.entries(req.body)) db.setConfig(clave, valor);
    setupCron();
    res.json({ message: 'Configuración actualizada' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor iniciado en http://localhost:${PORT}`);
  console.log('💬 Chat disponible en el navegador');
  console.log('📱 Conecta WhatsApp desde la sección WhatsApp\n');
});
