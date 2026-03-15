import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1';

// --- CONFIGURATION ---
const HF_USERNAME = "eorchat";
const REPO_NAME = "eor";
const HF_BASE_URL = `https://huggingface.co/${HF_USERNAME}/${REPO_NAME}/resolve/main/`;
const STORAGE_FOLDER = "eor_storage";

const FILES_TO_DOWNLOAD = [
    "Qwen2.5-1.5B-Instruct.Q4_K_M.gguf",
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json"
];

// --- STORAGE SYSTEM (OPFS) ---
async function getStorageDir() {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(STORAGE_FOLDER, { create: true });
}

async function fileExists(filename) {
    try {
        const dir = await getStorageDir();
        await dir.getFileHandle(filename);
        return true;
    } catch (e) { return false; }
}

async function loadFileToMemory(filename) {
    const dir = await getStorageDir();
    const handle = await dir.getFileHandle(filename);
    const file = await handle.getFile();
    if (file.size === 0) throw new Error(`File ${filename} is corrupted (0 bytes).`);
    return await file.arrayBuffer();
}

async function downloadAndSave(filename, progressCallback) {
    const url = HF_BASE_URL + filename;
    const response = await fetch(url);
    if (!response.ok) throw new Error("HTTP " + response.status);
    
    const reader = response.body.getReader();
    const contentLength = +response.headers.get('Content-Length');
    let receivedLength = 0;
    let chunks = [];
    
    while(true) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedLength += value.length;
        if(progressCallback) progressCallback(receivedLength, contentLength);
    }

    const buffer = new Uint8Array(receivedLength);
    let position = 0;
    for(let chunk of chunks) {
        buffer.set(chunk, position);
        position += chunk.length;
    }

    const dir = await getStorageDir();
    const handle = await dir.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(buffer);
    await writable.close();
    
    return buffer.buffer;
}

// --- UI CONTROLLER ---
const ui = {
    dom: {},
    
    init: function() {
        this.dom = {
            list: document.getElementById('chat-list'),
            viewport: document.getElementById('chat-viewport'),
            input: document.getElementById('msg-input'),
            btn: document.getElementById('send-btn'),
            dot: document.getElementById('status-dot'),
            text: document.getElementById('status-text'),
            sidebar: document.getElementById('sidebar'),
            backdrop: document.getElementById('mobile-backdrop'),
            menuBtn: document.getElementById('menu-btn'),
            menuIcon: document.getElementById('menu-icon'),
            loader: {
                overlay: document.getElementById('loader-overlay'),
                log: document.getElementById('loader-log'),
                bar: document.getElementById('progress-bar')
            },
            navWorkspace: document.getElementById('nav-workspace'),
            navReset: document.getElementById('nav-reset'),
            navTheme: document.getElementById('nav-theme'),
            statusPill: document.getElementById('status-pill'),
            assistBtn: document.getElementById('assist-btn')
        };

        // --- FIX: All Event Listeners Here ---
        
        // 1. Mobile Menu Button
        this.dom.menuBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleMobileMenu();
        });

        // 2. Backdrop (Click to close)
        this.dom.backdrop.addEventListener('click', (e) => {
            e.preventDefault();
            this.closeMobileMenu();
        });

        // 3. Sidebar Navigation
        this.dom.navWorkspace.addEventListener('click', () => this.closeMobileMenu());
        this.dom.navReset.addEventListener('click', () => { app.reset(); this.closeMobileMenu(); });
        this.dom.navTheme.addEventListener('click', () => { document.body.classList.toggle('dark-mode'); this.closeMobileMenu(); });

        // 4. Status Pill (Init Engine)
        this.dom.statusPill.addEventListener('click', () => { engine.init(); this.closeMobileMenu(); });

        // 5. Input & Send Button
        this.dom.input.addEventListener('input', () => this.resize(this.dom.input));
        this.dom.input.addEventListener('keydown', (e) => app.handleEnter(e));
        
        // Fix: Send button listener
        this.dom.btn.addEventListener('click', (e) => {
            e.preventDefault();
            app.send();
        });

        this.dom.assistBtn.addEventListener('click', (e) => {
            e.preventDefault();
            app.assist('universal');
        });

        // Initialize status
        this.updateStatus(false);
    },

    updateStatus: function(isReady) {
        const { dot, text, btn } = this.dom;
        if(!dot) return;
        
        dot.className = 'status-dot';
        if (isReady) {
            dot.classList.add('online');
            text.innerText = "System Ready";
            text.style.color = "#10b981";
            btn.disabled = false;
        } else {
            text.innerText = "Offline";
            text.style.color = "var(--text-muted)";
            // Fix: Ensure button is not disabled so we can click it to trigger warning
            btn.disabled = false; 
        }
    },

    toggleMobileMenu: function() {
        const { sidebar, backdrop, menuIcon } = this.dom;
        const isOpen = sidebar.classList.contains('open');
        if (isOpen) {
            this.closeMobileMenu();
        } else {
            sidebar.classList.add('open');
            backdrop.classList.add('open');
            menuIcon.className = "fa-solid fa-xmark";
        }
    },

    closeMobileMenu: function() {
        const { sidebar, backdrop, menuIcon } = this.dom;
        sidebar.classList.remove('open');
        backdrop.classList.remove('open');
        menuIcon.className = "fa-solid fa-bars";
    },

    resize: function(el) {
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
    },

    scrollToBottom: function() {
        this.dom.viewport.scrollTop = this.dom.viewport.scrollHeight;
    },

    formatText: function(text) {
        let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
            return `<div class="code-block"><pre><code>${code}</code></pre></div>`;
        });
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\n/g, '<br>');
        return html;
    },

    addMessage: function(role, content, isLoading = false) {
        const { list } = this.dom;
        const row = document.createElement('div');
        
        row.className = `message-row ${role}`;
        
        if (role === 'user') {
            row.innerHTML = `<div class="message-content">${this.formatText(content)}</div>`;
        } else {
            const displayContent = isLoading 
                ? '<div class="typing-dots"></div>' 
                : this.formatText(content);
            
            row.innerHTML = `<div class="message-content">${displayContent}</div>`;
        }
        
        list.appendChild(row);
        this.scrollToBottom();
        return row.querySelector('.message-content');
    },

    updateLastMessage: function(content) {
        const lastMsg = this.dom.list.querySelector('.message-row:last-child .message-content');
        if(lastMsg) {
            lastMsg.innerHTML = this.formatText(content);
            this.scrollToBottom();
        }
    }
};

// --- ENGINE CONTROLLER ---
const engine = {
    generator: null,
    isReady: false,

    init: async function() {
        const { loader } = ui.dom;
        loader.overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
        loader.log.innerText = '> Initializing System...\n';
        loader.bar.style.width = '0%';

        try {
            // SECURITY CHECK: Detect file protocol
            if (window
