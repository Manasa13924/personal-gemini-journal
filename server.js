import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(cors());
app.use(express.json());

const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/secrets/google-credentials.json';

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountPath)
  });
  console.log('Firebase Admin initialized successfully.');
} catch (error) {
  console.error('Firebase initialization error:', error.message);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post('/api/journal', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Using gemini-1.5-flash-latest for v1beta endpoint compatibility
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });

    const prompt = `Analyze the following journal entry. Provide a thoughtful response followed by a detected primary mood (e.g., Happy, Stressed, Reflective, Accomplished):\n\nEntry: "${message}"`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    return res.status(200).json({
      success: true,
      analysis: responseText
    });
  } catch (error) {
    console.error('Gemini API Error:', error);
    return res.status(500).json({
      error: 'Failed to generate response from Gemini AI.',
      details: error.message
    });
  }
});

// Interactive Web Interface at Root
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Personal Gemini Journal</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; }
        textarea { width: 100%; height: 100px; margin-bottom: 10px; }
        button { padding: 10px 20px; background-color: #4CAF50; color: white; border: none; cursor: pointer; }
        #output { margin-top: 20px; white-space: pre-wrap; background: #f4f4f4; padding: 15px; border-radius: 5px; }
      </style>
    </head>
    <body>
      <h2>Personal Gemini Journal</h2>
      <textarea id="entry" placeholder="Write your journal entry here..."></textarea><br>
      <button onclick="submitEntry()">Analyze Entry</button>
      <div id="output">Result will appear here...</div>

      <script>
        async function submitEntry() {
          const message = document.getElementById('entry').value;
          const outputDiv = document.getElementById('output');
          outputDiv.innerText = 'Analyzing with Gemini AI...';

          try {
            const res = await fetch('/api/journal', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message })
            });
            const data = await res.json();
            if (data.success) {
              outputDiv.innerText = data.analysis;
            } else {
              outputDiv.innerText = 'Error: ' + (data.details || data.error);
            }
          } catch (err) {
            outputDiv.innerText = 'Failed to connect to server.';
          }
        }
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
