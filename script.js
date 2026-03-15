// Import WebLLM
import * as webllm from "https://esm.run/@mlc-ai/web-llm";

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

        // Event Listeners
        if(this.dom.menuBtn) this.dom.menuBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.toggleMobileMenu(); });
        if(this.dom.backdrop) this.dom.backdrop.addEventListener('click', () => this.closeMobileMenu());
        if(this.dom.navWorkspace) this.dom.navWorkspace.addEventListener('click', () => this.closeMobileMenu());
        
        // Reset button now clears memory too
        if(this.dom.navReset) this.dom.navReset.addEventListener('click', () => { app.reset(); this.closeMobileMenu(); });
        
        if(this.dom.navTheme) this.dom.navTheme.addEventListener('click', () => { document.body.classList.toggle('dark-mode'); this.closeMobileMenu(); });
        if(this.dom.statusPill) this.dom.statusPill.addEventListener('click', () => { engine.init(); this.closeMobileMenu(); });
        if(this.dom.input) {
            this.dom.input.addEventListener('input', () => this.resize(this.dom.input));
            this.dom.input.addEventListener('keydown', (e) => app.handleEnter(e));
        }
        if(this.dom.btn) this.dom.btn.addEventListener('click', (e) => { e.preventDefault(); app.send(); });
        if(this.dom.assistBtn) this.dom.assistBtn.addEventListener('click', (e) => { e.preventDefault(); app.assist('universal'); });

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
            if(btn) btn.disabled = false;
        } else {
            text.innerText = "Offline";
            text.style.color = "var(--text-muted)";
            if(btn) btn.disabled = false; 
        }
    },

    toggleMobileMenu: function() {
        const { sidebar, backdrop, menuIcon } = this.dom;
        if(!sidebar) return;
        const isOpen = sidebar.classList.contains('open');
        if (isOpen) this.closeMobileMenu();
        else {
            sidebar.classList.add('open');
            backdrop.classList.add('open');
            if(menuIcon) menuIcon.className = "fa-solid fa-xmark";
        }
    },

    closeMobileMenu: function() {
        const { sidebar, backdrop, menuIcon } = this.dom;
        if(sidebar) sidebar.classList.remove('open');
        if(backdrop) backdrop.classList.remove('open');
        if(menuIcon) menuIcon.className = "fa-solid fa-bars";
    },

    resize: function(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; },
    scrollToBottom: function() { if(this.dom.viewport) this.dom.viewport.scrollTop = this.dom.viewport.scrollHeight; },

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
        if(!list) return;
        const row = document.createElement('div');
        row.className = `message-row ${role}`;
        
        if (role === 'user') {
            row.innerHTML = `<div class="message-content">${this.formatText(content)}</div>`;
        } else {
            // FIX: Use the Shifter Animation when loading
            const displayContent = isLoading 
                ? '<div class="loader-shifter"></div>' 
                : this.formatText(content);
            
            row.innerHTML = `<div class="message-content">${displayContent}</div>`;
        }
        list.appendChild(row);
        this.scrollToBottom();
    },

    updateLastMessage: function(content) {
        const lastMsg = this.dom.list.querySelector('.message-row:last-child .message-content');
        if(lastMsg) { lastMsg.innerHTML = this.formatText(content); this.scrollToBottom(); }
    }
};

// --- ENGINE CONTROLLER (WebLLM) ---
const engine = {
    engine: null,
    isReady: false,
    
    // FIX: Conversation Memory Array
    // This stores the history of the chat
    conversationHistory: [],

    init: async function() {
        const { loader } = ui.dom;
        if(!loader.overlay) return;
        
        loader.overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
        loader.log.innerText = '> Initializing WebLLM...\n';
        loader.bar.style.width = '0%';

        try {
            const selectedModel = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

            loader.log.innerText += `> Loading ${selectedModel}...\n`;

            this.engine = await webllm.CreateMLCEngine(selectedModel, {
                initProgressCallback: (report) => {
                    loader.log.innerText = report.text;
                    if (report.progress !== undefined) {
                        loader.bar.style.width = (report.progress * 100) + '%';
                    }
                }
            });

            loader.log.innerText += '> Model Loaded Successfully!\n';
            loader.bar.style.width = '100%';
            this.isReady = true;
            ui.updateStatus(true);
            
            setTimeout(() => {
                loader.overlay.classList.remove('active');
                document.body.style.overflow = '';
                ui.addMessage('eor', 'AI Online. I remember our conversation now.');
            }, 500);

        } catch (error) {
            console.error(error);
            loader.log.innerHTML += `\n<span style="color:red">> ERROR: ${error.message}</span>\n`;
            loader.bar.style.width = '0%';
            document.body.style.overflow = '';
            ui.updateStatus(false);
        }
    },

    generate: async function(userInput) {
        if (!this.isReady || !this.engine) {
            return ui.addMessage('eor', "System offline.");
        }
        
        // Show Shifter Animation
        ui.addMessage('eor', '', true); 
        
        try {
            // 1. Add user message to history
            this.conversationHistory.push({
                role: "user",
                content: userInput
            });

            // 2. Send FULL history to AI
            // This is how the AI "remembers"
            const reply = await this.engine.chat.completions.create({
                messages: this.conversationHistory,
                temperature: 0.7,
                max_tokens: 200,
            });
            
            const text = reply.choices[0].message.content;
            
            // 3. Add AI response to history
            this.conversationHistory.push({
                role: "assistant",
                content: text
            });

            ui.updateLastMessage(text);
            
        } catch (err) {
            // Remove the last user message from history if error occurs
            this.conversationHistory.pop();
            ui.updateLastMessage(`Error: ${err.message}`);
        }
    },
    
    // Clear history on reset
    resetMemory: function() {
        this.conversationHistory = [];
    }
};

// --- APP LOGIC ---
const app = {
    handleEnter(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } },
    
    reset() { 
        if(ui.dom.list) ui.dom.list.innerHTML = ''; 
        engine.resetMemory(); // Clear memory
        ui.addMessage('eor', "System reset. Memory cleared."); 
    },
    
    async send() {
        const text = ui.dom.input.value.trim();
        if (!text) return;
        if (!engine.isReady) { if(confirm("Start AI?")) engine.init(); return; }

        ui.dom.input.value = ''; 
        ui.dom.input.style.height = 'auto';
        ui.addMessage('user', text);
        
        if(ui.dom.btn) ui.dom.btn.disabled = true;
        await engine.generate(text);
        if(ui.dom.btn) ui.dom.btn.disabled = false;
        
        if(ui.dom.input) ui.dom.input.focus();
    },

    async assist(mode) {
        const text = ui.dom.input.value.trim();
        if (!text) return ui.addMessage('eor', "Type something first to improve.");
        if (!engine.isReady) { if(confirm("Start AI?")) engine.init(); return; }
        
        const prompt = `Improve this text: ${text}`;
        ui.dom.input.value = '';
        ui.addMessage('user', `Assist: ${text}`);
        
        if(ui.dom.btn) ui.dom.btn.disabled = true;
        await engine.generate(prompt); // Uses memory context
        if(ui.dom.btn) ui.dom.btn.disabled = false;
    }
};

// Initialize
window.addEventListener('DOMContentLoaded', () => {
    ui.init();
    window.app = app;
    window.engine = engine;
});
