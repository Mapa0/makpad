#!/bin/bash

API_BASE="https://makpad.mapazero.com/api"

usage() {
    echo "Uso: makpad <chat> [texto|-a|--append|--files|--upload arquivo|--download id [destino]]"
    echo
    echo "Texto:"
    echo "  makpad exemplo"
    echo "  makpad exemplo \"Seu texto aqui\""
    echo "  echo 'linha' | makpad exemplo"
    echo "  echo 'linha' | makpad exemplo --append"
    echo
    echo "Arquivos:"
    echo "  makpad exemplo --files"
    echo "  makpad exemplo --upload ./arquivo.zip"
    echo "  makpad exemplo --download <file_id> ./arquivo.zip"
    exit 1
}

if [ -z "$1" ]; then
    usage
fi

CHAT="$1"
ACTION="$2"
VALUE="$3"
NOTE_URL="${API_BASE}/note/${CHAT}"
FILES_URL="${API_BASE}/files/${CHAT}"

ensure_attachments_enabled() {
    if ! curl -fsS "${API_BASE}/public/config" | grep -q '"attachmentsEnabled":true'; then
        echo "Attachments are disabled for this MAKPAD installation."
        exit 1
    fi
}

if [ "$ACTION" = "--files" ] || [ "$ACTION" = "-f" ]; then
    ensure_attachments_enabled
    curl -fsS "${FILES_URL}"
    echo
    exit $?
fi

if [ "$ACTION" = "--upload" ] || [ "$ACTION" = "-u" ]; then
    ensure_attachments_enabled
    if [ -z "$VALUE" ]; then
        echo "Informe o caminho do arquivo."
        exit 1
    fi

    curl -fsS -X POST -F "file=@${VALUE}" "${FILES_URL}"
    echo
    exit $?
fi

if [ "$ACTION" = "--download" ] || [ "$ACTION" = "-d" ]; then
    ensure_attachments_enabled
    FILE_ID="$VALUE"
    OUTPUT="$4"

    if [ -z "$FILE_ID" ]; then
        echo "Informe o id do arquivo."
        exit 1
    fi

    DOWNLOAD_URL="${API_BASE}/download/${FILE_ID}?slug=${CHAT}"
    if [ -n "$OUTPUT" ]; then
        curl -fL "${DOWNLOAD_URL}" -o "$OUTPUT"
    else
        curl -fLOJ "${DOWNLOAD_URL}"
    fi
    exit $?
fi

if [ -n "$ACTION" ] && [ "$ACTION" != "-a" ] && [ "$ACTION" != "--append" ]; then
    curl -fsS -X PUT --data-binary "$ACTION" -H "Content-Type: text/plain" "${NOTE_URL}" >/dev/null
    exit $?
fi

if [ ! -t 0 ]; then
    INPUT_TEXT=$(cat)

    if [ -z "$INPUT_TEXT" ] && [ -z "$ACTION" ]; then
        OUTPUT=$(curl -fsS -X GET "${NOTE_URL}" || true)
        if [ -n "$OUTPUT" ]; then
            echo "$OUTPUT"
        fi
        exit $?
    fi

    if [ "$ACTION" = "-a" ] || [ "$ACTION" = "--append" ]; then
        CURRENT_TEXT=$(curl -fsS -X GET "${NOTE_URL}" || true)
        if [ -n "$CURRENT_TEXT" ]; then
            NEW_TEXT="${CURRENT_TEXT}"$'\n'"${INPUT_TEXT}"
        else
            NEW_TEXT="${INPUT_TEXT}"
        fi
        curl -fsS -X PUT --data-binary "${NEW_TEXT}" -H "Content-Type: text/plain" "${NOTE_URL}" >/dev/null
    else
        curl -fsS -X PUT --data-binary "${INPUT_TEXT}" -H "Content-Type: text/plain" "${NOTE_URL}" >/dev/null
    fi
else
    OUTPUT=$(curl -fsS -X GET "${NOTE_URL}" || true)
    if [ -n "$OUTPUT" ]; then
        echo "$OUTPUT"
    fi
fi
