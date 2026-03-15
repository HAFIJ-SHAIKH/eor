/**
 * WORKER SOURCE CODE
 * This string contains the code that runs in the Web Worker.
 * It handles fetching files from Hugging Face and managing the download progress.
 */
const WORKER_CODE = `
    // CONFIGURATION
    const HF_USERNAME = "eorchat";
    const REPO_NAME = "eor";
    const HF_BASE_URL = "https://huggingface.co/" + HF_USERNAME + "/" + REPO_NAME + "/resolve/main/";
    
    // IMPORTANT: List the exact filenames you need to download here.
    // If your file is named 'Q4_K_M.gguf' instead of 'model.gguf', change it here.
    const FILES_TO_DOWNLOAD = [
        "model.gguf", 
        // "tokenizer.json", // Add other files if needed
        // "preprocessor_config.json"
    ];

    // STORAGE (In-memory for this session)
    let modelBuffers = {}; 

    // Helper: Format bytes
    function formatBytes(bytes, decimals = 2) {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return \`\${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} \${sizes[i]}\`;
    }

    // Main Download Function
    async function downloadFile(filename) {
        const url = HF_BASE_URL + filename;
        
        self.postMessage({ status: 'initiate', data: { name: filename } });

        try {
            const response = await fetch(url);
            
            if (!response.ok) {
                throw new Error(\`HTTP \${response.status} for \${filename}\`);
            }

            const contentLength = response.headers.get('Content-Length');
            const total = parseInt(contentLength, 10);
            let loaded = 0;

            const reader = response.body.getReader();
            const chunks = [];

            while(true) {
                const { done, value } = await reader.read();
                
                if (done) break;

                chunks.push(value);
                loaded += value.length;

                if (total) {
                    const percent = Math.round((loaded / total) * 100);
                    self.postMessage({ 
                        status: 'progress', 
                        progress: percent, 
                        filename: filename 
                    });
                } else {
                    // Fallback if Content-Length is missing (Chunked transfer)
                    self.postMessage({ 
                        status: 'progress', 
                        progress: -1, // -1 indicates indeterminate
                        filename: filename 
                    });
                }
            }

            // Combine chunks into a single buffer
            const buffer = new Uint8Array(loaded);
            let position = 0;
            for(const chunk of chunks) {
                buffer.set(chunk, position);
                position += chunk.length;
            }

            modelBuffers[filename] = buffer;
            self.postMessage({ status: 'file_complete', data: { name: filename, size: formatBytes(loaded) }});

        } catch (err) {
            self.postMessage({ status: 'error', data: \`Failed to download \${filename}: \${err.message}\` });
            throw err; // Stop execution
        }
    }

    // Worker Message Handler
    self.onmessage = async (e) => {
        if (e.data.type === 'load') {
            try {
                for (const file of FILES_TO_DOWNLOAD) {
                    await downloadFile(file);
                }
                
                // All files downloaded successfully
                self.postMessage({ status: 'ready', count: FILES_TO_DOWNLOAD.length });
                
                // TODO: Initialize the actual GGUF inference engine here using modelBuffers
                // e.g., await createGGUFModule(modelBuffers['model.gguf']);

            } catch (error) {
                // Error already posted in downloadFile
            }
        } 
        else if (e.data.type === 'generate') {
            // TODO: Handle generation logic here
            // For now, simulating a response since we don't have the actual WASM runner
            setTimeout(() => {
                self.postMessage({ 
                    status: 'complete', 
                    data: "Model files loaded in memory. (Note: Actual inference logic requires GGUF/WASM bindings).", 
                    mode: e.data.mode 
                });
            }, 1000);
        }
    };
`;

/**
 * MAIN THREAD CONTROLLERS
 */

const engine = {
    worker: null,
    isReady: false,
    history: [],

    init: function() {
        if (this.isReady) return;
        
        const log = document.getElementById('loader-log');
        const bar = document.getElementById('progress-bar');
        const overlay = document.getElementById('loader-overlay');
        
        overlay.classList.add('active');
        log.innerHTML = '> Connecting to Hugging Face...';
        bar.style.width = '0%';

        // Create Worker from the string constant above
        const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
        this.worker = new Worker(URL.createObjectURL(blob));

        this.worker.onmessage = (e) => {
            const { status, data, progress, filename, count } = e.data;

            if (status === 'initiate') {
                log.innerHTML += \`> Starting download: \${data.name}<br>\`;
                log.scrollTop = log.scrollHeight;
            }
            else if (status === 'progress') {
                if (progress !== -1) {
                    bar.style.width = \`\${progress}%\`;
                } else {
                    // Indeterminate state animation could go here
                }
            }
            else if (status === 'file_complete') {
                log.innerHTML += \`> Downloaded \${data.name} (\${data.size})<br>\`;
                log.scrollTop = log.scrollHeight;
            }
            else if (status === 'ready') {
                this.isReady = true;
                overlay.classList.remove('active');
                ui.updateStatus(true);
                ui.addMessage('ai', \`System loaded. <strong>\${count}</strong> file(s) downloaded from Hugging Face.\`);
            }
            else if (status === 'error') {
                this.isReady = false;
                log.innerHTML += \`<span style="color:red">> ERROR: \${data}</span><br>\`;
                ui.updateStatus(false);
                alert("Download failed: " + data);
            }
            else if (status === 'complete') {
                app.handleResponse(data, e.data.mode);
            }
        };

        // Start the download process
        this.worker.postMessage({ type: 'load' });
    },

    generate: function(text, mode = 'chat') {
        if (!this.worker) return;
        this.worker.postMessage({ type: 'generate', text: text, history: this.history, mode: mode });
    },

    addToHistory: function(role, content) {
        this.history.push({ role, content });
        if(this.history.length > 20) this.history = this.history.slice(this.history.length - 20);
    }
};

/**
 * UI CONTROLLER
 */
const ui = {
    dom: {
        list: document.getElementById('chat-list'),
        viewport: document.getElementById('chat-viewport'),
        input: document.getElementById('msg-input'),
        btn: document.getElementById('send-btn'),
        dot: document.getElementById('status-dot'),
        text: document.getElementById('status-text')
    },

    updateStatus: function(isReady) {
        const dot = this.dom.dot;
        const text = this.dom.text;
        const btn = this.dom.btn;

        dot.className = 'status-dot';
        text.style.color = "";

        if (isReady) {
            dot.classList.add('online');
            text.innerText = "Model Ready";
            text.style.color = "#10b981";
            btn.disabled = false;
        } else {
            dot.classList.add('error'); 
            text.innerText = "Model Offline";
            text.style.color = "#ef4444";
            btn.disabled = false;
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

    addMessage: function(role, html, isLoading = false) {
        const row = document.createElement('div');
        row.className = \`message-row\`;
        
        let content = '';
        if (role === 'user') {
            content = \`
                <div class="avatar"><i class="fa-solid fa-user"></i></div>
                <div class="message-content user-bubble">\${html}</div>
            \`;
        } else {
            if (isLoading) {
                content = \`
                    <div class="avatar"><i class="fa-solid fa-robot"></i></div>
                    <div class="message-content ai-text">
                        <div class="typing-dots"></div>
                    </div>
                \`;
            } else {
                content = \`
                    <div class="avatar"><i class="fa-solid fa-robot"></i></div>
                    <div class="message-content ai-text">\${html}</div>
                \`;
            }
        }
        
        row.innerHTML = content;
        this.dom.list.appendChild(row);
        this.scrollToBottom();
        return row.querySelector('.message-content');
    }
};

/**
 * APP LOGIC
 */
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
        ui.addMessage('ai', "Session cleared.");
    },

    send: function() {
        if (!engine.isReady) {
            alert("Please wait for the model to load. Click 'Model Offline' in the sidebar to start the download.");
            engine.init(); 
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
            alert("Please load the model first (click sidebar status)."); 
            engine.init();
            return; 
        }
        
        const text = ui.dom.input.value.trim();
        if (!text) return;

        const originalPlaceholder = ui.dom.input.placeholder;
        ui.dom.input.placeholder = "AI is enhancing...";
        ui.dom.input.disabled = true;

        engine.generate(text, mode);

        this.currentAssistMode = mode;
        this.originalInput = text;
        this.originalPlaceholder = originalPlaceholder;
    },

    handleResponse: function(data, mode) {
        let cleanData = data; 

        if (mode === 'chat') {
            const messages = document.querySelectorAll('.ai-text');
            const lastMsg = messages[messages.length - 1];
            lastMsg.innerHTML = cleanData.replace(/\n/g, '<br>');
            
            engine.addToHistory('assistant', cleanData);
            
            ui.dom.btn.disabled = false;
            ui.dom.input.focus();
        } 
        else {
            // UNIVERSAL/ASSIST MODE (In-Place Update)
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

// Initialize
window.onload = () => ui.updateStatus(false);
