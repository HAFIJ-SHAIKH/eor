console.log("Script Loaded. OPFS System Ready.");

// 1. WORKER FUNCTION (OPFS STORAGE + PARALLEL DOWNLOADS)
function workerScript() {
    const HF_USERNAME = "eorchat";
    const REPO_NAME = "eor";
    const HF_BASE_URL = "https://huggingface.co/" + HF_USERNAME + "/" + REPO_NAME + "/resolve/main/";
    
    // The folder name in the browser's internal storage
    const STORAGE_FOLDER = "eor_storage";
    
    const FILES_TO_DOWNLOAD = [
        "Qwen2.5-1.5B-Instruct.Q4_K_M.gguf",
        "adapter_config.json",
        "adapter_model.safetensors",
        "tokenizer_config.json",
        "tokenizer.json",
        "config.json",
        "chat_template.jinja"
    ];

    let modelBuffers = {}; 
    let completedCount = 0;
    let totalFiles = FILES_TO_DOWNLOAD.length;

    // Helper: Access or Create the Folder
    async function getStorageDir() {
        const root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle(STORAGE_FOLDER, { create: true });
    }

    function formatBytes(bytes, decimals) {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    // Check if file exists locally
    async function fileExists(filename) {
        try {
            const dir = await getStorageDir();
            await dir.getFileHandle(filename);
            return true;
        } catch (e) {
            return false;
        }
    }

    // Read file from OPFS into Memory
    async function loadFileToMemory(filename) {
        try {
            const dir = await getStorageDir();
            const handle = await dir.getFileHandle(filename);
            const file = await handle.getFile();
            const buffer = await file.arrayBuffer();
            modelBuffers[filename] = new Uint8Array(buffer);
            self.postMessage({ status: 'file_loaded', data: { name: filename, size: formatBytes(file.size) }});
        } catch (e) {
            console.error("Failed to load file from storage", e);
            throw e;
        }
    }

    // Download and Save to OPFS
    async function downloadAndSave(filename) {
        const url = HF_BASE_URL + filename;
        
        self.postMessage({ status: 'initiate', data: { name: filename } });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 600000); 

        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) throw new Error("HTTP " + response.status);

            const reader = response.body.getReader();
            const chunks = [];
            let loaded = 0;

            while(true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                loaded += value.length;
            }

            // 1. Combine chunks
            const buffer = new Uint8Array(loaded);
            let position = 0;
            for(const chunk of chunks) {
                buffer.set(chunk, position);
                position += chunk.length;
            }

            // 2. Save to OPFS Folder
            const dir = await getStorageDir();
            const fileHandle = await dir.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(buffer);
            await writable.close();

            // 3. Load into Memory
            modelBuffers[filename] = buffer;

            self.postMessage({ 
                status: 'file_complete', 
                data: { name: filename, size: formatBytes(loaded) } 
            });

        } catch (err) {
            clearTimeout(timeoutId);
            let msg = err.message;
            if (err.name === 'AbortError') msg = "Download Timeout.";
            self.postMessage({ status: 'error', data: "Failed: " + filename + " - " + msg });
            throw err; 
        }
    }

    self.onmessage = async (e) => {
        if (e.data.type === 'load') {
            try {
                self.postMessage({ status: 'log', data: "Checking local storage folder: " + STORAGE_FOLDER });
                
                // Strategy: Check all files first
                const filesToFetch = [];
                
                for (const file of FILES_TO_DOWNLOAD) {
                    const exists = await fileExists(file);
                    if (exists) {
                        self.postMessage({ status: 'log', data: "Found locally: " + file });
                        await loadFileToMemory(file);
                        completedCount++;
                        // Update progress
                        self.postMessage({ status: 'progress', progress: Math.floor((completedCount / totalFiles) * 100) });
                    } else {
                        self.postMessage({ status: 'log', data: "Missing from storage: " + file + ". Will download." });
                        filesToFetch.push(file);
                    }
                }

                // Download missing files in parallel
                if (filesToFetch.length > 0) {
                    self.postMessage({ status: 'log', data: `Downloading ${filesToFetch.length} missing files...` });
                    const promises = filesToFetch.map(f => downloadAndSave(f));
                    await Promise.all(promises);
                }

                self.postMessage({ status: 'ready', count: totalFiles });

            } catch (error) {
                self.postMessage({ status: 'log', data: "System Error: " + error.message });
                self.postMessage({ status: 'error', data: error.message });
            }
        } 
        else if (e.data.type === 'generate') {
            // --- SYSTEM SIMULATION ---
            // In a real app, you would use modelBuffers["Qwen..."] with llama.cpp here.
            const input = e.data.text || "";
            
            let responseText = "> Processing Input...\n";
            responseText += "> Tokens: " + input.length + "\n";
            responseText += "> Context: User Session Active\n";
            responseText += "> Output: " + input + "\n\n";
            responseText += "[SYSTEM]: Inference module initialized. The model files (" + Object.keys(modelBuffers).length + ") are loaded in memory. \n";
            responseText += "[SYSTEM]: To enable actual AI reasoning, the WebAssembly binary (llama_cpp.wasm) must be linked. Currently running in Echo Mode.";

            const tokens = responseText.split(' ');
            let currentText = "";
            
            for (let i = 0; i < tokens.length; i++) {
                currentText += tokens[i] + " ";
                self.postMessage({ status: 'streaming', data: currentText, mode: e.data.mode });
                await new Promise(r => setTimeout(r, 30)); // Fast typing
            }
            
            self.postMessage({ status: 'complete', data: currentText, mode: e.data.mode });
        }
    };
}

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

        if(!log || !bar || !overlay) {
            alert("ERROR: Cannot find DOM elements");
            return;
        }
        
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
        log.innerHTML = '> Initializing OPFS Storage...';
        bar.style.width = '0%';

        try {
            const blob = new Blob(['(' + workerScript.toString() + ')()'], { type: 'text/javascript' });
            this.worker = new Worker(URL.createObjectURL(blob));
        } catch (e) {
            alert("Error creating Worker: " + e.message);
            return;
        }

        this.worker.onerror = (e) => {
            log.innerHTML += '<span style="color:red">> Worker Error</span><br>';
        };

        this.worker.onmessage = (e) => {
            const { status, data, progress } = e.data;

            if (status === 'log') {
                log.innerHTML += '> ' + data + '<br>';
            }
            else if (status === 'initiate') {
                log.innerHTML += '> Fetching: ' + data.name + '<br>';
            }
            else if (status === 'file_loaded') {
                // File found locally
                log.innerHTML += '<span style="color:blue">> Loaded from Storage: ' + data.name + ' (' + data.size + ')</span><br>';
            }
            else if (status === 'file_complete') {
                // File downloaded and saved
                log.innerHTML += '> Saved to Storage: ' + data.name + ' (' + data.size + ')<br>';
            }
            else if (status === 'progress') {
                bar.style.width = progress + '%';
            }
            else if (status === 'ready') {
                this.isReady = true;
                overlay.classList.remove('active');
                document.body.style.overflow = '';
                ui.updateStatus(true);
                ui.addMessage('ai', '<strong>System Online.</strong> ' + data.count + ' files loaded from local storage.');
            }
            else if (status === 'error') {
                log.innerHTML += '<div style="color:red; padding:5px;">> ERROR: ' + data + '</div><br>';
                document.body.style.overflow = '';
            }
            else if (status === 'streaming') {
                app.handleStream(data);
            }
            else if (status === 'complete') {
                // Done
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

    send: function() {
        if (!engine.isReady) {
            const confirmInit = confirm("System Offline. Initialize Storage Engine?");
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
            const confirmInit = confirm("System Offline. Initialize Storage Engine?");
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
            // Preserve newlines
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
