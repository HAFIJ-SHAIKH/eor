console.log("System Boot. Target: eor_storage. Engine: Transformers.js (GGUF).");

// 1. WORKER MODULE CODE (REAL INFERENCE)
// Note: We import the library from the CDN inside the worker string
const workerCode = `
import { pipeline, env, RawImage } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1';

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
    // Adapter files are tricky in basic Transformers.js pipeline, we focus on base model first
];

let generator = null;
let completedCount = 0;

// --- STORAGE SYSTEM ---

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
    const buffer = await file.arrayBuffer();
    self.postMessage({ 
        status: 'file_loaded', 
        data: { name: filename, size: formatBytes(file.size) } 
    });
    return buffer;
}

async function downloadAndSave(filename) {
    const url = HF_BASE_URL + filename;
    self.postMessage({ status: 'initiate', data: { name: filename } });

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("HTTP " + response.status);
        
        const buffer = await response.arrayBuffer();
        
        // Save to eor_storage
        const dir = await getStorageDir();
        const handle = await dir.getFileHandle(filename, { create: true });
        const writable = await handle.createWritable();
        await writable.write(buffer);
        await writable.close();
        
        self.postMessage({ status: 'file_complete', data: { name: filename, size: formatBytes(buffer.byteLength) }});
        return buffer;
    } catch (err) {
        self.postMessage({ status: 'error', data: "Failed: " + filename + " - " + err.message });
        throw err;
    }
}

// --- REAL AI INITIALIZATION ---

async function initializeAI() {
    try {
        self.postMessage({ status: 'log', data: "Loading AI Model from Storage..." });

        // 1. Load Config
        const configBuffer = await loadFileToMemory("config.json");
        const config = JSON.parse(new TextDecoder().decode(configBuffer));

        // 2. Load GGUF Model File
        // Transformers.js can take a URL, so we create a Blob URL from our local file
        const ggufBuffer = await loadFileToMemory("Qwen2.5-1.5B-Instruct.Q4_K_M.gguf");
        const modelBlob = new Blob([ggufBuffer], { type: 'application/octet-stream' });
        const modelUrl = URL.createObjectURL(modelBlob);

        // 3. Initialize Pipeline
        // We use 'text-generation' and point it to our local blob URL
        // NOTE: For a perfect match, the tokenizer files must be compatible.
        // If tokenizer.json fails, Transformers.js falls back to a default if config is correct.
        
        generator = await pipeline('text-generation', modelUrl, {
            quantized: true,
            dtype: 'q4', // Ensure we tell it it's quantized
            progress_callback: (data) => {
                // Pipeline internal loading progress
                if(data.status === 'progress') {
                     // Could map this to main progress bar if detailed
                }
            }
        });

        self.postMessage({ status: 'ready', count: FILES_TO_DOWNLOAD.length });
        
    } catch (error) {
        console.error(error);
        self.postMessage({ status: 'error', data: "AI Init Error: " + error.message + ". Check model compatibility." });
    }
}

// --- MAIN LOOP ---

self.onmessage = async (e) => {
    if (e.data.type === 'load') {
        try {
            self.postMessage({ status: 'log', data: "Checking eor_storage folder..." });
            
            const filesToFetch = [];
            // Strategy: Check files, download missing
            for (const file of FILES_TO_DOWNLOAD) {
                if (await fileExists(file)) {
                    await loadFileToMemory(file); // Just for reporting
                    completedCount++;
                } else {
                    filesToFetch.push(file);
                }
            }

            if (filesToFetch.length > 0) {
                self.postMessage({ status: 'log', data: "Downloading missing files..." });
                const promises = filesToFetch.map(f => downloadAndSave(f));
                await Promise.all(promises);
            }

            // Now initialize the AI
            await initializeAI();

        } catch (err) {
            self.postMessage({ status: 'error', data: err.message });
        }
    } 
    else if (e.data.type === 'generate') {
        if (!generator) return;

        try {
            const text = e.data.text;
            // Run actual generation
            const output = await generator(text, {
                max_new_tokens: 128,
                do_sample: true,
                temperature: 0.7,
                top_k: 50,
                return_full_text: false // Don't repeat the prompt
            });

            const generatedText = output[0].generated_text;
            
            // Stream the result to main thread
            self.postMessage({ status: 'streaming', data: generatedText });
            self.postMessage({ status: 'complete', data: generatedText });

        } catch (err) {
            self.postMessage({ status: 'error', data: "Inference Error: " + err.message });
        }
    }
};
`;

// 2. ENGINE CONTROLLER
const engine = {
    worker: null,
    isReady: false,
    history: [],

    init: function() {
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
            // CRITICAL: type: 'module' is required for imports to work
            const blob = new Blob([workerCode], { type: 'text/javascript' });
            this.worker = new Worker(URL.createObjectURL(blob), { type: 'module' });
        } catch (e) {
            alert("Error creating Module Worker: " + e.message);
            return;
        }

        this.worker.onerror = (e) => {
            log.innerHTML += '<span style="color:red">> Worker Error</span><br>';
        };

        let filesTotal = 4; // GGUF, Config, Tokenizer, Tokenizer_Config
        let filesProcessed = 0;

        this.worker.onmessage = (e) => {
            const { status, data, progress } = e.data;

            if (status === 'log') {
                log.innerHTML += '> ' + data + '<br>';
            }
            else if (status === 'initiate') {
                log.innerHTML += '> Fetching: ' + data.name + '<br>';
            }
            else if (status === 'file_loaded') {
                log.innerHTML += '<span style="color:green">> Loaded from eor_storage: ' + data.name + '</span><br>';
                filesProcessed++;
                bar.style.width = Math.floor((filesProcessed / filesTotal) * 50) + '%'; // First 50% is loading
            }
            else if (status === 'file_complete') {
                log.innerHTML += '> Saved to eor_storage: ' + data.name + '<br>';
                filesProcessed++;
                bar.style.width = Math.floor((filesProcessed / filesTotal) * 50) + '%';
            }
            else if (status === 'ready') {
                this.isReady = true;
                bar.style.width = '100%';
                overlay.classList.remove('active');
                document.body.style.overflow = '';
                ui.updateStatus(true);
                ui.addMessage('ai', '<strong>AI Engine Online.</strong> Running locally from eor_storage.');
            }
            else if (status === 'error') {
                log.innerHTML += '<div style="color:red; padding:5px;">> ERROR: ' + data + '</div><br>';
                document.body.style.overflow = '';
            }
            else if (status === 'streaming') {
                app.handleStream(data);
            }
            else if (status === 'complete') {
                // Finalize
            }
            
            log.scrollTop = log.scrollHeight;
        };

        this.worker.postMessage({ type: 'load' });
    },

    generate: function(text, mode) {
        if (!this.worker) return;
        this.worker.postMessage({ type: 'generate', text: text, history: this.history, mode: mode });
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

    send: function() {
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
        
        engine.generate(text, 'chat');
    },

    assist: function(mode) {
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

        engine.generate(text, mode);

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
        let cleanData = data; 
        if (mode !== 'chat') {
            cleanData = cleanData.replace(/```[\w]*\n?/g, '').replace(/```/g, '');
            ui.dom.input.value = cleanData;
            ui.dom.input.disabled = false;
            ui.dom.input.placeholder = "Type anything here...";
            ui.dom.input.focus();
            ui.resize(ui.dom.input); 
            ui.detectCode(ui.dom.input);
        }
    }
};

window.onload = function() {
    console.log("System Boot.");
    window.engine = engine;
    window.app = app;
    window.ui = ui;
    ui.updateStatus(false);
};
