console.log("System Boot. Target: eor_storage. Engine: Transformers.js (Main Thread).");

// IMPORT AI LIBRARY DIRECTLY (Main Thread)
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1';

// Configuration
const HF_USERNAME = "eorchat";
const REPO_NAME = "eor";
const HF_BASE_URL = "https://huggingface.co/" + HF_USERNAME + "/" + REPO_NAME + "/resolve/main/";
const STORAGE_FOLDER = "eor_storage";

const FILES_TO_DOWNLOAD = [
    "Qwen2.5-1.5B-Instruct.Q4_K_M.gguf",
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json"
];

// --- STORAGE SYSTEM (SAME AS BEFORE) ---

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

function formatBytes(bytes) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + ['Bytes','KB','MB','GB'][i];
}

async function loadFileToMemory(filename) {
    const dir = await getStorageDir();
    const handle = await dir.getFileHandle(filename);
    const file = await handle.getFile();
    return await file.arrayBuffer();
}

async function downloadAndSave(filename) {
    const url = HF_BASE_URL + filename;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("HTTP " + response.status);
        
        const buffer = await response.arrayBuffer();
        
        const dir = await getStorageDir();
        const handle = await dir.getFileHandle(filename, { create: true });
        const writable = await handle.createWritable();
        await writable.write(buffer);
        await writable.close();
        
        return buffer;
    } catch (err) {
        throw new Error("Failed to download " + filename + ": " + err.message);
    }
}

// --- ENGINE CONTROLLER (MAIN THREAD) ---

const engine = {
    generator: null,
    isReady: false,
    history: [],

    init: async function() {
        if (this.isReady) return;
        
        const log = document.getElementById('loader-log');
        const bar = document.getElementById('progress-bar');
        const overlay = document.getElementById('loader-overlay');

        if(!log || !bar || !overlay) return;
        
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
        log.innerHTML = '> System Init...';
        bar.style.width = '0%';

        try {
            // 1. Verify/Create Folder
            await getStorageDir();
            log.innerHTML += '> Folder eor_storage verified.<br>';
            
            const filesToFetch = [];
            
            // 2. Check files
            for (const file of FILES_TO_DOWNLOAD) {
                if (await fileExists(file)) {
                    log.innerHTML += '> Found locally: ' + file + '<br>';
                    // We need to load it to count progress
                    await loadFileToMemory(file);
                } else {
                    log.innerHTML += '> Missing: ' + file + '. Downloading...<br>';
                    filesToFetch.push(file);
                }
            }

            // Update progress for downloads
            let processed = 0;
            const total = FILES_TO_DOWNLOAD.length;

            // 3. Download missing
            if (filesToFetch.length > 0) {
                for(const file of filesToFetch) {
                    await downloadAndSave(file);
                    processed++;
                    bar.style.width = Math.floor((processed / total) * 80) + '%';
                }
            }

            log.innerHTML += '> Loading AI Model into Memory...<br>';
            
            // 4. Load Config
            const configBuffer = await loadFileToMemory("config.json");
            // const config = JSON.parse(new TextDecoder().decode(configBuffer)); // Not strictly needed if using pipeline

            // 5. Load GGUF
            const ggufBuffer = await loadFileToMemory("Qwen2.5-1.5B-Instruct.Q4_K_M.gguf");
            const modelBlob = new Blob([ggufBuffer], { type: 'application/octet-stream' });
            const modelUrl = URL.createObjectURL(modelBlob);

            // 6. Initialize Pipeline
            env.useBrowserCache = false; 
            env.allowLocalModels = false;

            this.generator = await pipeline('text-generation', modelUrl, {
                quantized: true,
                dtype: 'q4',
            });

            bar.style.width = '100%';
            this.isReady = true;
            overlay.classList.remove('active');
            document.body.style.overflow = '';
            ui.updateStatus(true);
            ui.addMessage('ai', '<strong>AI Engine Online.</strong> Running locally from eor_storage.');

        } catch (error) {
            console.error(error);
            log.innerHTML += '<div style="color:red; padding:5px;">> ERROR: ' + error.message + '</div><br>';
            document.body.style.overflow = '';
            alert("Error: " + error.message);
        }
    },

    generate: async function(text, mode) {
        if (!this.generator) return;

        try {
            // Small timeout to allow UI to update "Thinking..." before freezing
            await new Promise(r => setTimeout(r, 50));

            const output = await this.generator(text, {
                max_new_tokens: 150,
                do_sample: true,
                temperature: 0.7,
                top_k: 50,
                return_full_text: false
            });

            const generatedText = output[0].generated_text;
            app.handleStream(generatedText);
            app.handleResponse(generatedText, mode);

        } catch (err) {
            console.error(err);
            ui.addMessage('ai', "Error: " + err.message);
        }
    },

    addToHistory: function(role, content) {
        this.history.push({ role, content });
        if(this.history.length > 20) this.history = this.history.slice(this.history.length - 20);
    }
};

// 3. UI CONTROLLER
const ui = {
    dom: {
        list: document.getElementById('chat-list'),
        viewport: document.getElementById('chat-viewport'),
        input: document.getElementById('msg-input'),
        btn: document.getElementById('send-btn'),
        dot: document.getElementById('status-dot'),
        text: document.getElementById('status-text'),
        sidebar: document.getElementById('sidebar'),
        backdrop: document.getElementById('mobile-backdrop'),
        menuBtn: document.getElementById('menu-btn'),
        menuIcon: document.getElementById('menu-icon')
    },

    updateStatus: function(isReady) {
        const dot = this.dom.dot;
        const text = this.dom.text;
        const btn = this.dom.btn;

        dot.className = 'status-dot';
        text.style.color = "";

        if (isReady) {
            dot.classList.add('online');
            text.innerText = "AI Ready";
            text.style.color = "#10b981";
            btn.disabled = false;
        } else {
            dot.classList.add('error'); 
            text.innerText = "Offline";
            text.style.color = "#ef4444";
            btn.disabled = false;
        }
    },

    toggleMobileMenu: function() {
        if(!this.dom.sidebar) return;
        const isOpen = this.dom.sidebar.classList.contains('open');
        if (isOpen) this.closeMobileMenu();
        else {
            this.dom.sidebar.classList.add('open');
            this.dom.backdrop.classList.add('open');
            if(this.dom.menuIcon) {
                this.dom.menuIcon.classList.remove('fa-bars');
                this.dom.menuIcon.classList.add('fa-xmark');
            }
        }
    },

    closeMobileMenu: function() {
        if(!this.dom.sidebar) return;
        this.dom.sidebar.classList.remove('open');
        this.dom.backdrop.classList.remove('open');
        if(this.dom.menuIcon) {
            this.dom.menuIcon.classList.remove('fa-xmark');
            this.dom.menuIcon.classList.add('fa-bars');
        }
    },

    resize: function(el) {
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
    },

    detectCode: function(el) {
        if (el.value.includes('def ') || el.value.includes('function') || el.value.includes('{') || el.value.includes('import ')) {
            el.classList.add('code-font');
        } else {
            el.classList.remove('code-font');
        }
    },

    scrollToBottom: function() {
        this.dom.viewport.scrollTop = this.dom.viewport.scrollHeight;
    },

    addMessage: function(role, html, isLoading) {
        const row = document.createElement('div');
        row.className = 'message-row' + (role === 'user' ? ' user' : '');
        
        let content = '';
        if (role === 'user') {
            content = '<div class="avatar"><i class="fa-solid fa-user"></i></div><div class="message-content user-bubble">' + html + '</div>';
        } else {
            if (isLoading) {
                content = '<div class="message-content ai-text"><div class="typing-dots"></div></div>';
            } else {
                content = '<div class="message-content ai-text">' + html + '</div>';
            }
        }
        
        row.innerHTML = content;
        this.dom.list.appendChild(row);
        this.scrollToBottom();
        return row.querySelector('.message-content');
    }
};

// 4. APP OBJECT
const app = {
    handleEnter(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.send();
        }
    },

    reset: function() {
        ui.dom.list.innerHTML = '';
        engine.history = []; 
        ui.addMessage('ai', "System reset.");
    },

    send: async function() {
        if (!engine.isReady) {
            const confirmInit = confirm("AI Offline. Load Model?");
            if(confirmInit) engine.init();
            return;
        }

        const text = ui.dom.input.value.trim();
        if (!text) return;

        ui.dom.input.value = '';
        ui.dom.input.classList.remove('code-font');
        ui.dom.input.style.height = 'auto';
        
        ui.addMessage('user', text.replace(/\n/g, '<br>'));
        engine.addToHistory('user', text);

        ui.dom.btn.disabled = true;
        ui.addMessage('ai', '', true);
        
        await engine.generate(text, 'chat');
    },

    assist: async function(mode) {
        if (!engine.isReady) { 
            const confirmInit = confirm("AI Offline. Load Model?");
            if(confirmInit) engine.init();
            return; 
        }
        
        const text = ui.dom.input.value.trim();
        if (!text) return;

        const originalPlaceholder = ui.dom.input.placeholder;
        ui.dom.input.placeholder = "Processing...";
        ui.dom.input.disabled = true;

        await engine.generate(text, mode);

        this.currentAssistMode = mode;
        this.originalInput = text;
        this.originalPlaceholder = originalPlaceholder;
    },

    handleStream: function(text) {
        const messages = document.querySelectorAll('.ai-text');
        const lastMsg = messages[messages.length - 1];
        if(lastMsg) {
            if(lastMsg.querySelector('.typing-dots')) {
                lastMsg.innerHTML = '';
            }
            lastMsg.innerHTML = text.replace(/\n/g, '<br>');
            ui.scrollToBottom();
        }
    },

    handleResponse: function(data, mode) {
        ui.dom.btn.disabled = false;
        ui.dom.input.focus();
        
        if (mode !== 'chat') {
            let cleanData = data.replace(/```[\w]*\n?/g, '').replace(/```/g, '');
            ui.dom.input.value = cleanData;
            ui.dom.input.disabled = false;
            ui.dom.input.placeholder = "Type anything here...";
            ui.resize(ui.dom.input); 
            ui.detectCode(ui.dom.input);
        }
    }
};

// CRITICAL: Attach to window for buttons
window.engine = engine;
window.app = app;
window.ui = ui;

ui.updateStatus(false);
console.log("System Boot. Objects attached to Window.");
