# WellRead Workers

Workers for populating book and author data from Open Library into WellRead database.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory with your database credentials:

```env
PGUSER=postgres
PGPASSWORD=your_password
PGHOST=your_host
PGDATABASE=your_database
PGPORT=5432
```

### 3. Create Database Schema

Run the schema file to create the `wellread` schema and tables:

```bash
psql -h your_host -U postgres -d your_database -f schema.sql
```

Or connect to your database and run the SQL manually.

### 4. Test Database Connection

```bash
npm run test:db
```

This will verify:
- Database connection is working
- `wellread` schema exists
- `book` and `author` tables exist

## Running Workers

### Populate Books

Fetches books from Open Library and populates the database:

```bash
npm run populate:books
```

**Features:**
- Fetches 100 books per request
- Resumes from last count in database
- Creates deterministic UUIDs (safe to re-run)
- Uses `ON CONFLICT DO NOTHING` to avoid duplicates
- Rate-limited with 1 second delay between requests
- Limited to 10 iterations by default (remove `maxIterations` for production)

**Customize the search query** in `src/workers/populate-books.js`:
```javascript
const query = 'readinglog_count:[1 TO *] language:eng';
```

Example queries:
- `'subject:fiction language:eng'` - Fiction books in English
- `'readinglog_count:[100 TO *] language:eng'` - Popular books (100+ readers)
- `'first_publish_year:[2020 TO *]'` - Recent books

## Project Structure

```
wr-workers/
├── src/
│   ├── libs/
│   │   ├── db.js          # Database connection pool
│   │   └── db-test.js     # Database connection test
│   └── workers/
│       └── populate-books.js  # Book population worker
├── .env                   # Environment variables (not in git)
├── schema.sql            # Database schema
├── package.json
└── README.md
```

## Database Schema

### wellread.author
- `id` (uuid) - Primary key, generated from Open Library author URL
- `created_at`, `updated_at` - Timestamps
- `url` - Open Library author page URL
- `alias` - Open Library author ID
- `name` - Author name
- `personal_name` - Personal name (optional)
- `picture_url` - Author picture (optional)

### wellread.book
- `id` (uuid) - Primary key, generated from Open Library work URL
- `created_at`, `updated_at` - Timestamps
- `url` - Open Library work page URL
- `alias` - Open Library work ID
- `title` - Book title
- `cover_edition_key` - Edition key for cover image
- `primary_author_name` - Primary author name
- `status` - Processing status (pending, enriched, etc.)
- `description`, `summary`, `key_points` - Rich content (populated later)
- `type` - Book type
- `genres` - Array of genres
- `picture_url` - Cover image URL
- `similar_books` - Array of similar book references
- `first_publish_year` - First publication year
- `readinglog_count` - Popularity metric from Open Library

## Notes

- The worker uses UUID v5 with URL namespace for deterministic IDs
- Safe to re-run - duplicate entries are ignored via `ON CONFLICT`
- Status field set to 'pending' for later enrichment workers
- Adjust `maxIterations` in worker for testing vs production runs