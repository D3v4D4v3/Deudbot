@echo off
title DeudBot - Chatbot de Deudas WhatsApp
echo ==========================================
echo   Iniciando DeudBot...
echo ==========================================
echo.

cd /d "c:\Users\David\.gemini\antigravity\scratch\chatbot-deudas"

:: Verificar que node_modules existe
if not exist "node_modules" (
    echo Instalando dependencias...
    npm install
    echo.
)

echo Arrancando el servidor...
node server.js

:: Si el servidor se detiene, pausar para ver errores
echo.
echo El servidor se ha detenido.
pause
