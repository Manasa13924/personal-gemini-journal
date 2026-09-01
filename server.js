import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import { GoogleGenerativeAI } from '@google/generative-ai';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Serve static assets
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Initialize Firebase Admin SDK
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/secrets/google-credentials.json';
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountPath)
  });
  console.log('Firebase Admin initialized successfully.');
} catch (error) {
  console.error('Firebase initialization error:', error.message);
}

// Initialize Gemini AI API Key
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('CRITICAL WARNING: GEMINI_API_KEY environment variable is missing!');
}
const genAI = new GoogleGenerativeAI(apiKey || '');

// Core Gemini Handler
const handleJournalRequest = async (req, res) => {
  try {
    const message = req.body.message || req.body.prompt || req.body.text;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const prompt = `Analyze the following journal entry. Provide a thoughtful response followed by a detected primary mood (e.g., Happy, Stressed, Reflective, Accomplished):\n\nEntry: "${message}"`;
    let responseText = '';

    // Attempt generation with primary flash model, fallback to pro model if necessary
    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const result = await model.generateContent(prompt);
      responseText = result.response.text();
    } catch (primaryErr) {
      console.warn('Primary model error, attempting fallback:', primaryErr.message);
      const fallbackModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
      const fallbackResult = await fallbackModel.generateContent(prompt);
      responseText = fallbackResult.response.text();
    }

    return res.status(200).json({
      success: true,
      analysis: responseText,
      response: responseText,
      reply: responseText
    });
  } catch (error) {
    console.error('Gemini Execution Error:', error);
    return res.status(500).json({
      error: 'Failed to generate response from Gemini AI.',
      details: error.message
    });
  }
};

app.post('/api/journal', handleJournalRequest);
app.post('/api/chat', handleJournalRequest);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
