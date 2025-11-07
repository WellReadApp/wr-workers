import 'dotenv/config';
import axios from 'axios';
import format from 'pg-format';
import { v5 } from 'uuid';
import db from '../libs/db.js';

const fields = [
  'key',
  'author_name',
  'cover_edition_key',
  'first_publish_year',
  'readinglog_count',
  'title',
];

async function search(q, offset, limit) {
  const { data } = await axios.get('https://openlibrary.org/search.json', {
    params: {
      q,
      offset,
      limit,
      fields: fields.join(','),
      sort: 'readinglog'
    },
    headers: {
      'User-Agent': 'WellRead (https://wellread.com, contact@wellread.com)',
    },
  });
  
  const bookInserts = [];

  for (const doc of data.docs) {
    const bookAlias = doc.key.replace('/works/', '');
    const url = `https://openlibrary.org${doc.key}`;
    const id = v5(url, v5.URL);
    let primaryAuthorName = null;
    let pictureUrl = null;
    
    if (doc.author_name && doc.author_name.length > 0) {
      primaryAuthorName = doc.author_name[0];
    }
    
    // Generate cover image URL from cover_edition_key
    if (doc.cover_edition_key) {
      pictureUrl = `https://covers.openlibrary.org/b/olid/${doc.cover_edition_key}-L.jpg`;
    }
    
    bookInserts.push([
      id,
      new Date(),
      new Date(),
      url,
      bookAlias,
      doc.title,
      doc.cover_edition_key || null,
      primaryAuthorName,
      'pending', // status
      pictureUrl, // picture_url
      doc.first_publish_year || null,
      doc.readinglog_count || 0,
    ]);
  }

  if (bookInserts.length > 0) {
    await db.query(format(`
      INSERT INTO book.book (
        id, created_at, updated_at, url, alias, title, cover_edition_key, 
        primary_author_name, status, picture_url, first_publish_year, readinglog_count
      ) 
      VALUES %L
      ON CONFLICT (id) DO NOTHING
    `, bookInserts));
    console.log(`[${offset}] Inserted ${bookInserts.length} books`);
  }

  return data.docs.length > 0;
}

async function main() {
  try {
    const { count } = await db.queryOne(`
      SELECT COUNT(1) AS count FROM book.book
    `);
    console.log(`Starting from offset ${count}`);
    
    let offset = parseInt(count);
    const increment = 100;
    
    while (true) {
      const query = 'readinglog_count:[1 TO *] language:eng';
      let hasMore = await search(query, offset, increment);
      offset += increment;
      
      if (!hasMore) {
        console.log('Completed - no more books available');
        break;
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    await db.end();
  } catch (error) {
    console.error('Error:', error.message);
    await db.end();
    process.exit(1);
  }
}

export { main as populateBooks };
