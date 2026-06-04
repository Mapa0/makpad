$installDir = "$env:LOCALAPPDATA\Microsoft\WindowsApps"
$ps1Path = "$installDir\makpad.ps1"
$cmdPath = "$installDir\makpad.cmd"

Write-Host "🚀 Instalando MAKPAD CLI para Windows..."
Write-Host "Baixando arquivos base..."
Invoke-WebRequest -Uri "https://makpad.mapazero.com/makpad-ps1.txt" -OutFile $ps1Path -UseBasicParsing

Write-Host "Configurando command aliases..."
Set-Content -Path $cmdPath -Value "@powershell -NoProfile -ExecutionPolicy Bypass -File `"$ps1Path`" %*"

Write-Host "-----------------------------------"
Write-Host "✅ MAKPAD instalado com sucesso!"
Write-Host "Teste executando no terminal: makpad terminal_test"
Write-Host "-----------------------------------"
