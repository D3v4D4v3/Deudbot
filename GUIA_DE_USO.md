# 📖 Guía de Uso — DeudBot

> Chatbot para gestionar y notificar deudas por WhatsApp.

---

## 🚀 1. Iniciar el Servidor

Abre una terminal en la carpeta del proyecto y ejecuta:

```bash
node server.js
```

Verás este mensaje:

```
🚀 Servidor iniciado en http://localhost:3000
💬 Chat disponible en el navegador
📱 Conecta WhatsApp desde la sección WhatsApp
```

Abre tu navegador en **http://localhost:3000** y listo.

---

## 💬 2. Chat (Pantalla Principal)

El **Chat** es la forma más rápida de gestionar deudas. Escribe comandos directamente como si fuera un chat de WhatsApp.

### Comandos Disponibles

| Comando | Ejemplo | Qué hace |
|---------|---------|----------|
| `nombre - monto` | `mau - 40` | **Pone la deuda en esa cantidad** (ej: la deuda de Mau queda en $40) |
| `nombre +monto` | `mau +15` | **Suma** $15 a la deuda actual de Mau |
| `nombre pago monto` | `mau pago 20` | **Registra un pago** de $20 (resta de la deuda) |
| `nuevo nombre tel` | `nuevo Juan 5512345678` | **Agrega** un nuevo deudor |
| `nuevo nombre tel monto` | `nuevo Juan 5512345678 50` | **Agrega** deudor con deuda inicial de $50 |
| `borrar nombre` | `borrar Juan` | **Elimina** al deudor |
| `lista` | `lista` | **Muestra todos** los deudores y sus deudas |
| `info nombre` | `info mau` | **Detalle** de un deudor con historial de pagos |
| `total` | `total` | **Resumen general**: total deudores, deuda total, pagos |
| `notificar nombre` | `notificar mau` | **Envía recordatorio** por WhatsApp a ese deudor |
| `notificar todos` | `notificar todos` | **Envía recordatorio** a todos los que deben |
| `ayuda` | `ayuda` | **Muestra** esta lista de comandos |

### Ejemplos de Uso Diario

```
# Llega alguien nuevo al salón:
nuevo Pedro 5544332211

# Le fían $30:
Pedro - 30

# Otro día le fían más:
Pedro +20

# Pedro paga $15:
Pedro pago 15

# Ver cuánto debe ahora:
info Pedro

# Ver quién debe y cuánto:
lista
```

> 💡 **Tip:** Los nombres no necesitan mayúsculas exactas. Si escribes `mau`, encontrará a `Mau` automáticamente.

---

## 📊 3. Dashboard

Haz clic en **📊 Dashboard** en el menú lateral para ver:

- **👥 Deudores** — Total de personas registradas
- **💰 Deuda Total** — Suma de todas las deudas
- **⚠️ Con Deuda** — Cuántos tienen saldo pendiente
- **📩 Mensajes Hoy** — Recordatorios enviados hoy
- **🔝 Mayores Deudas** — Los 5 que más deben
- **📋 Actividad Reciente** — Últimos movimientos

---

## 👥 4. Deudores

Haz clic en **👥 Deudores** en el menú lateral.

### Funciones:
- **🔍 Buscar** — Filtra por nombre o teléfono usando la barra de búsqueda
- **+ Agregar Deudor** — Botón para agregar manualmente (abre un formulario)
- **💵** — Registrar un pago
- **📤** — Enviar recordatorio por WhatsApp
- **✏️** — Editar nombre, teléfono, deuda o notas
- **🗑️** — Eliminar deudor

---

## 📱 5. WhatsApp

Haz clic en **📱 WhatsApp** en el menú lateral.

### Conectar WhatsApp:

1. Haz clic en **"Conectar WhatsApp"**
2. Espera a que aparezca el **código QR**
3. En tu teléfono, abre **WhatsApp → Menú (⋮) → Dispositivos vinculados → Vincular dispositivo**
4. Escanea el código QR
5. ¡Listo! El indicador cambiará a ✅ **Conectado**

### Funciones con WhatsApp conectado:

- **Auto-respuesta**: Si un deudor te escribe preguntando por su deuda (palabras como "deuda", "debo", "cuanto debo", "saldo", etc.), el bot le responde automáticamente con su saldo.
- **Recordatorios manuales**: Desde el chat escribe `notificar mau` o `notificar todos`.
- **Notificación al actualizar**: Cada vez que actualizas una deuda o registras un pago, se envía automáticamente un mensaje al deudor por WhatsApp.

### Enviar recordatorio masivo:

En la sección WhatsApp hay un botón **"🚀 Enviar a Todos"** que manda un recordatorio a todos los que tienen deuda pendiente.

> ⚠️ **Nota:** Si WhatsApp no está conectado, las operaciones de chat siguen funcionando normalmente, solo que los mensajes de WhatsApp no se enviarán (verás un aviso de "WhatsApp no está conectado").

---

## ✉️ 6. Historial de Mensajes

Haz clic en **✉️ Mensajes** para ver un registro de todos los mensajes enviados:

- **Fecha** — Cuándo se envió
- **Deudor** — A quién
- **Tipo** — `recordatorio`, `manual`, `auto-respuesta`, `actualización`
- **Mensaje** — Contenido del mensaje
- **Estado** — `enviado` o `error`

---

## ⚙️ 7. Configuración

Haz clic en **⚙️ Ajustes** en el menú lateral.

### Plantilla de Recordatorio
Mensaje que se envía como recordatorio. Puedes usar estas variables:
- `{nombre}` — Nombre del deudor
- `${deuda}` — Monto de la deuda

**Ejemplo:**
```
Hola {nombre}, te recuerdo que tienes una deuda pendiente de ${deuda}. ¡Gracias!
```

### Plantilla de Auto-respuesta
Mensaje que el bot envía cuando un deudor pregunta por su deuda.

**Ejemplo:**
```
Hola {nombre}, tu deuda actual es de ${deuda}. Si ya realizaste un pago, notifica al administrador.
```

### Recordatorios Automáticos
- **Activar/desactivar** el envío automático
- **Hora de envío** — A qué hora se mandan (ej: 09:00)
- **Días** — Qué días de la semana (ej: Lunes, Miércoles, Viernes)

Haz clic en **"💾 Guardar Configuración"** para aplicar los cambios.

---

## 🔄 8. Flujo de Trabajo Recomendado

### Día a día:
1. Abre http://localhost:3000
2. En el **Chat**, registra las deudas nuevas: `Pedro - 30`
3. Cuando alguien pague: `Pedro pago 15`
4. Al final del día escribe `lista` para ver el estado general

### Cada semana:
1. Revisa el **Dashboard** para ver el resumen
2. Conecta **WhatsApp** si no está conectado
3. Envía recordatorios: escribe `notificar todos` en el chat
4. Revisa el **Historial de Mensajes** para confirmar envíos

---

## ❓ Preguntas Frecuentes

### ¿Qué pasa si cierro la terminal?
El servidor se detiene y la app deja de funcionar. Debes ejecutar `node server.js` nuevamente. La base de datos se mantiene guardada.

### ¿Se pierden los datos?
No. Todo se guarda en el archivo `deudas.db` (SQLite). Mientras no borres ese archivo, tus datos persisten.

### ¿Puedo usarlo desde otro dispositivo en mi red?
Sí. En lugar de `localhost`, usa la IP de tu computadora (ej: `http://192.168.1.100:3000`).

### ¿WhatsApp se desconecta solo?
Si no usas WhatsApp Web por mucho tiempo, puede desconectarse. Solo vuelve a escanear el QR.

### ¿Cómo reinicio la base de datos?
Elimina el archivo `deudas.db` y vuelve a ejecutar:
```bash
node seed.js    # Carga los deudores iniciales
node server.js  # Inicia el servidor
```

---

## 📁 Estructura del Proyecto

```
chatbot-deudas/
├── server.js        → Servidor Express + API + Chat Commands + WhatsApp
├── database.js      → Base de datos SQLite (deudores, pagos, config)
├── seed.js          → Script para cargar deudores iniciales
├── deudas.db        → Base de datos (se crea automáticamente)
├── package.json     → Dependencias del proyecto
└── public/
    ├── index.html   → Interfaz web completa
    ├── app.js       → Lógica del frontend
    └── style.css    → Estilos modernos (dark mode)
```

---

**🤖 ¡Listo! Ya sabes cómo usar DeudBot. Escribe `ayuda` en el chat si olvidas algún comando.**
