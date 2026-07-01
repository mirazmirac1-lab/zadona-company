const { Pool } = require('pg');
require('dotenv').config();

// Railway provides DATABASE_URL automatically once a Postgres
// instance is attached to your project. Locally, put the same
// variable in a .env file (see .env.example).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

module.exports = pool;
