// test.js
const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  try {
    const result = await pool.query('SELECT 1');
    console.log('Test successful:', result.rows);
  } catch (err) {
    console.error('Test failed:', err);
  }
})();