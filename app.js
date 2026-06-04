const BUCKET_URL = 'https://kvdb.io/PN9BCNTq5bPDAQwk9gugKQ/';
const editor = document.getElementById('editor');
const statusEl = document.getElementById('status');
const pathDisplay = document.getElementById('path-display');
const loader = document.getElementById('loader');
const fileInput = document.getElementById('file-input');
const filesList = document.getElementById('files-list');

if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js').catch(function (error) {
            console.error('Service worker registration failed', error);
        });
    });
}

// Determine slug
let slug = window.location.pathname.substring(1).replace(/\/$/, "");

function jumpToPath() {
    let newPath = document.getElementById('path-input').value.trim();
    if (newPath) {
        if (!newPath.startsWith('/')) newPath = '/' + newPath;
        window.location.href = newPath;
    }
}

document.getElementById('path-input')?.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        jumpToPath();
    }
});

let isTyping = false;
let typingTimeout = null;
let lastSavedContent = '';

function normalizePathInput(value) {
    let nextPath = String(value || '').trim();
    if (!nextPath) return '/';
    nextPath = nextPath.replace(/^\/+/, '');
    return '/' + nextPath;
}

if (!slug || slug === 'index.html' || slug === '200.html') {
    // Show Homepage
    loader.classList.add('hidden');
    document.getElementById('homepage').classList.remove('hidden');
    document.getElementById('app-editor').classList.add('hidden');
    document.getElementById('nav-cat').classList.remove('hidden');
    statusEl.innerHTML = '';
} else {
    // Show Editor
    document.getElementById('homepage').classList.add('hidden');
    document.getElementById('app-editor').classList.remove('hidden');
    document.getElementById('nav-cat').classList.add('hidden');
    pathDisplay.textContent = '/' + slug;
    pathDisplay.contentEditable = 'true';

    function selectPathText() {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(pathDisplay);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    function navigateToEditedPath() {
        window.location.href = normalizePathInput(pathDisplay.textContent);
    }

    pathDisplay.addEventListener('focus', selectPathText);
    pathDisplay.addEventListener('click', selectPathText);
    pathDisplay.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            navigateToEditedPath();
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            pathDisplay.textContent = '/' + slug;
            pathDisplay.blur();
        }
    });

    const filesApiUrl = '/api/files/' + encodeURIComponent(slug);

    function formatBytes(bytes) {
        if (!bytes) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        const value = bytes / Math.pow(1024, index);
        return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function renderFiles(files) {
        if (!files.length) {
            filesList.innerHTML = '<div class="files-empty">Nenhum arquivo anexado.</div>';
            return;
        }

        filesList.innerHTML = files.map((file) => {
            const minutesLeft = Math.max(0, Math.ceil((file.expiresAt - Date.now()) / 60000));
            const safeName = escapeHtml(file.name);
            const downloadUrl = `/api/download/${encodeURIComponent(file.id)}?slug=${encodeURIComponent(slug)}`;

            return `
                <article class="file-row">
                    <div class="file-info">
                        <strong title="${safeName}">${safeName}</strong>
                        <span>${formatBytes(file.size)} · expira em ${minutesLeft} min</span>
                    </div>
                    <a class="download-button" href="${downloadUrl}">Baixar</a>
                </article>
            `;
        }).join('');
    }

    async function fetchFiles() {
        try {
            const response = await fetch(filesApiUrl);
            if (!response.ok) throw new Error('Failed to load files');
            const data = await response.json();
            renderFiles(data.files || []);
        } catch (e) {
            filesList.innerHTML = '<div class="files-empty">Não foi possível carregar os anexos.</div>';
        }
    }

    async function uploadFile(file) {
        const formData = new FormData();
        formData.append('file', file);
        statusEl.innerHTML = 'Uploading...';
        statusEl.className = 'status saving';

        try {
            const response = await fetch(filesApiUrl, {
                method: 'POST',
                body: formData
            });
            if (!response.ok) throw new Error('Upload failed');
            await fetchFiles();
            statusEl.innerHTML = 'Online';
            statusEl.className = 'status';
        } catch (e) {
            statusEl.innerHTML = 'Error';
            statusEl.className = 'status error';
        } finally {
            fileInput.value = '';
        }
    }

    fileInput?.addEventListener('change', function () {
        const [file] = fileInput.files || [];
        if (file) uploadFile(file);
    });

    async function fetchContent() {
        if (isTyping) return; // Don't fetch while user is typing
        try {
            const response = await fetch(BUCKET_URL + slug);
            if (response.ok) {
                const text = await response.text();
                if (editor.value !== text && !isTyping) {
                    const cursorPos = editor.selectionStart;
                    editor.value = text;
                    lastSavedContent = text;
                    // Try to preserve cursor position
                    editor.selectionStart = editor.selectionEnd = cursorPos;
                }
            }
        } catch (e) {
            console.error("Failed to fetch", e);
        }
    }

    async function saveContent(text) {
        statusEl.innerHTML = 'Saving...';
        statusEl.className = 'status saving';
        try {
            await fetch(BUCKET_URL + slug, {
                method: 'POST',
                body: text,
                headers: { 'Content-Type': 'text/plain' }
            });
            lastSavedContent = text;
            statusEl.innerHTML = 'Online';
            statusEl.className = 'status';
        } catch (e) {
            statusEl.innerHTML = 'Error';
            statusEl.className = 'status error';
        }
    }

    // Debounce save function
    function debounceSave() {
        clearTimeout(typingTimeout);
        isTyping = true;
        statusEl.innerHTML = 'Unsaved';
        statusEl.className = 'status saving';
        
        typingTimeout = setTimeout(() => {
            isTyping = false;
            if (editor.value !== lastSavedContent) {
                saveContent(editor.value);
            } else {
                statusEl.innerHTML = 'Online';
                statusEl.className = 'status';
            }
        }, 800); // 800ms debounce
    }

    editor.addEventListener('input', debounceSave);

    // Initial Load
    fetchContent().then(() => {
        loader.classList.add('hidden');
        editor.placeholder = "Comece a digitar aqui...";
        editor.focus();
        fetchFiles();
        
        // Start polling every 2 seconds
        setInterval(fetchContent, 2000);
        setInterval(fetchFiles, 30000);
    });
}
