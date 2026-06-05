#!/bin/bash
set -e
echo "🚀 Instalando MAKPAD CLI para Linux/macOS..."
if [ "$(id -u)" -ne 0 ]; then
    echo "⚠️ Por favor, entre com a sua senha caso seja solicitada pelo sudo:"
    SUDO="sudo"
else
    SUDO=""
fi

$SUDO curl -sL https://makpad.mapazero.com/makpad-cli.txt -o /usr/local/bin/makpad
$SUDO chmod +x /usr/local/bin/makpad
echo "-----------------------------------"
echo "✅ MAKPAD instalado com sucesso!"
echo "Teste agora executando: makpad terminal_test"
echo "-----------------------------------"
