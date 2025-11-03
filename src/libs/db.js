import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT || 5432,
  ssl: {
    rejectUnauthorized: false
  }
});

const db = {
  async query(text, params) {
    const res = await pool.query(text, params);
    return res;
  },
  
  async queryOne(text, params) {
    const res = await this.query(text, params);
    return res.rows[0];
  },
  
  async end() {
    await pool.end();
  }
};

export default db;
