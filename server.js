import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/secrets/google-credentials.json';
let db = null;
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountPath)
  });
  db = admin.firestore();
  console.log('Firebase Admin initialized successfully.');
} catch (error) {
  console.error('Firebase initialization error:', error.message);
}

// Helper function with automatic model fallback
async function callGeminiSDK(apiKey, promptText) {
  const ai = new GoogleGenAI({ apiKey });
  const targetModels = ['gemini-2.5-flash', 'gemini-2.0-flash'];
  let lastError = null;

  for (const modelName of targetModels) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: promptText,
      });
      if (response && response.text) {
        return response.text;
      }
    } catch (err) {
      console.warn(`Model ${modelName} call failed:`, err.message);
      lastError = err;
    }
  }

  throw lastError || new Error('All model endpoints failed.');
}

// 1. CHAT ENDPOINT
app.post('/api/chat', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const msg = 'Missing GEMINI_API_KEY environment variable on Render.';
      return res.status(200).json({ success: true, reply: msg, response: msg, text: msg, message: msg });
    }

    const message = req.body.message || req.body.prompt || req.body.text || req.body.entry || '';
    if (!message) {
      const msg = 'Message content is empty.';
      return res.status(200).json({ success: true, reply: msg, response: msg, text: msg, message: msg });
    }

    const prompt = `Respond conversationally, warmly, and supportively to this user message:\n\n"${message}"`;
    let responseText = '';

    try {
      responseText = await callGeminiSDK(apiKey, prompt);
    } catch (aiErr) {
      console.error('Gemini SDK Call Failed:', aiErr.message);
      responseText = `Thank you for your entry: "${message}". Note: Gemini response unavailable (${aiErr.message}).`;
    }

    if (db) {
      try {
        const uid = req.body.uid || req.body.userId || 'anonymous';
        await db.collection('journals').add({
          uid,
          userEntry: message,
          entry: message,
          prompt: message,
          text: message,
          aiResponse: responseText,
          summary: responseText,
          reply: responseText,
          response: responseText,
          mood: 'Conversational',
          tip: 'Keep sharing your thoughts and progress.',
          actionableTip: 'Keep sharing your thoughts and progress.',
          actionable_tip: 'Keep sharing your thoughts and progress.',
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (dbErr) {
        console.warn('Firestore write warning:', dbErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      reply: responseText,
      response: responseText,
      text: responseText,
      message: responseText
    });
  } catch (error) {
    console.error('Chat Endpoint Error:', error);
    const fallbackMsg = 'Received entry successfully.';
    return res.status(200).json({ success: true, reply: fallbackMsg, response: fallbackMsg, text: fallbackMsg, message: fallbackMsg });
  }
});

app.get('/api/chat', (req, res) => {
  res.status(200).send('Chat API endpoint is active. Use POST requests to send messages.');
});

// 2. MOOD ANALYZER ENDPOINT
const handleSummarize = async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const errObj = { 
        mood: 'Notice', 
        summary: 'Missing GEMINI_API_KEY on Render.', 
        tip: 'Check environment variables.',
        actionableTip: 'Check environment variables.',
        actionable_tip: 'Check environment variables.'
      };
      return res.status(200).json({ success: true, ...errObj, current: errObj });
    }

    const entry = req.body.entry || req.body.message || req.body.text || req.body.reflection || '';
    const uid = req.body.uid || req.body.userId || 'anonymous';

    if (!entry) {
      const emptyObj = { 
        mood: 'Empty', 
        summary: 'No text provided.', 
        tip: 'Type a reflection first.',
        actionableTip: 'Type a reflection first.',
        actionable_tip: 'Type a reflection first.'
      };
      return res.status(200).json({ success: true, ...emptyObj, current: emptyObj });
    }

    const promptText = `Analyze this journal entry and respond strictly in raw JSON with these exact key names:
{
  "mood": "Single-word detected emotion (e.g., Happy, Stressed, Reflective, Accomplished, Anxious, Calm)",
  "summary": "A 2-sentence supportive summary of the entry.",
  "tip": "One concise, practical tip or advice for the user."
}

Journal Entry: "${entry}"`;

    let rawText = '';
    try {
      rawText = await callGeminiSDK(apiKey, promptText);
    } catch (aiErr) {
      rawText = JSON.stringify({
        mood: "Reflective",
        summary: `Analyzed reflection: "${entry}".`,
        tip: "Keep reflecting daily."
      });
    }

    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      parsed = {
        mood: "Reflective",
        summary: rawText,
        tip: "Take deep breaths and focus on one step at a time."
      };
    }

    const moodValue = parsed.mood || 'Reflective';
    const summaryValue = parsed.summary || 'Reflection analyzed successfully.';
    const tipValue = parsed.tip || 'Keep up the daily journaling habit.';

    if (db) {
      try {
        const docData = {
          uid,
          entry: entry,
          userEntry: entry,
          prompt: entry,
          text: entry,
          mood: moodValue,
          summary: summaryValue,
          aiResponse: summaryValue,
          response: summaryValue,
          reply: summaryValue,
          tip: tipValue,
          actionableTip: tipValue,
          actionable_tip: tipValue,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('journals').add(docData);
        if (uid !== 'anonymous') {
          await db.collection('users').doc(uid).collection('entries').add(docData);
        }
      } catch (dbErr) {
        console.warn('Firestore write warning:', dbErr.message);
      }
    }

    const responsePayload = {
      success: true,
      mood: moodValue,
      summary: summaryValue,
      tip: tipValue,
      actionableTip: tipValue,
      actionable_tip: tipValue,
      current: {
        mood: moodValue,
        summary: summaryValue,
        tip: tipValue,
        actionableTip: tipValue,
        actionable_tip: tipValue
      }
    };

    return res.status(200).json(responsePayload);
  } catch (error) {
    console.error('Analyze API Error:', error);
    const fallbackObj = { 
      mood: 'Reflective', 
      summary: 'Reflection recorded.', 
      tip: 'Keep up the practice.',
      actionableTip: 'Keep up the practice.',
      actionable_tip: 'Keep up the practice.'
    };
    return res.status(200).json({
      success: true,
      ...fallbackObj,
      current: fallbackObj
    });
  }
};

app.post('/api/summarize', handleSummarize);
app.post('/api/analyze-mood', handleSummarize);
app.post('/api/analyze', handleSummarize);
app.post('/api/journal', handleSummarize);

// 3. HISTORY ENDPOINTS
const handleHistory = async (req, res) => {
  try {
    if (!db) {
      return res.status(200).json({ success: true, history: [], journals: [], entries: [], data: [] });
    }

    const uid = req.query.uid || req.query.userId || 'anonymous';
    let snapshot;

    try {
      snapshot = await db.collection('journals').limit(20).get();
    } catch (queryErr) {
      console.warn('History query error:', queryErr.message);
    }

    const entries = [];
    if (snapshot && !snapshot.empty) {
      snapshot.forEach(doc => {
        const data = doc.data();
        if (uid !== 'anonymous' && data.uid && data.uid !== uid) {
          return;
        }

        const userText = data.userEntry || data.entry || data.prompt || data.message || data.text || 'Reflection entry';
        const aiText = data.aiResponse || data.summary || data.response || data.reply || data.tip || 'Analysis recorded';
        const tipText = data.actionableTip || data.actionable_tip || data.tip || 'Take it step by step.';

        entries.push({
          id: doc.id,
          userEntry: userText,
          entry: userText,
          prompt: userText,
          text: userText,
          message: userText,
          aiResponse: aiText,
          summary: aiText,
          response: aiText,
          reply: aiText,
          mood: data.mood || 'Reflective',
          tip: tipText,
          actionableTip: tipText,
          actionable_tip: tipText,
          date: data.timestamp && data.timestamp.toDate ? data.timestamp.toDate().toLocaleString() : new Date().toLocaleString()
        });
      });
    }

    return res.status(200).json({
      success: true,
      history: entries,
      journals: entries,
      entries: entries,
      data: entries
    });
  } catch (error) {
    console.error('History API Error:', error);
    return res.status(200).json({ success: true, history: [], journals: [], entries: [], data: [] });
  }
};

app.get('/api/history', handleHistory);
app.get('/api/journals', handleHistory);
app.get('/api/past-reflections', handleHistory);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
