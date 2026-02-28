const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'deudas.db');
const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS deudores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    telefono TEXT NOT NULL UNIQUE,
    deuda_total REAL NOT NULL DEFAULT 0,
    notas TEXT DEFAULT '',
    activo INTEGER NOT NULL DEFAULT 1,
    fecha_creacion TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    fecha_actualizacion TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS pagos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deudor_id INTEGER NOT NULL,
    monto REAL NOT NULL,
    concepto TEXT DEFAULT '',
    tipo TEXT NOT NULL DEFAULT 'pago',
    fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (deudor_id) REFERENCES deudores(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS mensajes_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deudor_id INTEGER,
    tipo TEXT NOT NULL,
    mensaje TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'enviado',
    fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (deudor_id) REFERENCES deudores(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS configuracion (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );
`);

// Insert default config if not exists
const insertConfig = db.prepare('INSERT OR IGNORE INTO configuracion (clave, valor) VALUES (?, ?)');
insertConfig.run('mensaje_recordatorio', 'Hola {nombre}, te recuerdo que tienes una deuda pendiente de ${deuda}. ¡Gracias por tu atención!');
insertConfig.run('mensaje_respuesta', 'Hola {nombre}, tu deuda actual es de ${deuda}. Si ya realizaste un pago, por favor notifica al administrador.');
insertConfig.run('cron_activo', '0');
insertConfig.run('cron_horario', '09:00');
insertConfig.run('cron_dias', 'lunes,miercoles,viernes');

// ===== DEUDORES =====
const getAllDeudores = () => {
  return db.prepare(`
    SELECT d.*, 
      COALESCE(SUM(CASE WHEN p.tipo = 'cargo' THEN p.monto ELSE 0 END), 0) as total_cargos,
      COALESCE(SUM(CASE WHEN p.tipo = 'pago' THEN p.monto ELSE 0 END), 0) as total_pagos
    FROM deudores d
    LEFT JOIN pagos p ON d.id = p.deudor_id
    WHERE d.activo = 1
    GROUP BY d.id
    ORDER BY d.nombre ASC
  `).all();
};

const getDeudorById = (id) => {
  return db.prepare('SELECT * FROM deudores WHERE id = ? AND activo = 1').get(id);
};

const getDeudorByTelefono = (telefono) => {
  // Clean phone number - try multiple formats
  const cleanPhone = telefono.replace(/\D/g, '');
  return db.prepare(`
    SELECT * FROM deudores 
    WHERE activo = 1 AND (
      REPLACE(REPLACE(REPLACE(telefono, ' ', ''), '-', ''), '+', '') = ?
      OR REPLACE(REPLACE(REPLACE(telefono, ' ', ''), '-', ''), '+', '') LIKE ?
    )
  `).get(cleanPhone, '%' + cleanPhone.slice(-10));
};

const addDeudor = (nombre, telefono, deuda_total, notas = '') => {
  const stmt = db.prepare('INSERT INTO deudores (nombre, telefono, deuda_total, notas) VALUES (?, ?, ?, ?)');
  const result = stmt.run(nombre, telefono, deuda_total, notas);

  // Add initial charge record
  if (deuda_total > 0) {
    db.prepare('INSERT INTO pagos (deudor_id, monto, concepto, tipo) VALUES (?, ?, ?, ?)').run(
      result.lastInsertRowid, deuda_total, 'Deuda inicial', 'cargo'
    );
  }

  return result;
};

const updateDeudor = (id, nombre, telefono, deuda_total, notas) => {
  return db.prepare(`
    UPDATE deudores 
    SET nombre = ?, telefono = ?, deuda_total = ?, notas = ?, fecha_actualizacion = datetime('now', 'localtime')
    WHERE id = ?
  `).run(nombre, telefono, deuda_total, notas, id);
};

const deleteDeudor = (id) => {
  return db.prepare('UPDATE deudores SET activo = 0 WHERE id = ?').run(id);
};

// ===== PAGOS =====
const addPago = (deudor_id, monto, concepto = '') => {
  const pago = db.prepare('INSERT INTO pagos (deudor_id, monto, concepto, tipo) VALUES (?, ?, ?, ?)').run(
    deudor_id, monto, concepto, 'pago'
  );

  // Update deuda_total
  const deudor = getDeudorById(deudor_id);
  if (deudor) {
    const nuevaDeuda = deudor.deuda_total - monto;
    db.prepare("UPDATE deudores SET deuda_total = ?, fecha_actualizacion = datetime('now', 'localtime') WHERE id = ?").run(nuevaDeuda, deudor_id);
  }

  return pago;
};

const addCargo = (deudor_id, monto, concepto = '') => {
  const cargo = db.prepare('INSERT INTO pagos (deudor_id, monto, concepto, tipo) VALUES (?, ?, ?, ?)').run(
    deudor_id, monto, concepto, 'cargo'
  );

  // Update deuda_total
  const deudor = getDeudorById(deudor_id);
  if (deudor) {
    const nuevaDeuda = deudor.deuda_total + monto;
    db.prepare("UPDATE deudores SET deuda_total = ?, fecha_actualizacion = datetime('now', 'localtime') WHERE id = ?").run(nuevaDeuda, deudor_id);
  }

  return cargo;
};

const getPagosByDeudor = (deudor_id) => {
  return db.prepare('SELECT * FROM pagos WHERE deudor_id = ? ORDER BY fecha DESC').all(deudor_id);
};

// ===== MENSAJES LOG =====
const logMensaje = (deudor_id, tipo, mensaje, estado = 'enviado') => {
  return db.prepare('INSERT INTO mensajes_log (deudor_id, tipo, mensaje, estado) VALUES (?, ?, ?, ?)').run(
    deudor_id, tipo, mensaje, estado
  );
};

const getMensajesRecientes = (limit = 50) => {
  return db.prepare(`
    SELECT ml.*, d.nombre as deudor_nombre
    FROM mensajes_log ml
    LEFT JOIN deudores d ON ml.deudor_id = d.id
    ORDER BY ml.fecha DESC
    LIMIT ?
  `).all(limit);
};

// ===== CONFIGURACION =====
const getConfig = (clave) => {
  const row = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(clave);
  return row ? row.valor : null;
};

const setConfig = (clave, valor) => {
  return db.prepare('INSERT OR REPLACE INTO configuracion (clave, valor) VALUES (?, ?)').run(clave, valor);
};

// ===== ESTADISTICAS =====
const getEstadisticas = () => {
  const totalDeudores = db.prepare('SELECT COUNT(*) as count FROM deudores WHERE activo = 1').get().count;
  const totalDeuda = db.prepare('SELECT COALESCE(SUM(deuda_total), 0) as total FROM deudores WHERE activo = 1').get().total;
  const deudoresConDeuda = db.prepare('SELECT COUNT(*) as count FROM deudores WHERE activo = 1 AND deuda_total > 0').get().count;
  const totalPagos = db.prepare("SELECT COALESCE(SUM(monto), 0) as total FROM pagos WHERE tipo = 'pago'").get().total;
  const mensajesHoy = db.prepare("SELECT COUNT(*) as count FROM mensajes_log WHERE fecha >= date('now', 'localtime')").get().count;

  return {
    totalDeudores,
    totalDeuda,
    deudoresConDeuda,
    deudoresSinDeuda: totalDeudores - deudoresConDeuda,
    totalPagos,
    mensajesHoy
  };
};

const getVentasPorDia = () => {
  return db.prepare(`
    SELECT date(fecha) as fecha, SUM(monto) as total
    FROM pagos
    WHERE tipo = 'cargo'
    GROUP BY date(fecha)
    ORDER BY date(fecha) DESC
    LIMIT 7
  `).all().reverse();
};

module.exports = {
  db,
  getAllDeudores,
  getDeudorById,
  getDeudorByTelefono,
  addDeudor,
  updateDeudor,
  deleteDeudor,
  addPago,
  addCargo,
  getPagosByDeudor,
  logMensaje,
  getMensajesRecientes,
  getConfig,
  setConfig,
  getEstadisticas,
  getVentasPorDia
};
