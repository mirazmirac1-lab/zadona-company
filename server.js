const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---------- Startup: ensure schema exists ----------
async function ensureSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Schema ready.');
}

// ---------- Helpers ----------
function mapSaleRow(r) {
  return {
    id: r.id,
    itemId: r.item_id,
    itemName: r.item_name,
    qty: r.qty,
    total: Number(r.total),
    paidAmount: Number(r.paid_amount),
    debtorName: r.debtor_name || '',
    debtorPhone: r.debtor_phone || '',
    date: r.sale_date
  };
}

function mapItemRow(r) {
  return { id: r.id, name: r.name, qty: r.qty, price: Number(r.price) };
}

// ---------- Inventory routes ----------
app.get('/api/inventory', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM inventory ORDER BY id');
    res.json(rows.map(mapItemRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kupata bidhaa' });
  }
});

app.post('/api/inventory', async (req, res) => {
  try {
    const { name, qty, price } = req.body;
    if (!name) return res.status(400).json({ error: 'Jina la bidhaa linahitajika' });
    const { rows } = await pool.query(
      'INSERT INTO inventory (name, qty, price) VALUES ($1, $2, $3) RETURNING *',
      [name, qty || 0, price || 0]
    );
    res.status(201).json(mapItemRow(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kuongeza bidhaa' });
  }
});

// Adjust stock (add or subtract qty)
app.patch('/api/inventory/:id/stock', async (req, res) => {
  try {
    const { delta } = req.body;
    const { rows } = await pool.query(
      'UPDATE inventory SET qty = qty + $1 WHERE id = $2 RETURNING *',
      [delta, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Bidhaa haipo' });
    res.json(mapItemRow(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kubadilisha stock' });
  }
});

app.delete('/api/inventory/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM inventory WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kufuta bidhaa' });
  }
});

// ---------- Sales routes ----------
app.get('/api/sales', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM sales ORDER BY sale_date DESC');
    res.json(rows.map(mapSaleRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kupata mauzo' });
  }
});

// Create a sale: decrements stock and records the sale in one transaction
app.post('/api/sales', async (req, res) => {
  const client = await pool.connect();
  try {
    const { itemId, qty, debtorName, debtorPhone, paidCash } = req.body;
    if (!itemId || !qty || qty <= 0) {
      return res.status(400).json({ error: 'Chagua bidhaa na idadi sahihi' });
    }
    await client.query('BEGIN');

    const itemRes = await client.query('SELECT * FROM inventory WHERE id = $1 FOR UPDATE', [itemId]);
    if (itemRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bidhaa haipo' });
    }
    const item = itemRes.rows[0];
    if (qty > item.qty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Stock haitoshi' });
    }

    const total = Number(item.price) * qty;
    const paidAmount = paidCash ? total : 0;

    await client.query('UPDATE inventory SET qty = qty - $1 WHERE id = $2', [qty, itemId]);

    const saleRes = await client.query(
      `INSERT INTO sales (item_id, item_name, qty, total, paid_amount, debtor_name, debtor_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [itemId, item.name, qty, total, paidAmount, debtorName || null, debtorPhone || null]
    );

    await client.query('COMMIT');
    res.status(201).json(mapSaleRow(saleRes.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kurekodi mauzo' });
  } finally {
    client.release();
  }
});

// Mark a single sale fully paid
app.patch('/api/sales/:id/mark-paid', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE sales SET paid_amount = total WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Mauzo hayapo' });
    res.json(mapSaleRow(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kusasisha malipo' });
  }
});

// Apply a partial/full payment across a debtor's oldest unpaid sales first
app.post('/api/debts/pay', async (req, res) => {
  const client = await pool.connect();
  try {
    const { debtorName, amount } = req.body;
    if (!debtorName || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Andika jina na kiasi sahihi' });
    }
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM sales WHERE lower(debtor_name) = lower($1) AND paid_amount < total
       ORDER BY sale_date ASC FOR UPDATE`,
      [debtorName]
    );
    let remainingPayment = Number(amount);
    for (const sale of rows) {
      if (remainingPayment <= 0) break;
      const owed = Number(sale.total) - Number(sale.paid_amount);
      const applied = Math.min(owed, remainingPayment);
      await client.query('UPDATE sales SET paid_amount = paid_amount + $1 WHERE id = $2', [applied, sale.id]);
      remainingPayment -= applied;
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kurekodi malipo' });
  } finally {
    client.release();
  }
});

// Mark all of a debtor's sales as fully paid
app.post('/api/debts/pay-all', async (req, res) => {
  try {
    const { debtorName } = req.body;
    if (!debtorName) return res.status(400).json({ error: 'Jina la mteja linahitajika' });
    await pool.query(
      'UPDATE sales SET paid_amount = total WHERE lower(debtor_name) = lower($1)',
      [debtorName]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kukamilisha malipo' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Zadona running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize schema:', err);
    process.exit(1);
  });
