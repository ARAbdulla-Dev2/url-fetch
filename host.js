const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const https = require('https');

axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });

const app = express();
const PORT = 80;

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
function generateSecureUrl(moviePath) {
  const token = crypto.randomBytes(20).toString('hex');
  const expiresIn = 60 * 60 * 1000; // 1 hour expiration time

  const urlPath = `/stream/${token}.mp4`;
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

// Endpoint to request a movie with secure URL generation
app.get('/api/request-movie/:name', (req, res) => {
  const movieName = req.params.name;

  // Find the requested movie in the database
  const movie = moviesDatabase.find(m => m.name === movieName);
  if (!movie) {
    return res.status(404).json({ error: 'Movie not found' });
  }

  // Generate a secure URL for streaming
  const secureUrl = generateSecureUrl(movie.link);
  res.json({ name: movie.name, url: secureUrl, expiresIn: '1 hour' });
});


  // Create an instance of axios with the custom httpsAgent
const instance = axios.create({
    httpsAgent: new https.Agent({
      rejectUnauthorized: false // Disable SSL certificate validation
    })
  });
  
 // Function to get remote file size using a HEAD request
async function getRemoteFileSize(url) {
    try {
      const response = await axios.head(url); // Use HEAD request to get headers
      return parseInt(response.headers['content-length'], 10); // Get content-length from headers
    } catch (error) {
      console.error('Error fetching remote file size:', error);
      return null;
    }
  }
  
  // Route handler for streaming the movie
  app.get('/stream/:token.mp4', async (req, res) => {
    const { token } = req.params;
    const urlData = activeUrls.get(token);
  
    // Check if the token is valid and hasn't expired
    if (!urlData || Date.now() > urlData.expiresAt) {
      return res.status(404).json({ error: 'This URL has expired or is invalid.' });
    }
  
    const moviePath = urlData.path;
    let fileSize;
  
    // Check if the movie path is a URL (remote file)
    if (moviePath.startsWith('http://') || moviePath.startsWith('https://')) {
      // Fetch the remote file size using axios HEAD request
      fileSize = await getRemoteFileSize(moviePath);
      if (!fileSize) {
        return res.status(404).json({ error: 'Unable to fetch remote file size.' });
      }
    } else {
      // For local files, use fs.stat to get file size
      try {
        const stats = await fs.promises.stat(moviePath);
        fileSize = stats.size;
      } catch (err) {
        console.error('Error fetching video stats:', err);
        return res.status(404).json({ error: 'File not found' });
      }
    }
  
    // Handle range requests for partial content (streaming)
    const range = req.headers.range;
    if (range) {
      const [start, end] = range.replace(/bytes=/, "").split("-").map(Number);
      const chunkStart = start || 0;
      const chunkEnd = end || fileSize - 1;
      const contentLength = chunkEnd - chunkStart + 1;
  
      res.writeHead(206, {
        'Content-Range': `bytes ${chunkStart}-${chunkEnd}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': contentLength,
        'Content-Type': 'video/mp4'
      });
  
      let stream;
      if (moviePath.startsWith('http://') || moviePath.startsWith('https://')) {
        // For remote streams, use axios with range header
        try {
          stream = (await axios.get(moviePath, {
            responseType: 'stream',
            headers: { range: `bytes=${chunkStart}-${chunkEnd}` }
          })).data;
        } catch (error) {
          console.error('Error fetching remote stream:', error);
          return res.status(500).json({ error: 'Failed to stream the video.' });
        }
      } else {
        // For local file streams
        try {
          stream = fs.createReadStream(moviePath, { start: chunkStart, end: chunkEnd });
        } catch (error) {
          console.error('Error reading local file stream:', error);
          return res.status(500).json({ error: 'Failed to stream the video.' });
        }
      }
  
      // Pipe the stream to the response
      if (stream) {
        stream.pipe(res);
        stream.on('close', () => {
          activeUrls.delete(token); // Remove URL from activeUrls after streaming
        });
      } else {
        res.status(500).json({ error: 'Failed to create a stream for the video.' });
      }
  
    } else {
      // No range provided, stream the whole file
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4'
      });
  
      let stream;
      if (moviePath.startsWith('http://') || moviePath.startsWith('https://')) {
        // For remote streams, use axios
        try {
          stream = (await axios.get(moviePath, { responseType: 'stream' })).data;
        } catch (error) {
          console.error('Error fetching remote stream:', error);
          return res.status(500).json({ error: 'Failed to stream the video.' });
        }
      } else {
        // For local file streams
        try {
          stream = fs.createReadStream(moviePath);
        } catch (error) {
          console.error('Error reading local file stream:', error);
          return res.status(500).json({ error: 'Failed to stream the video.' });
        }
      }
  
      // Pipe the stream to the response
      if (stream) {
        stream.pipe(res);
        stream.on('close', () => {
          activeUrls.delete(token); // Remove URL from activeUrls after streaming
        });
      } else {
        res.status(500).json({ error: 'Failed to create a stream for the video.' });
      }
    }
  });

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
