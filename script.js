import * as webllm from "https://esm.run/@mlc-ai/web-llm";

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
            sidebar: document.getElementById('sidebar'), // Keep reference even if hidden
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

        // Event Listeners (Removed Menu Logic)
        if(this.dom.navWorkspace) this.dom.navWorkspace.addEventListener('click', () => console.log("Workspace"));
        if(this.dom.navReset) this.dom.navReset.addEventListener('click', () => app.reset());
        if(this.dom.navTheme) this.dom.navTheme.addEventListener('click', () => { document.body.classList.toggle('dark-mode'); });
        if(this.dom.statusPill) this.dom.statusPill.addEventListener('click', () => { engine.init(); });
        
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
        if (role === 'user') row.innerHTML = `<div class="message-content">${this.formatText(content)}</div>`;
        else row.innerHTML = `<div class="message-content">${isLoading ? '<div class="loader-shifter"></div>' : this.formatText(content)}</div>`;
        list.appendChild(row);
        this.scrollToBottom();
    },

    updateLastMessage: function(content) {
        const lastMsg = this.dom.list.querySelector('.message-row:last-child .message-content');
        if(lastMsg) { lastMsg.innerHTML = this.formatText(content); this.scrollToBottom(); }
    }
};

const engine = {
    engine: null,
    isReady: false,
    conversationHistory: [],
    MAX_MEMORY: 20, // Keep last 20 messages (approx. 40 mins of chat)

    init: async function() {
        const { loader } = ui.dom;
        if(!loader.overlay) return;
        
        loader.overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
        loader.log.innerText = '> Initializing WebLLM...\n';
        loader.bar.style.width = '0%';

        try {
            const selectedModel = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

            this.engine = await webllm.CreateMLCEngine(selectedModel, {
                initProgressCallback: (report) => {
                    loader.log.innerText = report.text;
                    if (report.progress !== undefined) {
                        loader.bar.style.width = (report.progress * 100) + '%';
                    }
                }
            });

            loader.log.innerText += '> Model Loaded!\n';
            loader.bar.style.width = '100%';
            this.isReady = true;
            ui.updateStatus(true);
            
            setTimeout(() => {
                loader.overlay.classList.remove('active');
                document.body.style.overflow = '';
                ui.addMessage('eor', 'AI Online. Memory set to last 20 messages.');
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
        if (!this.isReady || !this.engine) return ui.addMessage('eor', "System offline.");
        
        ui.addMessage('eor', '', true); 
        
        try {
            // Add new message to history
            this.conversationHistory.push({ role: "user", content: userInput });

            // Smart Memory Management: Only send last N messages to avoid slowdown
            let contextToSend = this.conversationHistory;
            if (this.conversationHistory.length > this.MAX_MEMORY) {
                // Keep the very first message (usually instructions) + latest messages
                // Or just slice the latest. Let's slice the latest for simplicity.
                contextToSend = this.conversationHistory.slice(-this.MAX_MEMORY);
            }

            // FIX: Increased max_tokens to 2048 for longer responses
            const reply = await this.engine.chat.completions.create({
                messages: contextToSend,
                temperature: 0.7,
                max_tokens: 2048, 
            });
            
            let text = reply.choices[0].message.content;
            
            // Check if hit token limit
            if (reply.choices[0].finish_reason === "length") {
                text += "\n\n[...Response hit length limit. Type 'continue' to keep going...]";
            }

            this.conversationHistory.push({ role: "assistant", content: text });
            ui.updateLastMessage(text);
            
        } catch (err) {
            // Remove failed user message from history
            this.conversationHistory.pop();
            ui.updateLastMessage(`Error: ${err.message}`);
        }
    },
    
    resetMemory: function() {
        this.conversationHistory = [];
        if(this.engine) {
            this.engine.resetChat(); 
        }
    }
};

const app = {
    handleEnter(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } },
    
    reset() { 
        if(ui.dom.list) ui.dom.list.innerHTML = ''; 
        engine.resetMemory();
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
        if (!text) return ui.addMessage('eor', "Type something first.");
        if (!engine.isReady) { if(confirm("Start AI?")) engine.init(); return; }
        
        const prompt = `Improve this text: ${text}`;
        ui.dom.input.value = '';
        ui.addMessage('user', `Assist: ${text}`);
        
        if(ui.dom.btn) ui.dom.btn.disabled = true;
        await engine.generate(prompt);
        if(ui.dom.btn) ui.dom.btn.disabled = false;
    }
};

window.addEventListener('DOMContentLoaded', () => {
    ui.init();
    window.app = app;
    window.engine = engine;
});
