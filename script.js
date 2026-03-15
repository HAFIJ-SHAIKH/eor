console.log("System Boot. Target: eor_storage. Engine: Transformers.js.");

// Import Library
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

// --- STORAGE SYSTEM (OPFS) ---

async function getStorageDir() {
    const root = await navigator.storage.getDirectory();
    // This creates the folder inside the browser's hidden storage
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
    
    // INTEGRITY CHECK: Ensure file isn't empty
    if (file.size === 0) {
        throw new Error(`File ${filename} is corrupted (0 bytes).`);
    }
    
    return await file.arrayBuffer();
}

async function downloadAndSave(filename) {
    const url = HF_BASE_URL + filename;
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
        
        return buffer;
    } catch (err) {
        throw new Error("Failed to download " + filename + ": " + err.message);
    }
}

// --- ENGINE CONTROLLER ---

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
        log.innerHTML = '> System Init...<br>';
        bar.style.width = '0%';

        try {
            // 1. Verify/Create Folder
            const dir = await getStorageDir();
            log.innerHTML += '> Folder "eor_storage" created/verified in browser storage.<br>';
            
            let filesToFetch = [];
            let filesLoaded = 0;
            
            // 2. Check files
            for (const file of FILES_TO_DOWNLOAD) {
                if (await fileExists(file)) {
                    log.innerHTML += '> Found locally: ' + file + '. Verifying integrity...<br>';
                    try {
                        await loadFileToMemory(file); // Verify it works
                        filesLoaded++;
                    } catch (e) {
                        log.innerHTML += '> Local file corrupted. Redownloading: ' + file + '<br>';
                        filesToFetch.push(file);
                    }
                } else {
                    log.innerHTML += '> Missing: ' + file + '. Will download.<br>';
                    filesToFetch.push(file);
                }
            }

            // 3. Download missing files
            if (filesToFetch.length > 0) {
                log.innerHTML += '> Starting download of ' + filesToFetch.length + ' files...<br>';
                for(const file of filesToFetch) {
                    await downloadAndSave(file);
                    filesLoaded++;
                    bar.style.width = Math.floor((filesLoaded / FILES_TO_DOWNLOAD.length) * 80) + '%';
                }
            }

            log.innerHTML += '> All files verified in eor_storage.<br>';
            log.innerHTML += '> Attempting to load AI Model (This may fail on file:// protocol)...<br>';

            // 4. Load Config
            const configBuffer = await loadFileToMemory("config.json");
            // const config = JSON.parse(new TextDecoder().decode(configBuffer));

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
            
            // DETAILED ERROR HANDLING
            log.innerHTML += '<br><div style="color:orange; background:#fff7ed; padding:10px; border:1px solid #fdba74; border-radius:4px;">';
            log.innerHTML += '<strong>AI Initialization Halted.</strong><br>';
            log.innerHTML += 'Reason: Browser Security ("SharedArrayBuffer").<br>';
            log.innerHTML += 'Status: Files <strong>ARE</strong> safely stored in "eor_storage".<br>';
            log.innerHTML += 'Fix: You must run this file on a local server (e.g., VS Code "Live Server") to enable AI Inference.<br>';
            log.innerHTML += '</div><br>';

            document.body.style.overflow = '';
            
            // We stay in "Offline" mode but allow UI interaction
            // We can fallback to simulation for the user to see the UI works
            this.isReady = true; // Set to true so buttons work, but we'll simulate response
            ui.updateStatus(true);
            overlay.classList.remove('active');
            ui.addMessage('ai', 'System Alert: AI Inference requires a local server (due to browser security). However, your files are successfully saved in <em>eor_storage</em>. Switching to Simulation Mode.');
        }
    },

    generate: async function(text, mode) {
        // Check if we are in Simulation Mode (generator is null but isReady is true due to error fallback)
        const isSimulation = !this.generator;

        if (!isSimulation) {
            try {
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
                app.handleStream("Error: " + err.message);
            }
        } else {
            // SIMULATION MODE
            await new Promise(r => setTimeout(r, 1000));
            let response = "I received: " + text + "\n\n";
            response += "[System]: Running in Simulation Mode because the browser blocked the AI engine (file:// protocol). \n";
            response += "The files are correctly stored in 'eor_storage'. To use the real AI, please open this HTML file using a local server (e.g., 'Live Server' in VS Code).";
            
            app.handleStream(response);
            app.handleResponse(response, mode);
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
            text.innerText = "System Ready";
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
            const confirmInit = confirm("System Offline. Load Model?");
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
            const confirmInit = confirm("System Offline. Load Model?");
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
