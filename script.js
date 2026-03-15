console.log("Script Loaded Successfully. Checking DOM...");

// 1. WORKER FUNCTION
function workerScript() {
    const HF_USERNAME = "eorchat";
    const REPO_NAME = "eor";
    const HF_BASE_URL = "https://huggingface.co/" + HF_USERNAME + "/" + REPO_NAME + "/resolve/main/";
    
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

    function formatBytes(bytes, decimals) {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    async function downloadFile(filename, index, totalFiles) {
        const url = HF_BASE_URL + filename;
        
        self.postMessage({ 
            status: 'initiate', 
            data: { name: filename, current: index + 1, total: totalFiles } 
        });

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error("HTTP " + response.status);
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
                    const filePercent = loaded / total;
                    const basePercent = index / totalFiles;
                    const globalPercent = Math.floor((basePercent + (filePercent / totalFiles)) * 100);
                    self.postMessage({ status: 'progress', progress: globalPercent });
                }
            }

            const buffer = new Uint8Array(loaded);
            let position = 0;
            for(const chunk of chunks) {
                buffer.set(chunk, position);
                position += chunk.length;
            }

            modelBuffers[filename] = buffer;
            self.postMessage({ 
                status: 'file_complete', 
                data: { name: filename, size: formatBytes(loaded) } 
            });

        } catch (err) {
            self.postMessage({ status: 'error', data: "Failed to download " + filename + ": " + err.message });
            throw err; 
        }
    }

    self.onmessage = async (e) => {
        if (e.data.type === 'load') {
            try {
                const totalFiles = FILES_TO_DOWNLOAD.length;
                self.postMessage({ status: 'log', data: "Starting batch download of " + totalFiles + " files..." });
                
                for (let i = 0; i < totalFiles; i++) {
                    await downloadFile(FILES_TO_DOWNLOAD[i], i, totalFiles);
                }
                
                self.postMessage({ status: 'ready', count: totalFiles });
                
            } catch (error) {
                self.postMessage({ status: 'log', data: "Download sequence stopped due to error." });
            }
        } 
        else if (e.data.type === 'generate') {
            setTimeout(() => {
                self.postMessage({ 
                    status: 'complete', 
                    data: "Inference logic placeholder. All files are loaded in memory.", 
                    mode: e.data.mode 
                });
            }, 500);
        }
    };
}

// 2. ENGINE CONTROLLER
const engine = {
    worker: null,
    isReady: false,
    history: [],

    init: function() {
        console.log("Engine Init Called");
        
        // Warning for Data Usage (Especially mobile)
        const confirmDownload = confirm("This will download approximately 1GB of model data. \n\nAre you sure you want to continue? (WiFi recommended)");
        if (!confirmDownload) return;

        if (this.isReady) {
            alert("Already Ready");
            return;
        }
        
        const log = document.getElementById('loader-log');
        const bar = document.getElementById('progress-bar');
        const overlay = document.getElementById('loader-overlay');

        if(!log || !bar || !overlay) {
            alert("ERROR: Cannot find DOM elements");
            return;
        }
        
        overlay.classList.add('active');
        // Lock body scroll on mobile
        document.body.style.overflow = 'hidden';
        
        log.innerHTML = '> Initializing...';
        bar.style.width = '0%';

        try {
            const blob = new Blob(['(' + workerScript.toString() + ')()'], { type: 'text/javascript' });
            this.worker = new Worker(URL.createObjectURL(blob));
        } catch (e) {
            alert("Error creating Worker: " + e.message);
            return;
        }

        this.worker.onerror = (e) => {
            log.innerHTML += '<span style="color:red">> Worker Internal Error</span><br>';
        };

        this.worker.onmessage = (e) => {
            const { status, data, progress } = e.data;

            if (status === 'log') {
                log.innerHTML += '> ' + data + '<br>';
            }
            else if (status === 'initiate') {
                log.innerHTML += '> Downloading [' + data.current + '/' + data.total + ']: ' + data.name + '<br>';
            }
            else if (status === 'progress') {
                bar.style.width = progress + '%';
            }
            else if (status === 'file_complete') {
                log.innerHTML += '> Finished: ' + data.name + ' (' + data.size + ')<br>';
                log.scrollTop = log.scrollHeight;
            }
            else if (status === 'ready') {
                this.isReady = true;
                overlay.classList.remove('active');
                // Unlock body scroll
                document.body.style.overflow = '';
                ui.updateStatus(true);
                ui.addMessage('ai', 'Engine Ready. <strong>' + data.count + '</strong> files completely downloaded.');
            }
            else if (status === 'error') {
                log.innerHTML += '<div style="color:red; padding:5px;">> ERROR: ' + data + '</div><br>';
                // Unlock body scroll on error too
                document.body.style.overflow = '';
            }
            else if (status === 'complete') {
                app.handleResponse(data, e.data.mode);
            }
            
            // Keep log scrolled to bottom
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

// 3. UI CONTROLLER (Updated for Mobile)
const ui = {
    dom: {
        list: document.getElementById('chat-list'),
        viewport: document.getElementById('chat-viewport'),
        input: document.getElementById('msg-input'),
        btn: document.getElementById('send-btn'),
        dot: document.getElementById('status-dot'),
        text: document.getElementById('status-text'),
        sidebar: document.getElementById('sidebar'),
        backdrop: document.getElementById('mobile-backdrop')
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

    // NEW: Mobile Menu Logic
    toggleMobileMenu: function() {
        if(!this.dom.sidebar) return;
        const isOpen = this.dom.sidebar.classList.contains('open');
        
        if (isOpen) {
            this.closeMobileMenu();
        } else {
            this.dom.sidebar.classList.add('open');
            this.dom.backdrop.classList.add('open');
        }
    },

    closeMobileMenu: function() {
        if(!this.dom.sidebar) return;
        this.dom.sidebar.classList.remove('open');
        this.dom.backdrop.classList.remove('open');
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
        row.className = 'message-row';
        
        let content = '';
        if (role === 'user') {
            content = '<div class="avatar"><i class="fa-solid fa-user"></i></div><div class="message-content user-bubble">' + html + '</div>';
        } else {
            if (isLoading) {
                content = '<div class="avatar"><i class="fa-solid fa-robot"></i></div><div class="message-content ai-text"><div class="typing-dots"></div></div>';
            } else {
                content = '<div class="avatar"><i class="fa-solid fa-robot"></i></div><div class="message-content ai-text">' + html + '</div>';
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

// 5. GLOBAL ATTACHMENT
console.log("Script Loaded. Attaching to window...");
window.engine = engine;
window.app = app;
window.ui = ui;

ui.updateStatus(false);
