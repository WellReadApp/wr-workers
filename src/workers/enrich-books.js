import 'dotenv/config';
import db from '../libs/db.js';
import { ask } from '../libs/llm.js';
import axios from 'axios';
import { v5 } from 'uuid';

/*
  This worker enriches books in wellread.book where status IS NULL or status='pending'.
  It fetches Open Library work metadata and uses LLM to produce:
    - description (if not already present)
    - summary (~15 minute read length)
    - key_points (3-7)
    - quotes (5-10 notable quotes or paraphrased key lines)
    - genres (2-3) if empty
  Then updates the book row setting status='ENRICHED'.
*/

const COVER_BASE = 'https://covers.openlibrary.org/b/olid';

function buildPrompt({ title, author, existingDescription }) {
  return `You are an expert literary summarization assistant.
Given the following book title and author, produce a JSON object strictly matching this TypeScript interface:

interface BookEnrichment {
  status: 'FICTION' | 'NON-FICTION';
  genres: string[]; // 2-3 concise genre labels
  summary: string; // A rich, engaging summary that would take about 15 minutes to read out loud. 900-1200 words. No spoilers beyond broad arcs.
  key_points: string[]; // 5-7 pivotal ideas, themes, or takeaways.
  quotes: string[]; // 5-10 memorable quotations. If exact quotes unavailable, paraphrase BUT do not fabricate improbable lines. Each should be < 180 characters.
}

Rules:
- If you are NOT reasonably confident about the content, respond with {"status":"UNFAMILIAR"} only.
- Do NOT include markdown.
- Do NOT add commentary outside JSON.
- Keep genres high-level (e.g., "Psychology", "Leadership", "Fantasy").
- Do not use placeholder text.

Book:
Title: "${title}"
Author: "${author || 'Unknown'}"
Existing description (may be empty): "${existingDescription || ''}"`;
}

async function fetchOpenLibraryWork(book) {
  try {
    const workUrl = `https://openlibrary.org/works/${book.alias}.json`;
    const { data } = await axios.get(workUrl, {
      headers: { 'User-Agent': 'WellRead (wellread.com contact@wellread.com)' }
    });
    return data;
  } catch (err) {
    return null;
  }
}

async function enrichOne() {
  const book = await db.queryOne(`
    SELECT id, alias, title, primary_author_name, description, genres, cover_edition_key
    FROM wellread.book
    WHERE (status IS NULL OR status = 'pending')
    ORDER BY readinglog_count DESC NULLS LAST
    LIMIT 1
  `);
  if (!book) {
    return false;
  }

  console.log(`Enriching: ${book.title}`);

  const olData = await fetchOpenLibraryWork(book);

  const prompt = buildPrompt({
    title: book.title,
    author: book.primary_author_name,
    existingDescription: book.description,
  });

  let llm;
  try {
    llm = await ask(prompt, undefined, 'book-enrich');
  } catch (err) {
    console.error('LLM error:', err.message);
    await db.query('UPDATE wellread.book SET status = $2 WHERE id = $1', [book.id, 'ERROR_LLM']);
    return true;
  }

  if (llm.status === 'UNFAMILIAR') {
    console.log('Skipped (unfamiliar)');
    await db.query('UPDATE wellread.book SET status = $2 WHERE id = $1', [book.id, 'SKIPPED']);
    return true;
  }

  // Derive genres list: prefer LLM genres if not already present
  const genresArray = (book.genres && book.genres.length > 0) ? book.genres : llm.genres || [];
  const keyPointsArray = llm.key_points || [];
  const quotesArray = llm.quotes || [];

  // Picture URL if cover_edition_key exists
  const pictureUrl = book.cover_edition_key ? `${COVER_BASE}/${book.cover_edition_key}-L.jpg` : null;

  try {
    await db.query(`
      UPDATE wellread.book
      SET status = 'ENRICHED',
          updated_at = NOW(),
          description = COALESCE($2, description),
          genres = $3,
          summary = $4,
          key_points = $5,
          quotes = $6,
          picture_url = COALESCE($7, picture_url),
          type = $8
      WHERE id = $1
    `, [
      book.id,
      book.description || (olData && (typeof olData.description === 'string' ? olData.description : olData.description?.value)) || null,
      genresArray,
      llm.summary,
      keyPointsArray,
      quotesArray,
      pictureUrl,
      llm.status // Using status as type (FICTION/NON-FICTION)
    ]);
    console.log('✓ Enriched successfully');
  } catch (err) {
    console.error('DB error:', err.message);
    await db.query('UPDATE wellread.book SET status = $2 WHERE id = $1', [book.id, 'ERROR_DB']);
  }

  return true;
}

async function loop() {
  while (true) {
    const processed = await enrichOne();
    if (!processed) {
      console.log('No pending books, sleeping 5 minutes...');
      await new Promise(r => setTimeout(r, 5 * 60 * 1000));
    } else {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

export { loop as enrichBooks };
