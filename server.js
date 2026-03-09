require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cron = require('node-cron');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const db = require('./database');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// ===== SECURITY MIDDLEWARE =====

// Helmet: Security headers (CSP, XSS, HSTS, etc.)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      upgradeInsecureRequests: null,
    }
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
}));

// Rate limiting — general
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' },
});
app.use(generalLimiter);

// Rate limiting — API más estricto
const apiLimiter = rateLimit({
  windowMs: 1 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes a la API. Espera un momento.' },
});
app.use('/api/', apiLimiter);

// Rate limiting — login más estricto contra brute force
const loginLimiter = rateLimit({
  windowMs: 1 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de login. Espera 15 minutos.' },
});

// Body parser con límite de tamaño
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Disable x-powered-by
app.disable('x-powered-by');

// ===== BASIC AUTH MIDDLEWARE =====
// Sessions en memoria (simple para este caso)
const activeSessions = new Map();

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 64; i++) token += chars.charAt(Math.floor(Math.random() * chars.length));
  return token;
}

// Auth endpoint
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    const token = generateToken();
    activeSessions.set(token, { user: username, createdAt: Date.now() });
    // Limpiar sesiones viejas (más de 1 semana)
    const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
    for (const [t, s] of activeSessions.entries()) {
      if (Date.now() - s.createdAt > ONE_WEEK) activeSessions.delete(t);
    }
    return res.json({ success: true, token });
  }
  return res.status(401).json({ error: 'Credenciales incorrectas' });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) activeSessions.delete(token);
  res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token && activeSessions.has(token)) {
    return res.json({ authenticated: true });
  }
  return res.status(401).json({ authenticated: false });
});

// Middleware de autenticación para rutas protegidas
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token && activeSessions.has(token)) {
    const session = activeSessions.get(token);
    // Verificar que la sesión no tenga más de 1 semana
    const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - session.createdAt > ONE_WEEK) {
      activeSessions.delete(token);
      return res.status(401).json({ error: 'Sesión expirada. Inicia sesión de nuevo.' });
    }
    return next();
  }
  return res.status(401).json({ error: 'No autorizado. Inicia sesión.' });
}

// Servir login page (sin auth)
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Archivos estáticos públicos (CSS, JS, login.html)
app.use(express.static(path.join(__dirname, 'public')));

// Proteger TODAS las rutas de API (excepto auth)
app.use('/api', (req, res, next) => {
  // Permitir rutas de auth sin token
  if (req.path.startsWith('/auth/')) return next();
  requireAuth(req, res, next);
});

// Log de errores en producción (no exponer stack traces)
if (NODE_ENV === 'production') {
  app.use((err, req, res, next) => {
    console.error('Error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  });
}

// ===== WhatsApp Client Setup =====
let whatsappClient = null;
let whatsappStatus = 'disconnected'; // disconnected, qr, connecting, ready
let currentQR = null;
let clientInfo = null;
let cronJobs = [];

// Find Chrome executable on Windows
function findChromePath() {
  return '/usr/bin/google-chrome';
  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
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
    protocolTimeout: 120000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ]
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
    initWhatsApp._retryCount = 0; // Reset retry counter on success
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

  // Auto-respond to incoming messages — only on /consultar command
  whatsappClient.on('message', async (msg) => {
    try {
      if (msg.fromMe) return;

      const senderNumber = msg.from.replace('@c.us', '');
      const messageBody = msg.body.trim();

      // Only respond to /consultar command
      if (messageBody.toLowerCase() !== '/consultar') return;

      const deudor = db.getDeudorByTelefono(senderNumber);

      if (deudor) {
        // Build message with balance info
        let mensaje = `📋 *Consulta de cuenta*\n\n`;
        mensaje += `👤 *${deudor.nombre}*\n`;

        if (deudor.deuda_total > 0) {
          mensaje += `💰 Deuda pendiente: *$${deudor.deuda_total.toFixed(2)}*\n`;
        } else if (deudor.deuda_total === 0) {
          mensaje += `✅ No tienes deuda pendiente.\n`;
        } else {
          mensaje += `🎉 Saldo a favor: *$${Math.abs(deudor.deuda_total).toFixed(2)}*\n`;
        }

        // Add transaction history
        const pagos = db.getPagosByDeudor(deudor.id);
        if (pagos.length > 0) {
          mensaje += `\n📝 *Últimos movimientos:*\n`;
          for (const p of pagos.slice(0, 5)) {
            const icon = p.tipo === 'pago' ? '💵' : '🛒';
            const signo = p.tipo === 'pago' ? '-' : '+';
            mensaje += `${icon} ${signo}$${p.monto.toFixed(2)} — ${p.concepto || p.tipo} (${p.fecha})\n`;
          }
        }

        mensaje += `\n_Responde /consultar en cualquier momento para ver tu estado._`;

        await msg.reply(mensaje);
        db.logMensaje(deudor.id, 'auto-respuesta', mensaje, 'enviado');
        console.log(`🤖 Auto-respuesta enviada a ${deudor.nombre}`);
      } else {
        await msg.reply('Hola, no encontré tu número registrado en el sistema. Contacta al administrador para más información.');
        db.logMensaje(null, 'auto-respuesta', `Número no registrado: ${senderNumber}`, 'info');
      }
    } catch (err) {
      console.error('Error procesando mensaje:', err);
    }
  });

  // Escuchar comandos del admin
  whatsappClient.on('message_create', async (msg) => {
    try {
      if (!msg.fromMe) return;
      // Ignorar las respuestas del bot (evita loop infinito)
      if (msg.hasQuotedMsg) return;

      const messageBody = msg.body.trim();
      if (!messageBody) return;

      const targetId = msg.to; // El chat donde se envió el mensaje
      const adminChatId = db.getConfig('admin_chat_id');
      const isLinkedChat = adminChatId && targetId === adminChatId;
      const hasSlash = messageBody.startsWith('/');

      // Comando especial /vincular — funciona desde cualquier chat
      if (hasSlash && messageBody.substring(1).trim().toLowerCase() === 'vincular') {
        db.setConfig('admin_chat_id', targetId);
        await msg.reply('✅ Este chat ha sido vinculado como el panel de control del bot. Ya no necesitas usar / para los comandos aquí.');
        return;
      }

      // Si estamos en el chat vinculado, aceptar con o sin /
      // Si NO estamos en el chat vinculado, solo aceptar con /
      if (isLinkedChat) {
        // En el chat vinculado: aceptar todo como comando
        const cmd = hasSlash ? messageBody.substring(1).trim() : messageBody;

        const result = await processCommand(cmd);

        if (result && result.response) {
          await msg.reply(cleanHtmlForWhatsApp(result.response));
        }
      } else if (hasSlash) {
        // Fuera del chat vinculado: solo responder a comandos con /
        // Si no hay chat vinculado configurado, solo funciona en el chat propio
        if (!adminChatId && targetId !== msg.from) return;

        const cmd = messageBody.substring(1).trim();

        const result = await processCommand(cmd);

        if (result && result.response) {
          await msg.reply(cleanHtmlForWhatsApp(result.response));
        }
      }
    } catch (err) {
      console.error('Error en admin command via WA:', err);
    }
  });

  // Helper para limpiar HTML a formato WhatsApp
  function cleanHtmlForWhatsApp(html) {
    return html
      // Saltos de bloque
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      // Tablas
      .replace(/<\/th>\s*<th[^>]*>/gi, ' | ')
      .replace(/<\/td>\s*<td[^>]*>/gi, ' | ')
      .replace(/<\/tr>/gi, '\n')
      // Formato WhatsApp
      .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '*$1*')
      .replace(/<b[^>]*>(.*?)<\/b>/gi, '*$1*')
      .replace(/<em[^>]*>(.*?)<\/em>/gi, '_$1_')
      .replace(/<i[^>]*>(.*?)<\/i>/gi, '_$1_')
      .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
      .replace(/<[^>]+>/g, '') // Quitar otras etiquetas HTML
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      // Quitar espacios extra/sangrías a los inicios de línea
      .replace(/^[ \t]+/gm, '')
      // Limpiar múltiples saltos de línea sobrantes
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  console.log('🔄 Iniciando conexión con WhatsApp...');
  whatsappClient.initialize().catch(err => {
    console.error('❌ Error al inicializar WhatsApp:', err.message);
    whatsappStatus = 'disconnected';
    whatsappClient = null;

    // Auto-retry connection
    if (!initWhatsApp._retryCount) initWhatsApp._retryCount = 0;
    initWhatsApp._retryCount++;

    if (initWhatsApp._retryCount <= 10) {
      const waitSecs = 30;
      console.log(`🔁 Reintentando en ${waitSecs}s... (intento ${initWhatsApp._retryCount}/10)`);
      setTimeout(() => {
        initWhatsApp();
      }, waitSecs * 1000);
    } else {
      console.log('⚠️ Se agotaron los reintentos. Conecta WhatsApp manualmente desde http://localhost:3000');
      initWhatsApp._retryCount = 0;
    }
  });
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

  console.log(`📞 Intentando enviar a ${telefono} (limpio: ${cleanPhone})`);
  console.log(`  ↳ Candidatos: ${candidates.join(', ')}`);

  try {
    // Try each candidate to find one registered on WhatsApp
    let validChatId = null;

    for (const chatId of candidates) {
      try {
        const phone = chatId.replace('@c.us', '');
        console.log(`  ↳ Probando: ${phone}...`);
        const numberId = await whatsappClient.getNumberId(phone);
        if (numberId) {
          validChatId = numberId._serialized;
          console.log(`  ✅ Encontrado: ${validChatId}`);
          break;
        } else {
          console.log(`  ↳ ${phone} no registrado en WhatsApp`);
        }
      } catch (e) {
        // Try next candidate
        console.log(`  ↳ ${chatId} falló en getNumberId: ${e.message}`);
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

    throw new Error(`No se pudo enviar a ${telefono} (${errMsg})`);
  }
}

// ===== CRON JOB for automatic reminders =====
function setupCron() {
  if (cronJobs) cronJobs.forEach(job => job.stop());
  cronJobs = [];

  const activo = db.getConfig('cron_activo') === '1';
  if (!activo) {
    console.log('⏰ Recordatorios automáticos desactivados.');
    return;
  }

  const horariosStr = db.getConfig('cron_horarios') || '{"lunes":"09:00","miercoles":"09:00","viernes":"09:00"}';
  let horarios = {};
  try { horarios = JSON.parse(horariosStr); } catch (e) { horarios = {}; }

  const daysMap = {
    'domingo': 0, 'lunes': 1, 'martes': 2, 'miercoles': 3, 'miércoles': 3,
    'jueves': 4, 'viernes': 5, 'sabado': 6, 'sábado': 6
  };

  const activeDays = Object.keys(horarios).filter(dia => horarios[dia]);
  if (activeDays.length === 0) return;

  activeDays.forEach(dia => {
    const hora = horarios[dia];
    const [hour, minute] = hora.split(':');
    const dayNum = daysMap[dia.toLowerCase()];

    if (dayNum !== undefined) {
      const cronExpression = `${minute} ${hour} * * ${dayNum}`;
      const job = cron.schedule(cronExpression, async () => {
        console.log(`⏰ Ejecutando recordatorios automáticos de ${dia}...`);
        await sendBulkReminders();
      });
      cronJobs.push(job);
      console.log(`⏰ Recordatorios programados: ${dia} a las ${hora} (${cronExpression})`);
    }
  });
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

// ===== CHAT COMMAND PROCESSOR (standalone function) =====
// processCommand returns { type, response } — used by both API and WhatsApp
async function processCommand(command) {
  if (!command || !command.trim()) {
    return { response: 'Escribe un comando. Escribe <strong>ayuda</strong> para ver los comandos disponibles.', type: 'info' };
  }
  const input = command.trim();
  const inputLower = input.toLowerCase();

  // ===== AYUDA =====
  if (inputLower === 'ayuda' || inputLower === 'help' || inputLower === '?') {
    return {
      type: 'help',
      response: `<p>🤖 <strong>¡Hola! Soy Deudbot.</strong></p>
      <p><strong>📖 Comandos disponibles:</strong></p>
      <div class="chat-help-commands">
        <div class="help-cmd"><code>nombre + monto</code> → Registrar compras/sumar (ej: <code>mau + 15</code>)</div>
        <div class="help-cmd"><code>nombre - monto</code> → Registrar un pago (ej: <code>mau - 20</code>)</div>
        <div class="help-cmd"><code>nombre + monto - monto</code> → Múltiples cargos y/o pagos (ej: <code>mau + 15 - 20</code>)</div>
        <div class="help-cmd"><code>nuevo nombre telefono</code> → Agregar deudor (ej: <code>nuevo Juan 5512345678</code>)</div>
        <div class="help-cmd"><code>nuevo nombre telefono monto</code> → Agregar con deuda (ej: <code>nuevo Juan 5512345678 50</code>)</div>
        <div class="help-cmd"><code>borrar nombre</code> → Eliminar un deudor</div>
        <div class="help-cmd"><code>lista</code> → Ver todos los deudores y sus deudas</div>
        <div class="help-cmd"><code>info nombre</code> → Ver detalle de un deudor</div>
        <div class="help-cmd"><code>notificar nombre</code> → Enviar recordatorio a un deudor</div>
        <div class="help-cmd"><code>notificar todos</code> → Enviar recordatorio a todos</div>
        <div class="help-cmd"><code>total</code> → Ver el total de deuda</div>
      </div>`
    };
  }

  // ===== LISTA =====
  if (inputLower === 'lista' || inputLower === 'ls' || inputLower === 'ver' || inputLower === 'todos') {
    const deudores = db.getAllDeudores();
    if (deudores.length === 0) {
      return { type: 'info', response: '📋 No hay deudores registrados. Usa <code>nuevo nombre telefono</code> para agregar uno.' };
    }
    let tableHtml = '<p><strong>📋 Lista de Deudores:</strong></p><table class="chat-list-table"><thead><tr><th>Nombre</th><th>Deuda</th><th>Teléfono</th></tr></thead><tbody>';
    for (const d of deudores) {
      const amountStyle = d.deuda_total <= 0 ? 'style="color: #22c55e; font-weight:700;"' : 'style="color: #ef4444; font-weight:700;"';
      tableHtml += `<tr><td>${d.nombre}</td><td ${amountStyle}>$${d.deuda_total.toFixed(2)}</td><td style="color:#64748b;">${d.telefono}</td></tr>`;
    }
    tableHtml += '</tbody></table>';
    const total = deudores.reduce((s, d) => s + d.deuda_total, 0);
    tableHtml += `<p style="margin-top:8px;font-weight:700;">💰 Total: $${total.toFixed(2)}</p>`;
    return { type: 'list', response: tableHtml };
  }

  // ===== TOTAL =====
  if (inputLower === 'total' || inputLower === 'resumen') {
    const stats = db.getEstadisticas();
    return {
      type: 'info',
      response: `<p><strong>📊 Resumen:</strong></p>
        <div class="chat-deuda-card">
          <div>👥 Deudores: <strong>${stats.totalDeudores}</strong></div>
          <div>⚠️ Con deuda: <strong>${stats.deudoresConDeuda}</strong></div>
          <div class="deuda-amount-big" style="margin-top:6px;">💰 Total: $${stats.totalDeuda.toFixed(2)}</div>
          <div style="margin-top:4px;color:#64748b;">💵 Total pagado: $${stats.totalPagos.toFixed(2)}</div>
        </div>`
    };
  }

  // ===== NUEVO =====
  const nuevoRegex = /^(?:nuevo|new|agregar|add)\s+(.+)$/i;
  const nuevoRawMatch = input.match(nuevoRegex);
  if (nuevoRawMatch) {
    const restOfInput = nuevoRawMatch[1].trim();
    const parts = restOfInput.split(/\s+/);

    let nameEnd = -1;
    for (let i = 0; i < parts.length; i++) {
      if (/^\d/.test(parts[i])) {
        nameEnd = i;
        break;
      }
    }

    if (nameEnd > 0) {
      const nombre = parts.slice(0, nameEnd).join(' ').trim();
      const digitParts = parts.slice(nameEnd);
      const allDigits = digitParts.join('').replace(/\D/g, '');

      let telefono = '';
      let deuda = 0;

      if (allDigits.length >= 10 && allDigits.length <= 15) {
        telefono = allDigits;
      } else if (allDigits.length > 15) {
        const lastPart = digitParts[digitParts.length - 1].replace(/\D/g, '');
        const phoneParts = digitParts.slice(0, -1);
        const phoneDigits = phoneParts.join('').replace(/\D/g, '');

        if (phoneDigits.length >= 10 && phoneDigits.length <= 15) {
          telefono = phoneDigits;
          deuda = parseFloat(lastPart) || 0;
        }
      }

      if (telefono) {
        try {
          const result = db.addDeudor(nombre, telefono, deuda);
          let msgHtml = `<p>✅ <strong>${nombre}</strong> agregado correctamente</p>
            <div class="chat-deuda-card">
              <div class="deuda-name">${nombre}</div>
              <div class="deuda-amount-big ${deuda === 0 ? 'paid' : ''}">$${deuda.toFixed(2)}</div>
              <div class="deuda-phone">📱 ${telefono}</div>
            </div>`;
          return { type: 'success', response: msgHtml };
        } catch (err) {
          if (err.message.includes('UNIQUE')) {
            return { type: 'error', response: `❌ El teléfono <strong>${telefono}</strong> ya está registrado.` };
          }
          throw err;
        }
      }
    }
  }

  // ===== BORRAR =====
  const borrarMatch = input.match(/^(?:borrar|eliminar|delete|del|remove)\s+(.+)$/i);
  if (borrarMatch) {
    const nombre = borrarMatch[1].trim();
    const deudor = findDeudorByName(nombre);
    if (!deudor) {
      return { type: 'error', response: `❌ No encontré a "<strong>${escHtml(nombre)}</strong>". Escribe <code>lista</code> para ver los nombres.` };
    }
    db.deleteDeudor(deudor.id);
    return { type: 'success', response: `🗑️ <strong>${deudor.nombre}</strong> ha sido eliminado.` };
  }

  // ===== INFO =====
  const infoMatch = input.match(/^(?:info|ver|detalle|detalles)\s+(.+)$/i);
  if (infoMatch) {
    const nombre = infoMatch[1].trim();
    const deudor = findDeudorByName(nombre);
    if (!deudor) {
      return { type: 'error', response: `❌ No encontré a "<strong>${escHtml(nombre)}</strong>".` };
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
    return {
      type: 'info',
      response: `<div class="chat-deuda-card">
        <div class="deuda-name">${deudor.nombre}</div>
        <div class="deuda-amount-big ${deudor.deuda_total === 0 ? 'paid' : ''}">$${deudor.deuda_total.toFixed(2)}</div>
        <div class="deuda-phone">📱 ${deudor.telefono}</div>
        ${deudor.notas ? `<div style="margin-top:4px;color:#94a3b8;">📌 ${escHtml(deudor.notas)}</div>` : ''}
        ${pagosHtml}
      </div>`
    };
  }

  // ===== NOTIFICAR =====
  const notMatch = input.match(/^(?:notificar|enviar|notify|send|recordar)\s+(.+)$/i);
  if (notMatch) {
    const target = notMatch[1].trim().toLowerCase();

    if (target === 'todos' || target === 'all') {
      try {
        const result = await sendBulkReminders();
        return { type: 'success', response: `📤 Recordatorios enviados: <strong>${result.enviados}</strong> ✅, Errores: <strong>${result.errores}</strong>` };
      } catch (err) {
        return { type: 'error', response: `❌ Error enviando: ${err.message}` };
      }
    }

    const deudor = findDeudorByName(target);
    if (!deudor) {
      return { type: 'error', response: `❌ No encontré a "<strong>${escHtml(target)}</strong>".` };
    }

    try {
      const plantilla = db.getConfig('mensaje_recordatorio') || 'Hola {nombre}, tienes una deuda pendiente de ${deuda}.';
      const mensaje = formatMensaje(plantilla, deudor);
      await sendWhatsAppMessage(deudor.telefono, mensaje);
      db.logMensaje(deudor.id, 'manual', mensaje, 'enviado');
      return {
        type: 'success',
        response: `<div class="chat-deuda-card">
          <div class="deuda-name">${deudor.nombre}</div>
          <div class="deuda-amount-big">$${deudor.deuda_total.toFixed(2)}</div>
          <div class="deuda-wa-status sent">✅ Mensaje enviado por WhatsApp</div>
        </div>`
      };
    } catch (err) {
      return {
        type: 'error',
        response: `<div class="chat-deuda-card">
          <div class="deuda-name">${deudor.nombre}</div>
          <div class="deuda-amount-big">$${deudor.deuda_total.toFixed(2)}</div>
          <div class="deuda-wa-status error">❌ Error: ${err.message}</div>
        </div>`
      };
    }
  }

  // ===== OPERACIONES MÚLTIPLES (CARGOS/PAGOS): "nombre + 12 - 20" =====
  const opMatch = input.match(/^(.+?)\s*([+\-–]\s*\d+(?:\.\d+)?(?:\s*[+\-–]\s*\d+(?:\.\d+)?)*)$/);
  if (opMatch) {
    const nombre = opMatch[1].trim();
    const opsStr = opMatch[2];
    
    const deudor = findDeudorByName(nombre);
    if (!deudor) {
      return { type: 'error', response: `❌ No encontré a "<strong>${escHtml(nombre)}</strong>". Usa <code>nuevo ${escHtml(nombre)} telefono</code> para registrarlo.` };
    }

    const operations = opsStr.match(/[+\-–]\s*\d+(?:\.\d+)?/g);
    let totalCargos = 0;
    let totalPagos = 0;

    for (const op of operations) {
      const sign = op.trim().charAt(0);
      const amountStr = op.replace(/[+\-–]/, '').trim();
      const amount = parseFloat(amountStr);
      
      if (sign === '+' && amount > 0) {
        db.addCargo(deudor.id, amount, 'Compras desde chat');
        totalCargos += amount;
      } else if ((sign === '-' || sign === '–') && amount > 0) {
        db.addPago(deudor.id, amount, 'Pago registrado');
        totalPagos += amount;
      }
    }

    if (totalCargos === 0 && totalPagos === 0) {
      return { type: 'error', response: '❌ Los montos ingresados deben ser mayores a 0.' };
    }

    const updated = db.getDeudorById(deudor.id);
    let waStatus = '';
    
    try {
      let mensajeMsgs = [];
      if (totalCargos > 0 && totalPagos === 0) {
        mensajeMsgs.push(`se han cargado $${totalCargos.toFixed(2)} por tus nuevas compras.`);
      } else if (totalPagos > 0 && totalCargos === 0) {
        mensajeMsgs.push(`hemos recibido tu pago de $${totalPagos.toFixed(2)}.`);
      } else {
        mensajeMsgs.push(`registramos compras por $${totalCargos.toFixed(2)} y un pago de $${totalPagos.toFixed(2)}.`);
      }

      let mensaje = `Hola ${updated.nombre}, ${mensajeMsgs.join(' ')} `;
      
      if (updated.deuda_total > 0) {
        mensaje += `Tu saldo pendiente actual es de $${updated.deuda_total.toFixed(2)}.`;
      } else if (updated.deuda_total === 0) {
        if (totalPagos > 0) {
          mensaje += `¡Tu deuda ha quedado saldada! Gracias por tu pago. 🎉`;
        } else {
          mensaje += `Tu saldo pendiente está saldado.`;
        }
      } else {
        mensaje += `Tienes un saldo a favor de $${Math.abs(updated.deuda_total).toFixed(2)}. 🎉`;
      }
      
      await sendWhatsAppMessage(updated.telefono, mensaje);
      db.logMensaje(updated.id, 'actualización', mensaje, 'enviado');
      waStatus = '<div class="deuda-wa-status sent">✅ Notificado por WhatsApp</div>';
    } catch (err) {
      waStatus = `<div class="deuda-wa-status error">⚠️ WhatsApp: ${err.message}</div>`;
    }

    const saldoLabel = updated.deuda_total < 0
      ? `<div class="deuda-amount-big paid">Saldo a favor: $${Math.abs(updated.deuda_total).toFixed(2)} 🎉</div>`
      : `<div class="deuda-amount-big ${updated.deuda_total === 0 ? 'paid' : ''}">$${updated.deuda_total.toFixed(2)}</div>`;
      
    let opsDescription = '';
    if (totalCargos > 0 && totalPagos === 0) {
      opsDescription = `🛒 Se cargaron <strong>$${totalCargos.toFixed(2)}</strong> a la cuenta de <strong>${updated.nombre}</strong>`;
    } else if (totalPagos > 0 && totalCargos === 0) {
      opsDescription = `💵 Pago de <strong>$${totalPagos.toFixed(2)}</strong> registrado para <strong>${updated.nombre}</strong>`;
    } else {
      opsDescription = `🛒 Carga de <strong>$${totalCargos.toFixed(2)}</strong> y 💵 Pago de <strong>$${totalPagos.toFixed(2)}</strong> registrados para <strong>${updated.nombre}</strong>`;
    }

    return {
      type: 'success',
      response: `<p>${opsDescription}</p>
        <div class="chat-deuda-card">
          <div class="deuda-name">${updated.nombre}</div>
          ${saldoLabel}
          <div class="deuda-phone">📱 ${updated.telefono}</div>
          ${waStatus}
        </div>`
    };
  }

  // ===== Not recognized =====
  return {
    type: 'error',
    response: `🤔 No entendí "<strong>${escHtml(input)}</strong>". Escribe <strong>ayuda</strong> para ver los comandos disponibles.`
  };
}

// API route that uses processCommand
app.post('/api/chat/command', async (req, res) => {
  try {
    const result = await processCommand(req.body.command);
    res.json(result);
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
    
    // Validación de entrada
    const cleanNombre = String(nombre).trim().slice(0, 100);
    const cleanTelefono = String(telefono).replace(/[^\d+\-\s()]/g, '').trim().slice(0, 20);
    const cleanDeuda = Math.min(Math.max(parseFloat(deuda_total) || 0, 0), 999999.99);
    const cleanNotas = String(notas || '').trim().slice(0, 500);
    
    if (cleanNombre.length < 2) return res.status(400).json({ error: 'El nombre debe tener al menos 2 caracteres' });
    if (cleanTelefono.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'El teléfono debe tener al menos 10 dígitos' });
    
    const result = db.addDeudor(cleanNombre, cleanTelefono, cleanDeuda, cleanNotas);
    res.json({ id: result.lastInsertRowid, message: 'Deudor agregado' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Ese número ya está registrado' });
    res.status(500).json({ error: 'Error al agregar deudor' });
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
  try {
    const stats = db.getEstadisticas();
    stats.ventasPorDia = db.getVentasPorDia();
    res.json(stats);
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// -- Configuración --
app.get('/api/configuracion', (req, res) => {
  try {
    res.json({
      mensaje_recordatorio: db.getConfig('mensaje_recordatorio'),
      mensaje_respuesta: db.getConfig('mensaje_respuesta'),
      cron_activo: db.getConfig('cron_activo'),
      cron_horarios: db.getConfig('cron_horarios') || '{"lunes":"09:00","miercoles":"09:00","viernes":"09:00"}'
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/configuracion', (req, res) => {
  try {
    // Solo permitir claves de configuración conocidas
    const allowedKeys = ['mensaje_recordatorio', 'mensaje_respuesta', 'cron_activo', 'cron_horarios'];
    for (const [clave, valor] of Object.entries(req.body)) {
      if (allowedKeys.includes(clave)) {
        db.setConfig(clave, String(valor));
      }
    }
    setupCron();
    res.json({ message: 'Configuración actualizada' });
  } catch (err) { res.status(500).json({ error: 'Error guardando configuración' }); }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor iniciado en http://localhost:${PORT}`);
  console.log(`🔒 Modo: ${NODE_ENV}`);
  console.log(`👤 Usuario admin: ${ADMIN_USER}`);
  console.log('💬 Chat disponible en el navegador');
  console.log('📱 Conecta WhatsApp desde el panel web\n');
});

