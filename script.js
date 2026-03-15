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
            statusPill: document.getElementById('status-pill')
        };

        // Event Listeners
        this.dom.menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleMobileMenu();
        });

        this.dom.backdrop.addEventListener('click', () => this.closeMobileMenu());

        this.dom.navWorkspace.addEventListener('click', () => this.closeMobileMenu());
        this.dom.navReset.addEventListener('click', () => { app.reset(); this.closeMobileMenu(); });
        this.dom.navTheme.addEventListener('click', () => { document.body.classList.toggle('dark-mode'); this.closeMobileMenu(); });
        this.dom.statusPill.addEventListener('click', () => { engine.init(); this.closeMobileMenu(); });

        this.dom.input.addEventListener('input', () => this.resize(this.dom.input));
        this.dom.input.addEventListener('keydown', (e) => app.handleEnter(e));
        this.dom.btn.addEventListener('click', () => app.send());

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
            btn.disabled = false; 
        }
    },

    toggleMobileMenu: function() {
        const { sidebar, backdrop, menuIcon } = this.dom;
        const isOpen = sidebar.classList.contains('open');
        if (isOpen) this.closeMobileMenu();
        else {
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

    scrollToBottom: function() { this.dom.viewport.scrollTop = this.dom.viewport.scrollHeight; },

    formatText: function(text) {
        let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (m, l, c) => `<pre><code>${c}</code></pre>`);
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\n/g, '<br>');
        return html;
    },

    addMessage: function(role, content, isLoading = false) {
        const { list } = this.dom;
        const row = document.createElement('div');
        row.className = `message-row ${role}`;
        if (role === 'user') row.innerHTML = `<div class="message-content">${this.formatText(content)}</div>`;
        else row.innerHTML = `<div class="message-content">${isLoading ? '<div class="typing-dots"></div>' : this.formatText(content)}</div>`;
        list.appendChild(row);
        this.scrollToBottom();
    },

    updateLastMessage: function(content) {
        const lastMsg = this.dom.list.querySelector('.message-row:last-child .message-content');
        if(lastMsg) { lastMsg.innerHTML = this.formatText(content); this.scrollToBottom(); }
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
        loader.log.innerText = '> System Init...\n';
        loader.bar.style.width = '0%';

        try {
            // 1. DOWNLOAD/CHECK FILES
            let progress = 0;
            const totalFiles = FILES_TO_DOWNLOAD.length;
            for (const file of FILES_TO_DOWNLOAD) {
                loader.log.innerText += `> Checking ${file}...\n`;
                if (await fileExists(file)) {
                    try { await loadFileToMemory(file); loader.log.innerText += `> Found.\n`; } 
                    catch (e) {
                        loader.log.innerText += `> Re-downloading...\n`;
                        await downloadAndSave(file, (l, s) => loader.bar.style.width = ((progress + l/s) / totalFiles * 80) + '%');
                    }
                } else {
                    loader.log.innerText += `> Downloading... (Wait)\n`;
                    await downloadAndSave(file, (l, s) => loader.bar.style.width = ((progress + l/s) / totalFiles * 80) + '%');
                }
                progress++;
                loader.bar.style.width = (progress / totalFiles) * 80 + '%';
            }

            // 2. LOAD MODEL
            loader.log.innerText += '> Loading AI Engine...\n';
            const ggufBuffer = await loadFileToMemory(FILES_TO_DOWNLOAD[0]);
            const modelBlob = new Blob([ggufBuffer], { type: 'application/octet-stream' });
            const modelUrl = URL.createObjectURL(modelBlob);

            env.useBrowserCache = false; 
            env.allowLocalModels = false;

            this.generator = await pipeline('text-generation', modelUrl, {
                quantized: true,
                dtype: 'q4',
                // This helps show progress inside the model loading phase
                progress_callback: (data) => {
                    if(data.status === 'loading') loader.log.innerText = `> Loading: ${data.file} ${Math.round(data.progress || 0)}%`;
                }
            });

            loader.log.innerText += '> Model Loaded!\n';
            loader.bar.style.width = '100%';
            this.isReady = true;
            ui.updateStatus(true);
            
            setTimeout(() => {
                loader.overlay.classList.remove('active');
                document.body.style.overflow = '';
                ui.addMessage('eor', 'AI Online. Model loaded successfully.');
            }, 500);

        } catch (error) {
            console.error(error);
            loader.log.innerHTML += `\n<span style="color:red">> ERROR: ${error.message}</span>\n`;
            loader.bar.style.width = '0%';
            
            // If on mobile/github pages, show specific helpful error
            if (error.message.includes('out of memory') || error.message.includes('memory')) {
                loader.log.innerHTML += `\n> Memory Limit Reached. Try closing other tabs.\n`;
            } else if (window.location.protocol === 'https:') {
                 loader.log.innerHTML += `\n> Secure Context: OK. Connection Issue? Check console.\n`;
            }
            
            document.body.style.overflow = '';
            ui.updateStatus(false);
        }
    },

    generate: async function(prompt) {
        if (!this.isReady) return ui.addMessage('eor', "System offline.");
        ui.addMessage('eor', '', true); 
        try {
            const output = await this.generator(prompt, { max_new_tokens: 100 });
            ui.updateLastMessage(output[0].generated_text);
        } catch (err) {
            ui.updateLastMessage(`Error: ${err.message}`);
        }
    }
};

// --- APP LOGIC ---
const app = {
    handleEnter(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } },
    reset() { ui.dom.list.innerHTML = ''; ui.addMessage('eor', "Reset."); },
    
    async send() {
        const text = ui.dom.input.value.trim();
        if (!text) return;
        if (!engine.isReady) { if(confirm("Start AI?")) engine.init(); return; }

        ui.dom.input.value = ''; ui.dom.input.style.height = 'auto';
        ui.addMessage('user', text);
        ui.dom.btn.disabled = true;
        await engine.generate(text);
        ui.dom.btn.disabled = false;
        ui.dom.input.focus();
    }
};

// Init
window.addEventListener('DOMContentLoaded', () => {
    ui.init();
    window.app = app;
    window.engine = engine;
});
