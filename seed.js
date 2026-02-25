// Script de carga inicial de deudores del salón
const db = require('./database');

const deudores = [
  { nombre: 'Alan', deuda: 160, telefono: '9811034910', notas: 'Pendiente ajuste -39' },
  { nombre: 'Carlos', deuda: 15, telefono: '9811920201', notas: '' },
  { nombre: 'Carrasco', deuda: 19, telefono: '2831041686', notas: '' },
  { nombre: 'Rafita', deuda: 76, telefono: '9812098909', notas: '' },
  { nombre: 'Oziel', deuda: 12, telefono: '9817362289', notas: '' },
  { nombre: 'Mau', deuda: 55, telefono: '9811143430', notas: 'Verificar teléfono' },
  { nombre: 'Dany', deuda: 50, telefono: '7221119984', notas: '' },
  { nombre: 'Uli', deuda: 23, telefono: '9811248677', notas: '' },
  { nombre: 'Alf', deuda: 57, telefono: '9813155324', notas: '' },
  { nombre: 'Sabido', deuda: 3, telefono: '9812243061', notas: '' },
  { nombre: 'Gabo', deuda: 22, telefono: '9811338404', notas: '' },
  { nombre: 'Foster', deuda: 0, telefono: '9381709733', notas: '' },
  { nombre: 'Adal', deuda: 6, telefono: '9811254966', notas: '' },
  { nombre: 'Tillit', deuda: 55, telefono: '9811935040', notas: '' },
  { nombre: 'Iker', deuda: 0, telefono: '9812933818', notas: '' },
  { nombre: 'Gemelo', deuda: 63, telefono: '9811979815', notas: '' },
  { nombre: 'Tony', deuda: 28, telefono: '9811778284', notas: '+3 extra incluido' },
  { nombre: 'Wilo', deuda: 15, telefono: '9812435937', notas: '' },
  { nombre: 'Arturo', deuda: 18, telefono: '9512974496', notas: '' },
  { nombre: 'Crillo', deuda: 12, telefono: '0000000000', notas: 'SIN TELÉFONO - AGREGAR' },
];

console.log('🚀 Cargando deudores del salón...\n');

let cargados = 0;
let errores = 0;

for (const d of deudores) {
  try {
    db.addDeudor(d.nombre, d.telefono, d.deuda, d.notas);
    const status = d.deuda > 0 ? `$${d.deuda.toFixed(2)}` : '✅ $0';
    console.log(`  ✅ ${d.nombre.padEnd(10)} → ${status.padEnd(10)} 📱 ${d.telefono}`);
    cargados++;
  } catch (err) {
    console.log(`  ❌ ${d.nombre}: ${err.message}`);
    errores++;
  }
}

const stats = db.getEstadisticas();
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`📊 Resumen:`);
console.log(`   Cargados: ${cargados} | Errores: ${errores}`);
console.log(`   Total deudores: ${stats.totalDeudores}`);
console.log(`   Con deuda: ${stats.deudoresConDeuda}`);
console.log(`   Deuda total: $${stats.totalDeuda.toFixed(2)}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
console.log('✅ ¡Listo! Ahora inicia el servidor con: node server.js\n');

process.exit(0);
