const BUCKET_URL = 'https://kvdb.io/PN9BCNTq5bPDAQwk9gugKQ/';
const editor = document.getElementById('editor');
const statusEl = document.getElementById('status');
const pathDisplay = document.getElementById('path-display');
const loader = document.getElementById('loader');

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
        
        // Start polling every 2 seconds
        setInterval(fetchContent, 2000);
    });
}
