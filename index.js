import 'dotenv/config';
import { populateBooks } from './src/workers/populate-books.js';
import { enrichBooks } from './src/workers/enrich-books.js';

// Comment out workers you don't want to run
//populateBooks();
enrichBooks();
