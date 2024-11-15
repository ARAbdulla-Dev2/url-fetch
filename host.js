const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const https = require('https');
const { exec } = require('child_process');

axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });

const app = express();
const PORT = 80;

// API key for security
const API_KEY = "dzhdJ6Ty9jTH2D56-H171z83j319dj61d";

// Middleware to enforce API key validation
app.use((req, res, next) => {
  const apiKey = req.query.apiKey || req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    return res.status(403).json({ error: "Invalid or missing API key" });
  }
  next();
});

// Helper: Generate random alphanumeric string
function generateRandomString(length = 16) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

// Load all movie files from the data directory
function loadMovies() {
  const movies = [];
  const dataDir = path.join(__dirname, 'data');
  fs.readdirSync(dataDir).forEach(file => {
    if (file.startsWith('file') && file.endsWith('.js')) {
      const movieData = require(path.join(dataDir, file));
      movies.push(...movieData.movies);
    }
  });
  return movies;
}

let moviesDatabase = loadMovies();

// Store active URLs with expiration
const activeUrls = new Map();

// Helper to create a unique, expiring URL for each movie request
function generateSecureUrl(movieName, moviePath) {
  const token = generateRandomString(10);
  const extension = path.extname(moviePath);
  const formattedName = movieName.replace(/\s+/g, '.').toLowerCase();
  const urlPath = `/${token}/${formattedName}${extension}`;
  
  const expiresIn = 60 * 60 * 1000; // 1 hour expiration time

  activeUrls.set(token, {
    path: moviePath,
    expiresAt: Date.now() + expiresIn,
  });

  // Clear the URL after expiration
  setTimeout(() => {
    activeUrls.delete(token);
  }, expiresIn);

  return urlPath;
}

// Transcode video to 720p
function transcodeTo720p(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const command = `ffmpeg -i "${inputPath}" -vf scale=1280:-1 -c:v libx264 -preset fast -crf 23 -c:a aac "${outputPath}"`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("Error transcoding video:", stderr);
        reject(error);
      } else {
        resolve(outputPath);
      }
    });
  });
}


// Middleware to serve the movie database in JSON format
app.get('/api/movies', (req, res) => {
  const { search } = req.query;
  let results = moviesDatabase;

  // Filter results if search query is present
  if (search) {
    results = moviesDatabase.filter(movie => 
      movie.name.toLowerCase().includes(search.toLowerCase()) ||
      movie.tags.some(tag => tag.toLowerCase().includes(search.toLowerCase()))
    );
  }

  res.json(results);
});

app.get('/api/request-movie/:name', async (req, res) => {
  const movieName = req.params.name;

  // Find the requested movie in the database
  const movie = moviesDatabase.find(m => m.name === movieName);
  if (!movie) {
    return res.status(404).json({ error: 'Movie not found' });
  }

  const outputPath = `./transcoded/${generateRandomString(10)}.mp4`;
  try {
    await transcodeTo720p(movie.link, outputPath); // Call the updated function here
    const secureUrl = generateSecureUrl(movie.name, outputPath);
    res.json({ name: movie.name, url: secureUrl, expiresIn: '1 hour' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process the video.' });
  }
});


// Route handler for streaming the movie
app.get('/:token/:file', (req, res) => {
  const { token } = req.params;
  const urlData = activeUrls.get(token);

  // Check if the token is valid and hasn't expired
  if (!urlData || Date.now() > urlData.expiresAt) {
    return res.status(404).json({ error: 'This URL has expired or is invalid.' });
  }

  const moviePath = urlData.path;
  const stream = fs.createReadStream(moviePath);

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Disposition': 'inline',
  });

  stream.pipe(res);
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
