import 'dotenv/config';
import format from 'pg-format';
import db from '../libs/db.js';
import { ask } from '../libs/llm.js';
import axios from 'axios';
import { v5, v4 as uuidv4 } from 'uuid';

/*
  This worker enriches books in book.book where status IS NULL or status='pending'.
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
  return `
    You are an expert literary analysis assistant with deep knowledge of books across all genres.
    Given the following book title and author, 
    produce a JSON object strictly matching this TypeScript interface:

    interface BookEnrichment {
      status: 'FICTION' | 'NON-FICTION';
      genres: string[]; // 2-3 concise genre labels
      summary_pages: string[]; // 5-6 pages of summary, each ~500 words
      key_points: string[]; // 5-7 pivotal ideas or takeaways
      quotes: {
        text: string;
        author?: string;
        page_number?: number;
      }[]; // 5-10 memorable quotations, each < 180 characters
      enjoyment_criteria: string[]; // 3-5 "You'd enjoy this book if..." bullet points
      actionable_benefits: string[]; // 3-5 "This book can help you..." practical benefits
      contrasting_viewpoints: string[]; // 1-2 points of criticism or opposing perspectives
      actionable_steps: string[]; // 2-3 simple tasks/exercises for immediate application
      major_themes: {
        title: string; // Theme name (e.g., "The Power of Vulnerability")
        explanation: string; // 120-200 word explanation of this theme
      }[]; // 3-5 major themes with detailed explanations
    }

    Rules:
    - If you are NOT reasonably confident about the content, respond with {"status":"UNFAMILIAR"} only.
    - For summary_pages: divide the content into 5-6 coherent sections that flow naturally.
    - Each summary page should be self-contained but connect logically to the next.
    - Each summary page content should be divided into paragraphs for readability.
    - For enjoyment_criteria: focus on reader personalities, interests, or situations.
    - For key_points: use single, impactful sentences that capture the essence of each point.
    - For actionable_benefits: be specific about real-world applications and outcomes.
    - For contrasting_viewpoints: include legitimate criticisms or alternative perspectives.
    - For actionable_steps: provide concrete, doable tasks readers can try immediately.
    - For major_themes: go deeper than key_points - provide nuanced analysis.
    - Do NOT include markdown formatting.
    - Do NOT add commentary outside JSON.
    - Keep genres high-level (e.g., "Psychology", "Leadership", "Fantasy").
    - Do not use placeholder text or generic statements.
    - Do NOT add page number in the summary pages.

    Examples for clarity:
    
    Enjoyment criteria examples:
    - "You enjoy introspective narratives that challenge conventional thinking"
    - "You're interested in practical frameworks for decision-making"
    - "You appreciate stories that blend historical facts with compelling character development"
    
    Actionable benefits examples:
    - "Develop a systematic approach to evaluating investment opportunities"
    - "Build stronger relationships through improved emotional intelligence"
    - "Create more effective daily routines using proven productivity principles"
    
    Contrasting viewpoints examples:
    - "Critics argue the author oversimplifies complex psychological phenomena"
    - "Some economists dispute the book's assumptions about market behavior"
    
    Actionable steps examples:
    - "Practice the 5-minute morning reflection exercise described in Chapter 3"
    - "Implement the author's decision-making framework on your next project choice"

    Book:
    Title: "${title}"
    Author: "${author || 'Unknown'}"
    Existing description: "${existingDescription || ''}"
  `;
}

async function ensureGenres(genreNames) {
  if (!genreNames?.length) return [];
  
  const genreIds = [];
  for (const name of genreNames) {
    const genre = await db.queryOne(`
      WITH ins AS (
        INSERT INTO book.genre (name)
        VALUES ($1)
        ON CONFLICT (name) DO NOTHING
        RETURNING id
      )
      SELECT id FROM ins
      UNION ALL
      SELECT id FROM book.genre WHERE name = $1
      LIMIT 1
    `, [name.trim()]);
    
    genreIds.push(genre.id);
  }
  return genreIds;
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
    SELECT id, alias, title, primary_author_name, description, cover_edition_key
    FROM book.book
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
    existingDescription: book.description || (olData && (typeof olData.description === 'string' ? olData.description : olData.description?.value)) || '',
  });

  let llm;
  try {
    llm = await ask(prompt, 'gpt-5-mini', 'book-enrich', {reasoningEffort: 'high' });
  } catch (err) {
    console.error('LLM error:', err.message);
    await db.query('UPDATE book.book SET status = $2 WHERE id = $1', [book.id, 'ERROR_LLM']);
    return true;
  }

  if (llm.status === 'UNFAMILIAR') {
    console.log('Skipped (unfamiliar)');
    await db.query('UPDATE book.book SET status = $2 WHERE id = $1', [book.id, 'SKIPPED']);
    return true;
  }

  try {
    // Handle genres
    const genreIds = await ensureGenres(llm.genres);
    if (genreIds.length) {
      const genreValues = genreIds.map(id => [book.id, id]);
      await db.query(
        format('INSERT INTO book.book_genre (book_id, genre_id) VALUES %L ON CONFLICT DO NOTHING',
          genreValues
        )
      );
    }

    // Handle summary pages
    if (llm.summary_pages?.length) {
      const summaryValues = llm.summary_pages.map((content, i) => [
        book.id, content, i + 1
      ]);
      await db.query(
        format(`
          INSERT INTO book.summary_page (book_id, content, page_number) 
          VALUES %L 
          ON CONFLICT (book_id, page_number) 
          DO UPDATE SET content = EXCLUDED.content`,
          summaryValues
        )
      );
    }

    // Handle key points
    if (llm.key_points?.length) {
      const keyPointValues = llm.key_points.map((point, i) => [
        book.id, point, i + 1
      ]);
      await db.query('DELETE FROM book.key_point WHERE book_id = $1', [book.id]);
      await db.query(
        format('INSERT INTO book.key_point (book_id, point, order_index) VALUES %L',
          keyPointValues
        )
      );
    }

    // Handle quotes
    if (llm.quotes?.length) {
      const quoteValues = llm.quotes.map((quote, i) => [
        book.id,
        quote.text,
        quote.author || null,
        quote.page_number || null,
        i + 1
      ]);
      await db.query('DELETE FROM book.quote WHERE book_id = $1', [book.id]);
      await db.query(
        format('INSERT INTO book.quote (book_id, text, author, page_number, order_index) VALUES %L',
          quoteValues
        )
      );
    }

    // NEW: Handle enjoyment criteria
    if (llm.enjoyment_criteria?.length) {
      const enjoymentValues = llm.enjoyment_criteria.map((criteria, i) => [
        book.id, criteria, i + 1
      ]);
      await db.query('DELETE FROM book.enjoyment_criteria WHERE book_id = $1', [book.id]);
      await db.query(
        format('INSERT INTO book.enjoyment_criteria (book_id, criteria, order_index) VALUES %L',
          enjoymentValues
        )
      );
    }

    // NEW: Handle actionable benefits
    if (llm.actionable_benefits?.length) {
      const benefitValues = llm.actionable_benefits.map((benefit, i) => [
        book.id, benefit, i + 1
      ]);
      await db.query('DELETE FROM book.actionable_benefit WHERE book_id = $1', [book.id]);
      await db.query(
        format('INSERT INTO book.actionable_benefit (book_id, benefit, order_index) VALUES %L',
          benefitValues
        )
      );
    }

    // NEW: Handle contrasting viewpoints
    if (llm.contrasting_viewpoints?.length) {
      const viewpointValues = llm.contrasting_viewpoints.map((viewpoint, i) => [
        book.id, viewpoint, i + 1
      ]);
      await db.query('DELETE FROM book.contrasting_viewpoint WHERE book_id = $1', [book.id]);
      await db.query(
        format('INSERT INTO book.contrasting_viewpoint (book_id, viewpoint, order_index) VALUES %L',
          viewpointValues
        )
      );
    }

    // NEW: Handle actionable steps
    if (llm.actionable_steps?.length) {
      const stepValues = llm.actionable_steps.map((step, i) => [
        book.id, step, i + 1
      ]);
      await db.query('DELETE FROM book.actionable_step WHERE book_id = $1', [book.id]);
      await db.query(
        format('INSERT INTO book.actionable_step (book_id, step, order_index) VALUES %L',
          stepValues
        )
      );
    }

    // NEW: Handle major themes
    for (const theme of llm.major_themes || []) {
      const themeId = uuidv4();
      await db.query(`
        INSERT INTO book.book_theme(
          id,
          book_id,
          title,
          description,
          status
        )
        VALUES ($1, $2, $3, $4, $5)
      `, [
        themeId,
        book.id,
        theme.title,
        theme.description,
        llm.status,
      ]);
    }

    // Update book status
    const pictureUrl = book.cover_edition_key ? `${COVER_BASE}/${book.cover_edition_key}-L.jpg` : null;
    await db.query(`
      UPDATE book.book
      SET status = 'ENRICHED',
          updated_at = NOW(),
          description = COALESCE($2, description),
          picture_url = COALESCE($3, picture_url),
          type = $4
      WHERE id = $1
    `, [
      book.id,
      book.description || (olData && (typeof olData.description === 'string' ? olData.description : olData.description?.value)) || null,
      pictureUrl,
      llm.status
    ]);
    
    console.log('✓ Enriched successfully');
  } catch (err) {
    console.error('DB error:', err.message);
    await db.query('UPDATE book.book SET status = $2, error_message = $3 WHERE id = $1', [book.id, 'ERROR_DB', err.message]);
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
