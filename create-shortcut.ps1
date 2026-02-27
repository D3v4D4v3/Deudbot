$WshShell = New-Object -ComObject WScript.Shell
$StartupPath = [System.IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup\DeudBot.lnk')
$Shortcut = $WshShell.CreateShortcut($StartupPath)
$Shortcut.TargetPath = 'c:\Users\David\.gemini\antigravity\scratch\chatbot-deudas\start-deudbot.bat'
$Shortcut.WorkingDirectory = 'c:\Users\David\.gemini\antigravity\scratch\chatbot-deudas'
$Shortcut.Description = 'DeudBot - Chatbot de Deudas WhatsApp'
$Shortcut.Save()

Write-Host "Acceso directo creado exitosamente en: $StartupPath"
Write-Host "DeudBot se iniciara automaticamente cada vez que enciendas tu computadora."
