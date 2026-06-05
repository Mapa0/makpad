const loginPanel = document.getElementById('login-panel');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('admin-password');
const notesTable = document.getElementById('notes-table');
const toast = document.getElementById('toast');
const refreshButton = document.getElementById('refresh-button');
const cleanupButton = document.getElementById('cleanup-button');
const configForm = document.getElementById('config-form');
const maxFileSizeInput = document.getElementById('max-file-size');
const maxFilesInput = document.getElementById('max-files');
const uploadCooldownInput = document.getElementById('upload-cooldown');
const fileTtlInput = document.getElementById('file-ttl');

let adminToken = window.localStorage.getItem('makpad-admin-token') || '';

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, index);
    return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatNumber(value) {
    return new Intl.NumberFormat('pt-BR').format(value || 0);
}

function showToast(message, isError = false) {
    toast.textContent = message;
    toast.className = `toast ${isError ? 'error' : ''}`;
    window.clearTimeout(showToast.timeout);
    showToast.timeout = window.setTimeout(() => toast.classList.add('hidden'), 3200);
}

async function adminFetch(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            ...(options.headers || {}),
            Authorization: `Bearer ${adminToken}`,
        },
    });

    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Falha no painel admin');
    }

    return response.json();
}

function renderConfig(config) {
    maxFileSizeInput.value = Math.round(config.maxFileSize / 1024 / 1024);
    maxFilesInput.value = config.maxFilesPerSlug;
    uploadCooldownInput.value = Math.round(config.uploadCooldownMs / 1000);
    fileTtlInput.value = Math.round(config.fileTtlMs / 60000);
}

function renderOverview(data) {
    const attachmentsEnabled = Boolean(data.attachmentsEnabled);

    document.getElementById('metric-notes').textContent = formatNumber(data.totals.notes);
    document.getElementById('metric-chars').textContent = formatNumber(data.totals.chars);
    document.getElementById('metric-attachments').textContent = formatNumber(data.totals.attachments);
    document.getElementById('metric-storage').textContent = attachmentsEnabled ? formatBytes(data.totals.bucketAttachmentBytes) : 'Off';
    cleanupButton.disabled = !attachmentsEnabled;

    const orphanInfo = document.getElementById('orphan-info');
    if (!attachmentsEnabled) {
        orphanInfo.textContent = 'Attachments desabilitados nesta instalação.';
    } else if (data.totals.orphanedAttachmentCount) {
        orphanInfo.textContent = `${data.totals.orphanedAttachmentCount} objetos órfãos usando ${formatBytes(data.totals.orphanedAttachmentBytes)}.`;
    } else {
        orphanInfo.textContent = 'Sem objetos órfãos detectados.';
    }

    notesTable.innerHTML = data.notes.map((note) => `
        <tr>
            <td>
                <a href="/${encodeURIComponent(note.slug)}" target="_blank" rel="noreferrer">/${note.slug}</a>
                <span>${note.updatedAt ? new Date(note.updatedAt).toLocaleString('pt-BR') : 'sem edição rastreada'}</span>
            </td>
            <td>${formatNumber(note.charCount)}</td>
            <td>${formatNumber(note.attachmentCount)}</td>
            <td>${formatBytes(note.bucketAttachmentBytes)}</td>
            <td>
                ${attachmentsEnabled ? `<button type="button" data-action="attachments" data-slug="${encodeURIComponent(note.slug)}">Limpar anexos</button>` : ''}
                <button type="button" data-action="all" data-slug="${encodeURIComponent(note.slug)}">Excluir tudo</button>
            </td>
        </tr>
    `).join('') || '<tr><td colspan="5" class="empty">Nenhum note rastreado ainda.</td></tr>';

    [maxFileSizeInput, maxFilesInput, uploadCooldownInput, fileTtlInput].forEach((input) => {
        input.disabled = !attachmentsEnabled;
    });

    renderConfig(data.config);
}

async function loadOverview() {
    const data = await adminFetch('/api/admin/overview');
    loginPanel.classList.add('hidden');
    dashboard.classList.remove('hidden');
    renderOverview(data);
}

loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    adminToken = passwordInput.value.trim();
    window.localStorage.setItem('makpad-admin-token', adminToken);

    try {
        await loadOverview();
        showToast('Painel carregado.');
    } catch (error) {
        showToast(error.message, true);
    }
});

refreshButton.addEventListener('click', () => {
    loadOverview().then(() => showToast('Dados atualizados.')).catch((error) => showToast(error.message, true));
});

cleanupButton.addEventListener('click', () => {
    adminFetch('/api/admin/cleanup-expired', { method: 'POST' })
        .then((data) => {
            renderOverview(data);
            showToast('Arquivos expirados limpos.');
        })
        .catch((error) => showToast(error.message, true));
});

notesTable.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const slug = decodeURIComponent(button.dataset.slug);
    const deleteNote = button.dataset.action === 'all';
    const ok = window.confirm(deleteNote
        ? `Excluir o note /${slug} e todos os anexos?`
        : `Limpar todos os anexos de /${slug}?`);

    if (!ok) return;

    try {
        await adminFetch(`/api/admin/chats/${encodeURIComponent(slug)}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deleteAttachments: true, deleteNote }),
        });
        await loadOverview();
        showToast(deleteNote ? 'Note excluído.' : 'Anexos removidos.');
    } catch (error) {
        showToast(error.message, true);
    }
});

configForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = {
        maxFileSize: Number(maxFileSizeInput.value) * 1024 * 1024,
        maxFilesPerSlug: Number(maxFilesInput.value),
        uploadCooldownMs: Number(uploadCooldownInput.value) * 1000,
        fileTtlMs: Number(fileTtlInput.value) * 60000,
    };

    try {
        const data = await adminFetch('/api/admin/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        renderConfig(data.config);
        showToast('Limites salvos.');
    } catch (error) {
        showToast(error.message, true);
    }
});

if (adminToken) {
    loadOverview().catch(() => {
        window.localStorage.removeItem('makpad-admin-token');
    });
}
