const express = require('express');
const {
    createProxyMiddleware,
    responseInterceptor
} = require('http-proxy-middleware');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Core State Store
const sessionMemory = new Map();

app.use(express.json());

/**
 * Background summarization logic
 */
async function generateNewSummary(oldSummary, turnsToCompress) {
    const turnsText = turnsToCompress.map(t => `${t.role.toUpperCase()}: ${t.content}`).join('\n');

    try {
        const response = await fetch('https://anthropic.com', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-3-5-haiku-20241022',
                max_tokens: 600,
                messages: [{
                    role: 'user',
                    content: `You are a memory condensation module. Your goal is to update an ongoing conversation summary with the latest raw interactions from a terminal programming session. Keep it clean, highly descriptive, capturing directory context, code state, errors encountered, goals, and user preferences.

Current Running Summary:
"${oldSummary || 'No history yet.'}"

New Interactive Turns:
${turnsText}

Provide only the updated summary text. Do not wrap it in conversational fluff or introductions.`
        }]
            })
        });

        const data = await response.json();
        if (data.content && data.content[0]) {
            return data.content[0].text.trim();
        }
        throw new Error(JSON.stringify(data));
    } catch (err) {
        console.error('❌ Background Summarization Task Failed:', err);
        return oldSummary;
    }
}

/**
 * Primary Reverse Proxy Interceptor tailored for Claude Code
 */
app.use(
    '/v1/messages',
    createProxyMiddleware({
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        selfHandleResponse: true,

        onProxyReq: async (proxyReq, req, res) => {
            try {
                // CLAUDE CODE INTERCEPT FIX: Derive unique sessions using the Client Key or Local IP Address
                const sessionId = req.headers['x-api-key'] || req.headers['authorization'] || req.ip;

                if (!sessionMemory.has(sessionId)) {
                    sessionMemory.set(sessionId, {
                        summary: "",
                        recentMessages: [],
                        isInitialized: false
                    });
                }

                const session = sessionMemory.get(sessionId);
                const clientBody = req.body;

                // --- CONVERSATION REPLAY (Runs once when Claude Code boots its prompt session) ---
                if (!session.isInitialized) {
                    console.log(`🔄 Replaying project context & historical summary to Claude Code...`);

                    if (session.summary) {
                        clientBody.system = `${clientBody.system || ""}\n\n[CONCISE PAST CONTEXT]: ${session.summary}`;
                    }

                    const clientIncomingTurns = clientBody.messages || [];
                    clientBody.messages = [...session.recentMessages, ...clientIncomingTurns];

                    session.isInitialized = true;
                    sessionMemory.set(sessionId, session);
                }

                // Cache message frame to update rolling memory if API call is successful
                req.pendingClientTurns = clientBody.messages ? clientBody.messages.slice(-1) : [];

                const modifiedPayload = JSON.stringify(clientBody);
                proxyReq.setHeader('Content-Type', 'application/json');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(modifiedPayload));

                // Pass master internal key forward to Anthropic if Claude Code didn't supply one
                if (!req.headers['x-api-key']) {
                    proxyReq.setHeader('x-api-key', process.env.ANTHROPIC_API_KEY || '');
                }

                proxyReq.write(modifiedPayload);
                proxyReq.end();
            } catch (error) {
                console.error("❌ Proxy Request Pre-processing Fault:", error);
                res.status(500).json({
                    error: "Internal Gateway Error before target dispatch"
                });
            }
        },

        onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
            const sessionId = req.headers['x-api-key'] || req.headers['authorization'] || req.ip;

            if (proxyRes.statusCode === 200) {
                try {
                    const responseData = JSON.parse(responseBuffer.toString('utf8'));
                    const session = sessionMemory.get(sessionId);

                    if (responseData.content && responseData.content[0]) {
                        const assistantMessage = {
                            role: 'assistant',
                            content: responseData.content[0].text
                        };

                        if (session) {
                            session.recentMessages.push(...req.pendingClientTurns);
                            session.recentMessages.push(assistantMessage);
                            sessionMemory.set(sessionId, session);
                            console.log(`📝 Live terminal turn cached. Total messages in current active loop: ${session.recentMessages.length}`);
                        }
                    }
                } catch (err) {
                    console.error('❌ Failed parsing success packet for conversational caching:', err);
                }
            }

            return responseBuffer;
        }),
    })
);

/**
 * EXPLICIT END OF SESSION COMPRESSION
 */
app.post('/v1/sessions/close', async (req, res) => {
    const sessionId = req.body.sessionId || req.headers['x-api-key'] || req.headers['authorization'] || req.ip;

    if (!sessionMemory.has(sessionId)) {
        return res.status(400).json({
            error: "No active session tracking data found for this context"
        });
    }

    const session = sessionMemory.get(sessionId);

    if (session.recentMessages.length > 4) {
        console.log(`🗜️ Session closed. Condensing historical arrays for Claude Code tracking...`);
        const optimizedSummaryText = await generateNewSummary(session.summary, session.recentMessages);

        session.summary = optimizedSummaryText;
        session.recentMessages = session.recentMessages.slice(-4); // Keep a lightweight context bridge
        console.log(`✨ Terminal history compressed down to a baseline summary.`);
    }

    // Set to uninitialized so the next time 'claude' starts, it receives the complete context injection
    session.isInitialized = false;
    sessionMemory.set(sessionId, session);

    return res.json({
        status: "Memory successfully optimized for next terminal instance boot."
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Context Bridge Interceptor is online at http://localhost:${PORT}`);
});
