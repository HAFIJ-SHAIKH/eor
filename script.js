/**
 * WORKER SOURCE CODE
 */
const WORKER_CODE = `
    // CONFIGURATION
    const HF_USERNAME = "eorchat";
    const REPO_NAME = "eor";
    const HF_BASE_URL = "https://huggingface.co/" + HF_USERNAME + "/" + REPO_NAME + "/resolve/main/";
    
    // UPDATED: Exact file list provided
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
    let totalFiles = FILES_TO_DOWNLOAD.length;
    let completedFiles = 0;

    function formatBytes(bytes, decimals = 2) {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return \`\${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} \${sizes[i]}\`;
    }

    async function downloadFile(filename) {
        const url = HF_BASE_URL + filename;
        
        self.postMessage({ status: 'initiate', data: { name: filename } });

        try {
            const response = await fetch(url);
            
            if (!response.ok) {
                throw new Error(\`HTTP \${response.status}\`);
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

                // Calculate overall progress roughly based on individual file progress
                // This is a simplification; for perfect accuracy we'd need total size of all files upfront
                if (total) {
                    const percent = Math.round((loaded / total) * 100);
                    self.postMessage({ status: 'progress', progress: percent, filename: filename });
                } else {
                    self.postMessage({ status: 'progress', progress: -1, filename: filename });
                }
            }

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
            throw err; 
        }
    }

    self.onmessage = async (e) => {
        if (e.data.type === 'load') {
            try {
                self.postMessage({ status: 'log', data: \`Starting download of \${totalFiles} files...\` });
                
                for (const file of FILES_TO_DOWNLOAD) {
                    await downloadFile(file);
                    completedFiles++;
                }
                
                self.postMessage({ status: 'ready', count: completedFiles });
                
            } catch (error) {
                self.postMessage({ status: 'log', data: "Download sequence failed or incomplete." });
            }
        } 
        else if (e.data.type === 'generate') {
            // Placeholder for actual inference
            setTimeout(() => {
                self.postMessage({ 
                    status: 'complete', 
                    data: "Inference logic placeholder. Files are loaded in memory (modelBuffers).", 
                    mode: e.data.mode 
                });
            }, 500);
        }
    };
`;

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
            console.error("Loader DOM elements not found!");
            return;
        }
        
        overlay.classList.add('active');
        log.innerHTML = '> Initializing...';
        bar.style.width = '0%';

        try {
            const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
            this.worker = new Worker(URL.createObjectURL(blob));
        } catch (e) {
            console.error("Worker creation failed", e);
            return;
        }

        this.worker.onerror = (e) => {
            log.innerHTML += \`<span style="color:red">> Worker Error: \${e.message}</span><br>\`;
        };

        this.worker.onmessage = (e) => {
            const { status, data, progress, filename, count } = e.data;

            if (status === 'log') {
                log.innerHTML += \`> \${data}<br>\`;
                log.scrollTop = log.scrollHeight;
            }
            else if (status === 'initiate') {
                log.innerHTML += \`> Fetching: \${data.name}<br>\`;
                log.scrollTop = log.scrollHeight;
            }
            else if (status === 'progress') {
                if (progress !== -1) {
                    bar.style.width = \`\${progress}%\`;
                }
            }
            else if (status === 'file_complete') {
                log.innerHTML += \`> Downloaded: \${data.name} (\${data.size})<br>\`;
                log.scrollTop = log.scrollHeight;
            }
            else if (status === 'ready') {
                this.isReady = true;
                overlay.classList.remove('active');
                ui.updateStatus(true);
                ui.addMessage('ai', \`Engine Ready. <strong>\${count}</strong> files loaded into memory.\`);
            }
            else if (status === 'error') {
                log.innerHTML += \`<div style="color:red; padding:4px; border:1px solid red; margin:4px 0;">> ERROR: \${data}</div><br>\`;
                log.scrollTop = log.scrollHeight;
            }
            else if (status === 'complete') {
                app.handleResponse(data, e.data.mode);
            }
        };

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
            const confirmInit = confirm("Model is not loaded. Start download now?");
            if(confirmInit) {
                engine.init();
            }
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
            const confirmInit = confirm("Model is not loaded. Start download now?");
            if(confirmInit) {
                engine.init();
            }
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
window.onload = () => {
    ui.updateStatus(false);
    
    // Expose to window
    window.engine = engine;
    window.app = app;
    window.ui = ui;
};
